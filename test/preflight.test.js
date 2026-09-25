'use strict';

const assert = require('assert');
const {
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
  degrees,
} = require('pdf-lib');
const {
  preflightPdf,
  tokenizeContent,
  applyPngPredictor,
  findReferenceSize,
  mergeSegments,
  formatPageList,
  skipLiteralString,
  ISSUE_META,
} = require('../lib/preflight');

// ---------- 1. 纯函数单测 ----------

// 1.1 页码列表折叠
assert.strictEqual(formatPageList([3]), '3');
assert.strictEqual(formatPageList([3, 4, 5, 7, 8]), '3～5、7～8');
assert.strictEqual(formatPageList([1, 3, 5]), '1、3、5');

// 1.2 内容流词法：文本操作符、资源名；字符串/注释中的伪操作符不计入
{
  const tokens = tokenizeContent([
    '% 这是注释 Tj gs Do 都不算',
    'BT',
    '/F1 12 Tf',
    '(Hello) Tj',
    '(字面 Tj 与 /Fake gs 写在字符串里) Tj',
    '[(A) -10 (B)] TJ',
    'ET',
    '/GS1 gs',
    '/Im0 Do',
  ].join('\n'));
  assert.strictEqual(tokens.textShowCount, 3); // Tj × 2 + TJ × 1
  assert.deepStrictEqual([...tokens.usedFonts], ['F1']);
  assert.deepStrictEqual([...tokens.gsNames], ['GS1']);
  assert.deepStrictEqual([...tokens.doNames], ['Im0']);
}
// BT/ET 之外的 Tj 不计为文本绘制
assert.strictEqual(tokenizeContent('(x) Tj BT (y) Tj ET').textShowCount, 1);
// 十六进制字符串内的伪操作符
assert.strictEqual(tokenizeContent('BT /F1 12 Tf <546a> Tj ET').textShowCount, 1);
// 嵌套与转义括号
assert.strictEqual(
  skipLiteralString('(a\\(b\\)c) rest', 0),
  '(a\\(b\\)c)'.length,
);

// 1.3 PNG predictor：filter 0（None）逐字节还原；filter 4（Paeth）按左邻重建
{
  const rowLen = 6;
  const noneRow = Buffer.concat([
    Buffer.from([0]),
    Buffer.from([10, 20, 30, 40, 50, 60]),
  ]);
  assert.deepStrictEqual([...applyPngPredictor(noneRow, 2, 3)], [10, 20, 30, 40, 50, 60]);

  // 首行无上文：第 1 像素 Paeth(0,0,0)=0；其后各像素 Paeth(left,0,0)=left
  const paethRow = Buffer.concat([
    Buffer.from([4]),
    Buffer.from([10, 20, 30, 40, 50, 60]),
  ]);
  assert.deepStrictEqual(
    [...applyPngPredictor(paethRow, 2, 3)],
    [10, 20, 30, 40 + 10, 50 + 20, 60 + 30],
  );
}

// 1.4 主尺寸聚类：容差内同簇，取成员最多者（按物理介质尺寸，旋转不另算）
{
  const ref = findReferenceSize([
    { page: 1, mediaWidth: 595, mediaHeight: 842 },
    { page: 2, mediaWidth: 595.3, mediaHeight: 842.2 }, // 容差内
    { page: 3, mediaWidth: 300, mediaHeight: 400 },
  ]);
  assert.strictEqual(ref.count, 2);
  assert.strictEqual(ref.width, 595);
  assert.strictEqual(ref.height, 842);
}

// 1.5 相邻同类问题合并为区段（按 code 分组，非相邻断开）
{
  const segments = mergeSegments({
    rotated_90_270: [
      { page: 2, detail: '90°' },
      { page: 3, detail: '90°' },
      { page: 5, detail: '270°' },
    ],
    transparency: [{ page: 1, detail: '页面透明图层组' }],
  });
  const rot = segments.find((s) => s.code === 'rotated_90_270');
  assert.strictEqual(rot.pageFrom, 2);
  assert.strictEqual(rot.pageTo, 3);
  assert.deepStrictEqual(rot.pages, [2, 3]);
  assert.strictEqual(rot.pageCount, 2);
  const tr = segments.find((s) => s.code === 'transparency');
  assert.strictEqual(tr.pageFrom, 1);
}

console.log('✅ 印前校验纯函数测试通过（页码区段 / 词法扫描 / predictor / 聚类 / 合并）');

