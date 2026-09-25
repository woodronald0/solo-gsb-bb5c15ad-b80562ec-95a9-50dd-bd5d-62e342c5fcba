'use strict';

// 缺页补印测试：页码表达式解析（空输入/格式错误/越界）、拼版方案中的印张定位
// （同一印张命中多页只补印一次、分册模式累计输出页偏移）、端到端补印 PDF
// （按原印张顺序成对抽取正背面、保留原印张尺寸与定位标记）。
const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const {
  ReprintInputError,
  parseReprintPagesSpec,
  parseReprintPages,
  buildReprintPlan,
  reprintPdf,
} = require('../lib/reprint');
const { buildImpositionPlan, buildSignaturePlan, imposePdf } = require('../lib/impose');
const { MARK_MARGIN_PT } = require('../lib/sheet-marks');

// ---------- 1. 页码表达式解析 ----------
assert.deepStrictEqual(parseReprintPages('2,5-7', 20), [2, 5, 6, 7]);
assert.deepStrictEqual(parseReprintPages(' 2 , 5 - 7 ', 20), [2, 5, 6, 7], '允许空白字符');
assert.deepStrictEqual(parseReprintPages('2，5～7', 20), [2, 5, 6, 7], '全角逗号/区间号按半角处理');
assert.deepStrictEqual(parseReprintPages('7,2,5-6,2', 20), [2, 5, 6, 7], '去重并升序');
assert.deepStrictEqual(parseReprintPages('3', 20), [3]);
assert.deepStrictEqual(parseReprintPages('3-3', 20), [3], '起点=终点的区间视为单页');
assert.deepStrictEqual(parseReprintPages('1,20', 20), [1, 20], '边界页码合法');
assert.deepStrictEqual(parseReprintPagesSpec('1-1000000'), [...Array(1000000).keys()].map((i) => i + 1));

// 空输入：缺失、空串、纯空白
for (const empty of ['', '   ', null, undefined]) {
  assert.throws(
    () => parseReprintPages(empty, 20),
    (err) => err instanceof ReprintInputError && /请输入需要补印的原稿页码/.test(err.message),
    `空输入 ${JSON.stringify(empty)} 应报「请输入」`,
  );
}

// 格式错误：非数字片段、悬空逗号/区间号、小数等
for (const bad of ['abc', '2,', ',2', '2,,3', '2..3', '2-', '-3', '2.5', '1,x', '第2页', '2;3']) {
  assert.throws(
    () => parseReprintPages(bad, 20),
    (err) => err instanceof ReprintInputError && /格式错误/.test(err.message),
    `格式错误 ${JSON.stringify(bad)} 应被拒绝`,
  );
}
assert.throws(() => parseReprintPages('7-5', 20), /起点不能大于终点/);

// 越界页码：0、超过总页数、区间越界（20 页文档）
for (const bad of ['0', '21', '0-3', '18-25', '2,99']) {
  assert.throws(
    () => parseReprintPages(bad, 20),
    (err) => err instanceof ReprintInputError && /超出原稿页码范围（1～20）/.test(err.message),
    `越界 ${JSON.stringify(bad)} 应报「超出原稿页码范围」`,
  );
}

console.log('✅ 补印页码解析通过：空输入/格式错误/越界均有明确错误，合法表达式去重升序');

// ---------- 2. 拼版方案中的印张定位 ----------
// 2.1 整册 8 页：第1张 F[8|1] B[2|7]，第2张 F[6|3] B[4|5]
const plan8 = buildImpositionPlan(8);

const hitOne = buildReprintPlan(plan8, [2]);
assert.strictEqual(hitOne.length, 1);
assert.strictEqual(hitOne[0].signature, null);
assert.strictEqual(hitOne[0].sheet, 1);
assert.deepStrictEqual(hitOne[0].hitPages, [2]);
assert.deepStrictEqual(hitOne[0].outputPages, [1, 2]);

// 同一印张命中多页（第 1、8 页同在第 1 张正面）只补印一次
const hitSameSheet = buildReprintPlan(plan8, [1, 8]);
assert.strictEqual(hitSameSheet.length, 1, '同一印张命中多页只记录一次');
assert.deepStrictEqual(hitSameSheet[0].hitPages, [1, 8]);
assert.deepStrictEqual(hitSameSheet[0].outputPages, [1, 2]);

// 第 2 张命中 3 页（3、4、5 同在第 2 张）
const hitSheet2 = buildReprintPlan(plan8, [3, 4, 5]);
assert.strictEqual(hitSheet2.length, 1);
assert.strictEqual(hitSheet2[0].sheet, 2);
assert.deepStrictEqual(hitSheet2[0].hitPages, [3, 4, 5]);
assert.deepStrictEqual(hitSheet2[0].outputPages, [3, 4]);

