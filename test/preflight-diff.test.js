'use strict';

const assert = require('assert');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { preflightPdf } = require('../lib/preflight');
const { diffPreflightReports, collectInstances } = require('../lib/preflight-diff');

// ---------- 1. 纯函数：用手工报告验证对齐规则 ----------

function makeReport(pageCount, pageIssues, documentMessages = []) {
  // pageIssues: Array<[page, code, detail]>，同页可有多条
  const byCode = new Map();
  const issuesOnPage = new Map();
  for (const [page, code, detail] of pageIssues) {
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ page, detail });
    if (!issuesOnPage.has(page)) issuesOnPage.set(page, []);
    issuesOnPage.get(page).push(code);
  }
  const issues = [...byCode.entries()].map(([code, detected]) => {
    const pages = detected.map((d) => d.page).sort((a, b) => a - b);
    return {
      code,
      severity: code === 'rotated_180' ? 'error' : 'warning',
      title: code,
      pageFrom: pages[0],
      pageTo: pages[pages.length - 1],
      pageCount: pages.length,
      pages,
      message: `seg ${code}`,
      detected,
      advice: '',
    };
  });
  for (const message of documentMessages) {
    issues.push({
      code: 'blank_padding',
      severity: 'info',
      title: '补白',
      pageFrom: null,
      pageTo: null,
      pageCount: null,
      pages: [],
      message,
      detected: [],
      advice: '',
    });
  }
  return {
    schemaVersion: 1,
    pageCount,
    summary: { issuesTotal: issues.length, passed: !issues.some((i) => i.severity === 'error') },
    file: { name: null, sizeBytes: null },
    issues,
    pages: Array.from({ length: pageCount }, (_unused, i) => ({
      page: i + 1,
      mediaWidth: 595.3,
      mediaHeight: 841.9,
      widthMm: 210,
      heightMm: 297,
      rotation: 0,
      transparent: false,
      textExtractable: true,
    })),
  };
}

// 1.1 同一代码部分页码解决、部分残留、部分新增 -> 同时进入多个分组
{
  const baseline = makeReport(6, [
    [1, 'transparency', '来源 A'],
    [2, 'transparency', '来源 A'],
    [3, 'transparency', '来源 A'],
  ]);
  const delivery = makeReport(6, [
    [2, 'transparency', '来源 A'],
    [3, 'transparency', '来源 B（检测值变化）'],
    [4, 'transparency', '来源 C'],
  ]);
  const diff = diffPreflightReports(baseline, delivery);

  const resolved = diff.resolved.find((e) => e.code === 'transparency');
  assert.deepStrictEqual(resolved.pages, [1]);
  const added = diff.added.find((e) => e.code === 'transparency');
  assert.deepStrictEqual(added.pages, [4]);
  const persistent = diff.persistent.find((e) => e.code === 'transparency');
  assert.deepStrictEqual(persistent.pages, [2, 3]);
  assert.deepStrictEqual(persistent.detailChangedPages, [3]);
  assert.strictEqual(persistent.documentLevel, false);

  // 页级对齐标记
  const byPage = Object.fromEntries(diff.pages.map((p) => [p.page, p.issues]));
  assert.deepStrictEqual(byPage[1].resolved, ['transparency']);
  assert.deepStrictEqual(byPage[2].persistent, ['transparency']);
  assert.deepStrictEqual(byPage[3].persistent, ['transparency']);
  assert.deepStrictEqual(byPage[4].added, ['transparency']);

  // 汇总按实例（页）计数
  assert.strictEqual(diff.summary.resolved.total, 1);
  assert.strictEqual(diff.summary.added.total, 1);
  assert.strictEqual(diff.summary.persistent.total, 2);
}