// ---------- 2. 端到端：构造问题 PDF ----------
(async () => {
  const A4W = 595.28;
  const A4H = 841.89;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // 第 1 页：标准 A4 + 标准字体文字（干净页）
  const p1 = doc.addPage([A4W, A4H]);
  p1.drawText('PAGE 1 CLEAN', { x: 80, y: 400, size: 24, font });

  // 第 2、3 页：A4 且 /Rotate 90（相邻同类 -> 合并区段，警告）
  for (const label of ['PAGE 2', 'PAGE 3']) {
    const p = doc.addPage([A4W, A4H]);
    p.setRotation(degrees(90));
    p.drawText(label, { x: 80, y: 400, size: 24, font });
  }

  // 第 4 页：/Rotate 180（错误）
  const p4 = doc.addPage([A4W, A4H]);
  p4.setRotation(degrees(180));
  p4.drawText('PAGE 4', { x: 80, y: 400, size: 24, font });

  // 第 5 页：小尺寸（尺寸不一致，警告；只有矢量图形、无文字 -> info）
  const p5 = doc.addPage([300, 400]);
  p5.drawRectangle({ x: 20, y: 20, width: 260, height: 360, color: rgb(0.9, 0.9, 0.9) });

  // 第 6 页：A4 + 半透明文字（透明度，警告；仍有可提取文字）
  const p6 = doc.addPage([A4W, A4H]);
  p6.drawText('TRANSPARENT', { x: 80, y: 400, size: 24, font, opacity: 0.5 });

  // 第 7 页：A4 + 透明图层组
  const p7 = doc.addPage([A4W, A4H]);
  p7.drawText('GROUP', { x: 80, y: 400, size: 24, font });
  const group = doc.context.obj({});
  group.set(PDFName.of('Type'), PDFName.of('Group'));
  group.set(PDFName.of('S'), PDFName.of('Transparency'));
  p7.node.set(PDFName.of('Group'), group);

  const bytes = await doc.save();
  const report = await preflightPdf(bytes, { fileName: 'issues.pdf', sizeBytes: bytes.length });

  // 7 页 -> 补 1 页空白（文档级 info）
  assert.strictEqual(report.pageCount, 7);
  assert.strictEqual(report.referenceSize.pageCount, 6); // 6 页 A4
  assert.ok(Math.abs(report.referenceSize.width - A4W) < 0.5);
  assert.ok(Math.abs(report.referenceSize.height - A4H) < 0.5);

  // 存在错误（180°），passed=false，但报告正常返回（不抛异常）
  assert.strictEqual(report.summary.passed, false);
  assert.strictEqual(report.summary.error, 1);
  assert.ok(report.summary.warning >= 3); // 旋转90区段、尺寸、透明（至少 3 项）
  assert.ok(report.summary.info >= 1);
  assert.ok(report.summary.issuesTotal >= 5);

  const byCode = Object.fromEntries(report.issues.map((i) => [i.code, i]));

  // 2、3 页 90° 合并为一个区段
  const rot90 = byCode.rotated_90_270;
  assert.ok(rot90, '应存在 90° 旋转区段');
  assert.strictEqual(rot90.severity, ISSUE_META.rotated_90_270.severity);
  assert.strictEqual(rot90.pageFrom, 2);
  assert.strictEqual(rot90.pageTo, 3);
  assert.strictEqual(rot90.pageCount, 2);
  assert.deepStrictEqual(rot90.pages, [2, 3]);
  assert.match(rot90.message, /第 2～3 页/);
  assert.ok(rot90.advice.length > 0);
  assert.strictEqual(rot90.detected[0].detail, '90°');

  // 180° 单页错误
  const rot180 = byCode.rotated_180;
  assert.strictEqual(rot180.severity, 'error');
  assert.strictEqual(rot180.pageFrom, 4);
  assert.strictEqual(rot180.pageTo, 4);

  // 尺寸不一致：第 5 页
  const size = byCode.size_mismatch;
  assert.strictEqual(size.severity, 'warning');
  assert.strictEqual(size.pageFrom, 5);
  assert.strictEqual(size.pageTo, 5);
  assert.match(size.values[1].value, /300 × 400/);
  assert.match(size.message, /主尺寸/);

  // 透明度：第 6（/ca=0.5）与第 7（透明图层组）相邻同类 -> 合并为一个区段，
  // 区段内逐页保留各自检测值
  const transparencyIssues = report.issues.filter((i) => i.code === 'transparency');
  assert.strictEqual(transparencyIssues.length, 1);
  const transparency = transparencyIssues[0];
  assert.strictEqual(transparency.pageFrom, 6);
  assert.strictEqual(transparency.pageTo, 7);
  assert.deepStrictEqual(transparency.pages, [6, 7]);
  assert.strictEqual(transparency.pageCount, 2);
  assert.match(transparency.message, /第 6～7 页/);
  assert.match(transparency.values[0].value, /填充透明度 0\.5|透明度 0\.5/);
  assert.match(transparency.values[0].value, /页面透明图层组/);
  assert.match(transparency.values[0].value, /第 6 页/);
  assert.match(transparency.values[0].value, /第 7 页/);

  // 无文字页：第 5 页（info）
  const noText = byCode.no_extractable_text;
  assert.strictEqual(noText.severity, 'info');
  assert.strictEqual(noText.pageFrom, 5);

  // 文档级补白提示
  const padding = byCode.blank_padding;
  assert.ok(padding, '7 页应提示补 1 空白页');
  assert.strictEqual(padding.severity, 'info');
  assert.strictEqual(padding.pageFrom, null);
  assert.match(padding.message, /补 1 个空白页/);

  // 干净页无任何问题；问题页的逐页记录带 codes
  assert.deepStrictEqual(report.pages[0].issues, []);
  assert.strictEqual(report.pages[0].textExtractable, true);
  assert.strictEqual(report.pages[0].transparent, false);
  assert.strictEqual(report.pages[0].rotation, 0);
  assert.strictEqual(report.pages[4].textExtractable, false);
  assert.strictEqual(report.pages[5].transparent, true);
  const p4Record = report.pages[3];
  assert.strictEqual(p4Record.rotation, 180);
  assert.ok(p4Record.issues.some((i) => i.code === 'rotated_180'));
  // 有效尺寸：旋转 90 后宽高互换
  assert.ok(Math.abs(report.pages[1].effectiveWidth - A4H) < 0.5);
  assert.ok(Math.abs(report.pages[1].effectiveHeight - A4W) < 0.5);

  // 问题排序：error 在前，其后 warning，最后 info；同级按页码
  const severities = report.issues.map((i) => i.severity);
  const rank = { error: 0, warning: 1, info: 2 };
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(rank[severities[i - 1]] <= rank[severities[i]], '问题应按严重级别排序');
  }

  // JSON 可序列化并可直接下载
  const json = JSON.stringify(report);
  const reparsed = JSON.parse(json);
  assert.strictEqual(reparsed.schemaVersion, 1);
  assert.strictEqual(reparsed.file.name, 'issues.pdf');
  assert.strictEqual(reparsed.pages.length, 7);

  console.log('✅ 端到端问题 PDF 校验通过：尺寸/旋转(90合并、180)/透明度(两类来源)/无文字/补白/排序');

  // ---------- 3. 端到端：干净 4 页 PDF ----------
  const clean = await PDFDocument.create();
  const cfont = await clean.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    const p = clean.addPage([A4W, A4H]);
    p.drawText(`OK ${i}`, { x: 80, y: 400, size: 24, font: cfont });
  }
  const cleanReport = await preflightPdf(await clean.save());
  assert.strictEqual(cleanReport.summary.passed, true);
  assert.strictEqual(cleanReport.summary.issuesTotal, 0);
  assert.strictEqual(cleanReport.issues.length, 0);
  assert.strictEqual(cleanReport.summary.pagesWithIssues, 0);
  for (const page of cleanReport.pages) {
    assert.strictEqual(page.textExtractable, true);
    assert.strictEqual(page.transparent, false);
    assert.strictEqual(page.rotation, 0);
    assert.deepStrictEqual(page.issues, []);
  }
  console.log('✅ 干净 PDF 校验通过：无任何问题，passed=true');

  // ---------- 4. 异常输入 ----------
  await assert.rejects(
    () => preflightPdf(Buffer.from('not a pdf at all')),
    /不是有效的 PDF/,
  );
  console.log('✅ 非 PDF / 损坏文件以明确错误信息拒绝');

  // ---------- 5. 校验不阻断拼版：同一问题 PDF 仍可拼版 ----------
  const { imposePdf } = require('../lib/impose');
  const { pdfBytes, plan } = await imposePdf(bytes);
  const imposed = await PDFDocument.load(pdfBytes);
  // 7 页 -> 补 1 白 -> 8 面板 -> 2 张纸 -> 4 个输出页
  assert.strictEqual(imposed.getPageCount(), 4);
  assert.strictEqual(plan.paddedCount, 1);
  console.log('✅ 校验报告含错误时拼版仍正常完成：7 页 -> 2 张纸（4 面），互不阻断');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