// 跨印张：按原印张顺序排列
const hitTwo = buildReprintPlan(plan8, [4, 1]);
assert.strictEqual(hitTwo.length, 2);
assert.deepStrictEqual(hitTwo.map((h) => h.sheet), [1, 2], '按原印张顺序');
assert.deepStrictEqual(hitTwo[0].hitPages, [1]);
assert.deepStrictEqual(hitTwo[1].hitPages, [4]);

// 全部页命中 = 全部印张
assert.strictEqual(buildReprintPlan(plan8, [1, 2, 3, 4, 5, 6, 7, 8]).length, 2);

// 2.2 分册签帖：13 页、每帖 2 张 -> 第1帖 2 张（输出页 1-4），第2帖 2 张（输出页 5-8）
const sigPlan = buildSignaturePlan(13, 2);
const sigHit = buildReprintPlan(sigPlan, [1, 9, 12, 13]);
assert.strictEqual(sigHit.length, 3);
// 第 1 页 -> 第 1 帖帖内第 1 张（输出页 1-2）
assert.strictEqual(sigHit[0].signature, 1);
assert.strictEqual(sigHit[0].sheet, 1);
assert.strictEqual(sigHit[0].signatureSheetCount, 2);
assert.deepStrictEqual(sigHit[0].hitPages, [1]);
assert.deepStrictEqual(sigHit[0].outputPages, [1, 2]);
// 第 9 页 -> 第 2 帖帖内第 1 张：累计第 1 帖的 4 个输出页偏移后为输出页 5-6
assert.strictEqual(sigHit[1].signature, 2);
assert.strictEqual(sigHit[1].sheet, 1);
assert.deepStrictEqual(sigHit[1].hitPages, [9]);
assert.deepStrictEqual(sigHit[1].outputPages, [5, 6], '分册模式累计各帖输出页偏移');
// 第 12、13 页同在第 2 帖帖内第 2 张背面 -> 只补印一次，输出页 7-8
assert.strictEqual(sigHit[2].signature, 2);
assert.strictEqual(sigHit[2].sheet, 2);
assert.deepStrictEqual(sigHit[2].hitPages, [12, 13]);
assert.deepStrictEqual(sigHit[2].outputPages, [7, 8]);

console.log('✅ 印张定位通过：同一印张命中多页只补印一次，分册模式累计输出页偏移正确');

// ---------- 3. 端到端补印 PDF ----------
// 读取输出页的内容流文本（Contents 可能是单条流或流数组，均为 flate 编码）
function decodePageContent(doc, pageIndex) {
  const node = doc.getPage(pageIndex).node;
  const contents = node.get(PDFName.of('Contents'));
  const refs = typeof contents.asArray === 'function' ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return zlib.inflateSync(Buffer.from(stream.getContents())).toString('latin1');
  }).join('\n');
}