// 1.2 文档级问题仅按代码对齐：出现 / 消失 / 文案变化
{
  const baseline = makeReport(5, [], ['共 5 页，补 3 个空白页']);
  const delivery = makeReport(7, [], ['共 7 页，补 1 个空白页']);
  const diff = diffPreflightReports(baseline, delivery);
  assert.strictEqual(diff.added.length, 0);
  assert.strictEqual(diff.resolved.length, 0);
  const padding = diff.persistent.find((e) => e.code === 'blank_padding');
  assert.ok(padding, '页数都不是 4 的倍数 -> 文档级问题仍存在');
  assert.strictEqual(padding.documentLevel, true);
  assert.strictEqual(padding.detailChanged, true);
  assert.match(padding.baselineDetail, /补 3/);
  assert.match(padding.deliveryDetail, /补 1/);
}
{
  // 5 页（需补白）-> 4 页（不需补白）：文档级问题已解决
  const diff = diffPreflightReports(
    makeReport(5, [], ['共 5 页，补 3 个空白页']),
    makeReport(4, [], []),
  );
  assert.ok(diff.resolved.some((e) => e.code === 'blank_padding' && e.documentLevel));
  assert.strictEqual(diff.persistent.length, 0);
}
{
  // 3 页（补白）-> 7 页（补白，页数变了但实例仍在）：仍存在
  const diff = diffPreflightReports(
    makeReport(3, [], ['共 3 页，补 1 个空白页']),
    makeReport(7, [], ['共 7 页，补 1 个空白页']),
  );
  const padding = diff.persistent.find((e) => e.code === 'blank_padding');
  assert.ok(padding);
  assert.strictEqual(padding.detailChanged, true);
}

// 1.3 页数变化：尾部新增/移除页
{
  const diff = diffPreflightReports(makeReport(4, []), makeReport(7, []));
  assert.strictEqual(diff.pageCount.baseline, 4);
  assert.strictEqual(diff.pageCount.delivery, 7);
  assert.strictEqual(diff.pageCount.delta, 3);
  assert.deepStrictEqual(diff.pageCount.addedPages, [5, 6, 7]);
  assert.deepStrictEqual(diff.pageCount.removedPages, []);
  assert.strictEqual(diff.pages[4].status, 'added');
  assert.strictEqual(diff.pages[4].baseline, null);
  assert.strictEqual(diff.pages[4].delivery.mediaHeight, 841.9);
}
{
  const diff = diffPreflightReports(makeReport(6, []), makeReport(4, []));
  assert.strictEqual(diff.pageCount.delta, -2);
  assert.deepStrictEqual(diff.pageCount.removedPages, [5, 6]);
  assert.strictEqual(diff.pages[5].status, 'removed');
  assert.strictEqual(diff.pages[5].delivery, null);
}

// 1.4 collectInstances 能区分逐页与文档级问题
{
  const report = makeReport(5, [[2, 'rotated_180', '180°']], ['补白提示']);
  const { pageMap, documentMap } = collectInstances(report);
  assert.ok(pageMap.has('rotated_180@2'));
  assert.ok(documentMap.has('blank_padding'));
  assert.strictEqual(pageMap.size, 1);
  assert.strictEqual(documentMap.size, 1);
}

// 1.5 完全相同的两份报告：无新增/已解决，全部为仍存在
{
  const report = makeReport(4, [[1, 'transparency', '来源 A']]);
  const diff = diffPreflightReports(report, JSON.parse(JSON.stringify(report)));
  assert.strictEqual(diff.added.length, 0);
  assert.strictEqual(diff.resolved.length, 0);
  assert.strictEqual(diff.persistent.length, 1);
  assert.deepStrictEqual(diff.persistent[0].detailChangedPages, []);
  assert.strictEqual(diff.pageCount.delta, 0);
}

// 1.6 结构不完整的报告抛出明确错误
assert.throws(() => diffPreflightReports(null, makeReport(1, [])), /缺少/);
assert.throws(
  () => diffPreflightReports({ pageCount: 1 }, makeReport(1, [])),
  /结构不完整/,
);

console.log('✅ 差异对比纯函数测试通过：按页码+代码对齐 / 文档级对齐 / 页数变化 / 检测值变化');

// ---------- 2. 端到端：对真实 preflightPdf 报告做对比 ----------
(async () => {
  const A4W = 595.28;
  const A4H = 841.89;

  // 基准 5 页：第 4 页 180° 旋转（错误），第 5 页小尺寸无文字（警告+提示），非 4 倍数
  const baselineDoc = await PDFDocument.create();
  const bFont = await baselineDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    const p = baselineDoc.addPage([A4W, A4H]);
    p.drawText(`BASE ${i}`, { x: 80, y: 400, size: 24, font: bFont });
  }
  baselineDoc.addPage([300, 400]).drawRectangle({
    x: 20, y: 20, width: 260, height: 360, color: rgb(0.9, 0.9, 0.9),
  });
  const baselineBytes = await baselineDoc.save();
  const baselineReport = await preflightPdf(baselineBytes, { fileName: 'base.pdf' });
  assert.ok(baselineReport.issues.some((i) => i.code === 'size_mismatch'));
  assert.ok(baselineReport.issues.some((i) => i.code === 'no_extractable_text'));

  // 待交付 8 页：把小尺寸页改为正常 A4 文字页（问题解决），
  // 第 6 页新增 180° 旋转（新增错误），页数为 4 的倍数（补白提示消失）
  const deliveryDoc = await PDFDocument.create();
  const dFont = await deliveryDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i += 1) {
    const p = deliveryDoc.addPage([A4W, A4H]);
    p.drawText(`FINAL ${i}`, { x: 80, y: 400, size: 24, font: dFont });
  }
  const p6 = deliveryDoc.addPage([A4W, A4H]);
  p6.setRotation(degrees(180));
  p6.drawText('FINAL 6', { x: 80, y: 400, size: 24, font: dFont });
  for (let i = 7; i <= 8; i += 1) {
    const p = deliveryDoc.addPage([A4W, A4H]);
    p.drawText(`FINAL ${i}`, { x: 80, y: 400, size: 24, font: dFont });
  }
  const deliveryBytes = await deliveryDoc.save();
  const deliveryReport = await preflightPdf(deliveryBytes, { fileName: 'final.pdf' });

  const diff = diffPreflightReports(baselineReport, deliveryReport);

  // 页数 5 -> 8，新增页 6/7/8
  assert.strictEqual(diff.pageCount.baseline, 5);
  assert.strictEqual(diff.pageCount.delivery, 8);
  assert.deepStrictEqual(diff.pageCount.addedPages, [6, 7, 8]);

  // 第 5 页的尺寸不一致与无文字已解决；补白文档级问题已解决
  assert.ok(diff.resolved.some((e) => e.code === 'size_mismatch'
    && JSON.stringify(e.pages) === JSON.stringify([5])));
  assert.ok(diff.resolved.some((e) => e.code === 'no_extractable_text'));
  assert.ok(diff.resolved.some((e) => e.code === 'blank_padding' && e.documentLevel));

  // 第 6 页 180° 旋转为新增（错误级），第 6 页本身也是新增页
  const rot180 = diff.added.find((e) => e.code === 'rotated_180');
  assert.ok(rot180, '待交付第 6 页 180° 应作为新增问题');
  assert.deepStrictEqual(rot180.pages, [6]);
  assert.strictEqual(rot180.severity, 'error');
  assert.strictEqual(diff.summary.added.error >= 1, true);

  // 页级明细：第 6 页状态为 added 且带新增错误；第 5 页保留且问题已解决
  const p6Row = diff.pages[5];
  assert.strictEqual(p6Row.status, 'added');
  assert.ok(p6Row.issues.added.includes('rotated_180'));
  const p5Row = diff.pages[4];
  assert.strictEqual(p5Row.status, 'retained');
  assert.ok(p5Row.issues.resolved.includes('size_mismatch'));
  assert.ok(p5Row.changes.sizeChanged);

  // 元信息透传
  assert.strictEqual(diff.kind, 'preflight-diff');
  assert.strictEqual(diff.baseline.file.name, 'base.pdf');
  assert.strictEqual(diff.delivery.file.name, 'final.pdf');

  // JSON 可序列化（供下载）
  const reparsed = JSON.parse(JSON.stringify(diff));
  assert.strictEqual(reparsed.schemaVersion, 1);
  assert.strictEqual(reparsed.pages.length, 8);

  console.log('✅ 端到端真实报告对比通过：尺寸/无文字解决、补白文档级解决、新增 180° 错误、页数 5→8');

  // ---------- 3. 同一份干净 PDF 自比：三个分组均为空 ----------
  const cleanDoc = await PDFDocument.create();
  const cFont = await cleanDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i += 1) {
    cleanDoc.addPage([A4W, A4H]).drawText(`OK ${i}`, {
      x: 80, y: 400, size: 24, font: cFont,
    });
  }
  const cleanBytes = await cleanDoc.save();
  const cleanReport = await preflightPdf(cleanBytes);
  const same = diffPreflightReports(cleanReport, cleanReport);
  assert.strictEqual(same.added.length, 0);
  assert.strictEqual(same.resolved.length, 0);
  assert.strictEqual(same.persistent.length, 0);
  assert.strictEqual(same.summary.added.total, 0);
  assert.strictEqual(same.pageCount.delta, 0);
  for (const row of same.pages) {
    assert.strictEqual(row.status, 'retained');
    assert.strictEqual(row.changes.sizeChanged, false);
  }
  console.log('✅ 同份干净 PDF 自比：无任何差异');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