(async () => {
  const PAGE_W = 595.28; // A4 竖版 (pt)
  const PAGE_H = 841.89;

  // 构造 10 页原稿
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 10; i += 1) {
    const page = src.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();

  // 3.1 整册补印：10 页 -> 3 张纸；受损 2,5-7 -> 第 1 张（页 2）+ 第 3 张（页 5、6、7）
  const { pdfBytes: fullBytes } = await imposePdf(srcBytes);
  const fullDoc = await PDFDocument.load(fullBytes);

  const { pdfBytes: reprintBytes, reprint } = await reprintPdf(srcBytes, {}, '2,5-7');
  assert.strictEqual(reprint.kind, 'reprint-plan');
  assert.deepStrictEqual(reprint.pages, [2, 5, 6, 7]);
  assert.strictEqual(reprint.sheetCount, 2, '同一印张命中多页只补印一次');
  assert.strictEqual(reprint.pageCount, 4);
  assert.strictEqual(reprint.signatureMode, false);
  assert.deepStrictEqual(reprint.sheets.map((s) => s.sheet), [1, 3]);
  assert.deepStrictEqual(reprint.sheets[0].hitPages, [2]);
  assert.deepStrictEqual(reprint.sheets[1].hitPages, [5, 6, 7]);
  assert.deepStrictEqual(reprint.sheets[1].outputPages, [5, 6]);

  const reprintDoc = await PDFDocument.load(reprintBytes);
  assert.strictEqual(reprintDoc.getPageCount(), 4, '补印 PDF = 2 张纸 × 正背 2 页');
  // 保留原印张尺寸（未启用定位标记：2 × 面板宽 × 面板高）
  assert.ok(Math.abs(reprintDoc.getPage(0).getWidth() - PAGE_W * 2) < 0.5);
  assert.ok(Math.abs(reprintDoc.getPage(0).getHeight() - PAGE_H) < 0.5);
  // 按原印张顺序成对抽取正背面：补印页与完整拼版输出页内容逐页一致
  const expectedOrder = [0, 1, 4, 5]; // 完整拼版输出中的 0 基页码（第 1、3 张的正背面）
  for (let i = 0; i < expectedOrder.length; i += 1) {
    assert.strictEqual(
      decodePageContent(reprintDoc, i),
      decodePageContent(fullDoc, expectedOrder[i]),
      `补印第 ${i + 1} 页应与完整拼版第 ${expectedOrder[i] + 1} 页一致`,
    );
  }
  console.log('✅ 端到端整册补印通过：10 页受损 2,5-7 -> 2 张纸（4 页），尺寸与内容逐页一致');

  // 3.2 启用定位标记：补印保留原印张尺寸与定位标记（与完整拼版输出页逐页一致）
  const { pdfBytes: markedFullBytes } = await imposePdf(srcBytes, { registrationMarks: true });
  const markedFullDoc = await PDFDocument.load(markedFullBytes);
  const { pdfBytes: markedReprintBytes, reprint: markedReprint } = await reprintPdf(
    srcBytes,
    { registrationMarks: true },
    '2,5-7',
  );
  const markedReprintDoc = await PDFDocument.load(markedReprintBytes);
  assert.strictEqual(markedReprint.sheetCount, 2);
  assert.strictEqual(markedReprintDoc.getPageCount(), 4);
  assert.ok(Math.abs(markedReprintDoc.getPage(0).getWidth() - (PAGE_W * 2 + 2 * MARK_MARGIN_PT)) < 0.5,
    '补印保留启用定位标记后的印张宽');
  assert.ok(Math.abs(markedReprintDoc.getPage(0).getHeight() - (PAGE_H + 2 * MARK_MARGIN_PT)) < 0.5,
    '补印保留启用定位标记后的印张高');
  for (let i = 0; i < expectedOrder.length; i += 1) {
    assert.strictEqual(
      decodePageContent(markedReprintDoc, i),
      decodePageContent(markedFullDoc, expectedOrder[i]),
      `启用标记时补印第 ${i + 1} 页应与完整拼版第 ${expectedOrder[i] + 1} 页一致（含定位标记）`,
    );
  }
  console.log('✅ 定位标记补印通过：补印印张含 8mm 空白边距，正背面内容与完整拼版逐页一致');

  // 3.3 分册签帖补印：13 页、每帖 2 张；受损 9,12 -> 第 2 帖的 2 张纸（输出页 5-8）
  const sigSrc = await PDFDocument.create();
  const sigFont = await sigSrc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 13; i += 1) {
    const page = sigSrc.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font: sigFont, color: rgb(0, 0, 0) });
  }
  const sigSrcBytes = await sigSrc.save();

  const sigOptions = { maxSheetsPerSignature: 2 };
  const { pdfBytes: sigFullBytes } = await imposePdf(sigSrcBytes, sigOptions);
  const sigFullDoc = await PDFDocument.load(sigFullBytes);

  const { pdfBytes: sigReprintBytes, reprint: sigReprint } = await reprintPdf(
    sigSrcBytes,
    sigOptions,
    '9,12',
  );
  assert.strictEqual(sigReprint.signatureMode, true);
  assert.strictEqual(sigReprint.sheetCount, 2);
  assert.strictEqual(sigReprint.pageCount, 4);
  assert.deepStrictEqual(
    sigReprint.sheets.map((s) => [s.signature, s.sheet]),
    [[2, 1], [2, 2]],
    '命中第 2 帖的帖内第 1、2 张',
  );
  assert.deepStrictEqual(sigReprint.sheets[0].outputPages, [5, 6]);
  assert.deepStrictEqual(sigReprint.sheets[1].outputPages, [7, 8]);

  const sigReprintDoc = await PDFDocument.load(sigReprintBytes);
  assert.strictEqual(sigReprintDoc.getPageCount(), 4);
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(
      decodePageContent(sigReprintDoc, i),
      decodePageContent(sigFullDoc, 4 + i),
      `分册补印第 ${i + 1} 页应与完整拼版第 ${5 + i} 页一致`,
    );
  }
  console.log('✅ 端到端分册补印通过：13 页(每帖 2 张)受损 9,12 -> 第 2 帖 2 张纸（输出页 5-8）');

  // 3.4 错误处理：损坏 PDF 422 语义；空输入/格式错误/越界为输入错误
  await assert.rejects(
    () => reprintPdf(Buffer.from('%PDF-broken'), {}, '2'),
    /不是有效的 PDF/,
  );
  await assert.rejects(
    () => reprintPdf(srcBytes, {}, ''),
    (err) => err instanceof ReprintInputError && /请输入需要补印的原稿页码/.test(err.message),
  );
  await assert.rejects(
    () => reprintPdf(srcBytes, {}, 'abc'),
    (err) => err instanceof ReprintInputError && /格式错误/.test(err.message),
  );
  await assert.rejects(
    () => reprintPdf(srcBytes, {}, '99'),
    (err) => err instanceof ReprintInputError && /超出原稿页码范围（1～10）/.test(err.message),
  );
  console.log('✅ 补印错误处理通过：损坏 PDF、空输入、格式错误、越界页码分别给出明确错误');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
