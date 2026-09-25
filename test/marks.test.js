'use strict';

// 印张定位标记测试：8mm 空白边距、四角裁切线与中央折线定位线（仅位于版心之外）、
// 方案记录实际输出印张宽高、报价按该宽高判断容纳与利用率；
// 未启用时输出尺寸、页序与报价结果保持原样。
const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const {
  MARK_MARGIN_MM,
  MARK_MARGIN_PT,
  computeSheetSize,
} = require('../lib/sheet-marks');
const { imposePdf } = require('../lib/impose');
const { buildPaperQuote } = require('../lib/quote');

const PT_PER_MM = 72 / 25.4;

// ---------- 1. 印张尺寸计算 ----------
const PANEL = { width: 595.28, height: 841.89, orientation: 'portrait' };

const plainSize = computeSheetSize(PANEL, false);
assert.strictEqual(plainSize.width, PANEL.width * 2);
assert.strictEqual(plainSize.height, PANEL.height);
assert.strictEqual(plainSize.marginPt, 0);

assert.strictEqual(MARK_MARGIN_MM, 8);
assert.ok(Math.abs(MARK_MARGIN_PT - 8 * PT_PER_MM) < 1e-9, `8mm 应为 ${8 * PT_PER_MM} pt`);
const markedSize = computeSheetSize(PANEL, true);
assert.ok(Math.abs(markedSize.width - (PANEL.width * 2 + 2 * MARK_MARGIN_PT)) < 1e-9);
assert.ok(Math.abs(markedSize.height - (PANEL.height + 2 * MARK_MARGIN_PT)) < 1e-9);
assert.ok(Math.abs(markedSize.marginPt - MARK_MARGIN_PT) < 1e-9);

console.log('✅ 印张尺寸计算通过：未启用保持 2×面板宽×面板高，启用后四周各加 8mm');

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

// 解析内容流中的全部 cm 矩阵 [a b c d e f]
function parseCmOperators(content) {
  const ops = [];
  const re = /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+cm/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ops.push(m.slice(1, 7).map(Number));
  }
  return ops;
}

// 解析内容流中「moveTo + lineTo + stroke」形式的独立线段
function parseStrokeLines(content) {
  const lines = [];
  const tokens = content.split('\n');
  for (let i = 0; i < tokens.length - 2; i += 1) {
    const mv = tokens[i].match(/^(-?[\d.eE+-]+) (-?[\d.eE+-]+) m$/);
    const ln = tokens[i + 1].match(/^(-?[\d.eE+-]+) (-?[\d.eE+-]+) l$/);
    if (mv && ln && tokens[i + 2] === 'S') {
      lines.push({
        x1: Number(mv[1]), y1: Number(mv[2]),
        x2: Number(ln[1]), y2: Number(ln[2]),
      });
    }
  }
  return lines;
}

// 线段（水平或垂直）是否完全位于版心之外（允许端点落在版心边界上）
function lineOutsideInner(line, inner) {
  const eps = 1e-6;
  const minX = Math.min(line.x1, line.x2);
  const maxX = Math.max(line.x1, line.x2);
  const minY = Math.min(line.y1, line.y2);
  const maxY = Math.max(line.y1, line.y2);
  return maxX <= inner.left + eps || minX >= inner.right - eps
    || maxY <= inner.bottom + eps || minY >= inner.top - eps;
}

(async () => {
  // ---------- 2. 端到端：8 页 PDF，启用/未启用定位标记 ----------
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28; // A4 竖版 (pt)
  const PAGE_H = 841.89;
  for (let i = 1; i <= 8; i += 1) {
    const p = src.addPage([PAGE_W, PAGE_H]);
    p.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();
  const m = MARK_MARGIN_PT;

  // 2.1 未启用：输出尺寸、方案记录与页序保持原样
  const plainRes = await imposePdf(srcBytes);
  const plainOut = await PDFDocument.load(plainRes.pdfBytes);
  assert.strictEqual(plainOut.getPageCount(), 4);
  assert.ok(Math.abs(plainOut.getPage(0).getWidth() - PAGE_W * 2) < 0.01);
  assert.ok(Math.abs(plainOut.getPage(0).getHeight() - PAGE_H) < 0.01);
  assert.ok(Math.abs(plainRes.plan.sheet.width - PAGE_W * 2) < 0.01);
  assert.ok(Math.abs(plainRes.plan.sheet.height - PAGE_H) < 0.01);
  assert.strictEqual(plainRes.plan.marks.enabled, false);
  assert.strictEqual(plainRes.plan.marks.marginMm, 0);
  // 未启用时不绘制任何标记线
  assert.strictEqual(parseStrokeLines(decodePageContent(plainOut, 0)).length, 0);

  // 2.2 启用：输出页四周各加 8mm，页序不变
  const markedRes = await imposePdf(srcBytes, { registrationMarks: true });
  const markedOut = await PDFDocument.load(markedRes.pdfBytes);
  assert.strictEqual(markedOut.getPageCount(), plainOut.getPageCount());
  for (let i = 0; i < markedOut.getPageCount(); i += 1) {
    assert.ok(Math.abs(markedOut.getPage(i).getWidth() - (PAGE_W * 2 + 2 * m)) < 0.01,
      `第 ${i + 1} 页宽`);
    assert.ok(Math.abs(markedOut.getPage(i).getHeight() - (PAGE_H + 2 * m)) < 0.01,
      `第 ${i + 1} 页高`);
  }
  assert.ok(Math.abs(markedRes.plan.sheet.width - (PAGE_W * 2 + 2 * m)) < 0.01);
  assert.ok(Math.abs(markedRes.plan.sheet.height - (PAGE_H + 2 * m)) < 0.01);
  assert.strictEqual(markedRes.plan.marks.enabled, true);
  assert.strictEqual(markedRes.plan.marks.marginMm, 8);
  // 页序与补白完全一致
  assert.deepStrictEqual(
    markedRes.plan.sheets.map((s) => [s.front, s.back]),
    plainRes.plan.sheets.map((s) => [s.front, s.back]),
  );

  // 2.3 正背两面各绘制 10 条标记线（4 角 × 2 + 中央折线上下端），且全部在版心之外
  const inner = { left: m, right: m + PAGE_W * 2, bottom: m, top: m + PAGE_H };
  const sheetW = PAGE_W * 2 + 2 * m;
  const sheetH = PAGE_H + 2 * m;
  for (const pageIndex of [0, 1]) {
    const lines = parseStrokeLines(decodePageContent(markedOut, pageIndex));
    assert.strictEqual(lines.length, 10, `输出第 ${pageIndex + 1} 页应有 10 条标记线`);
    for (const line of lines) {
      assert.ok(lineOutsideInner(line, inner),
        `标记线不得进入版心：${JSON.stringify(line)}`);
    }
    // 左下角裁切线：水平 (0,m)->(m,m)，垂直 (m,0)->(m,m)
    assert.ok(lines.some((l) => Math.abs(l.x1) < 1e-6 && Math.abs(l.y1 - m) < 1e-6
      && Math.abs(l.x2 - m) < 1e-6 && Math.abs(l.y2 - m) < 1e-6), '左下角水平裁切线');
    assert.ok(lines.some((l) => Math.abs(l.x1 - m) < 1e-6 && Math.abs(l.y1) < 1e-6
      && Math.abs(l.x2 - m) < 1e-6 && Math.abs(l.y2 - m) < 1e-6), '左下角垂直裁切线');
    // 右上角裁切线：水平 (版心右缘,版心上缘)->(纸右缘,版心上缘)
    assert.ok(lines.some((l) => Math.abs(l.x1 - inner.right) < 1e-6 && Math.abs(l.y1 - inner.top) < 1e-6
      && Math.abs(l.x2 - sheetW) < 1e-6 && Math.abs(l.y2 - inner.top) < 1e-6), '右上角水平裁切线');
    // 中央折线定位线：下端 (centerX,0)->(centerX,m)，上端 (centerX,版心上缘)->(centerX,纸上缘)
    const centerX = m + PAGE_W;
    assert.ok(lines.some((l) => Math.abs(l.x1 - centerX) < 1e-6 && Math.abs(l.y1) < 1e-6
      && Math.abs(l.x2 - centerX) < 1e-6 && Math.abs(l.y2 - m) < 1e-6), '中央折线下端定位线');
    assert.ok(lines.some((l) => Math.abs(l.x1 - centerX) < 1e-6 && Math.abs(l.y1 - inner.top) < 1e-6
      && Math.abs(l.x2 - centerX) < 1e-6 && Math.abs(l.y2 - sheetH) < 1e-6), '中央折线上端定位线');
  }

  // 2.4 源页仍按原尺寸与页序放置，整体随版心偏移 8mm：
  // 第 1 张纸正面右半区为第 1 页（A4 恰好填满面板），平移锚点 = (m + 面板宽, m)
  const frontOps = parseCmOperators(decodePageContent(markedOut, 0));
  const pageOneOp = frontOps.find((op) => Math.abs(op[0] - 1) < 1e-6 && Math.abs(op[1]) < 1e-6
    && Math.abs(op[2]) < 1e-6 && Math.abs(op[3] - 1) < 1e-6
    && Math.abs(op[4] - (m + PAGE_W)) < 0.01 && Math.abs(op[5] - m) < 0.01);
  assert.ok(pageOneOp, `源页应整体偏移 8mm 放置于 (${m + PAGE_W}, ${m})`);

  console.log('✅ 端到端定位标记通过：8 页 -> 2 张纸，四周各加 8mm，');
  console.log('   正背面各 10 条标记线全部位于版心之外，页序与源页尺寸不变');

  // ---------- 3. 分册签帖模式同样适用 ----------
  const sigRes = await imposePdf(srcBytes, { registrationMarks: true, maxSheetsPerSignature: 1 });
  const sigOut = await PDFDocument.load(sigRes.pdfBytes);
  assert.strictEqual(sigRes.plan.signatureCount, 2); // 8 页、每帖 1 张（4 页）-> 2 帖
  assert.strictEqual(sigOut.getPageCount(), 4);
  for (let i = 0; i < sigOut.getPageCount(); i += 1) {
    assert.ok(Math.abs(sigOut.getPage(i).getWidth() - (PAGE_W * 2 + 2 * m)) < 0.01);
    assert.ok(Math.abs(sigOut.getPage(i).getHeight() - (PAGE_H + 2 * m)) < 0.01);
    assert.strictEqual(parseStrokeLines(decodePageContent(sigOut, i)).length, 10,
      `签帖输出第 ${i + 1} 页应绘制标记线`);
  }
  assert.strictEqual(sigRes.plan.marks.enabled, true);
  assert.ok(Math.abs(sigRes.plan.sheet.width - (PAGE_W * 2 + 2 * m)) < 0.01);

  console.log('✅ 分册签帖 + 定位标记通过：2 帖 2 张纸均带 8mm 空白与标记线');

  // ---------- 4. 报价按方案记录的实际印张宽高 ----------
  // 启用标记后的印张 = (2×210+16) × (297+16) = 436 × 313 mm
  const markedPlan = {
    sheets: [{ sheet: 1 }, { sheet: 2 }],
    sourceCount: 8, paddedCount: 0, totalCount: 8, blanks: 0,
    panel: { width: 595.2756, height: 841.8898, orientation: 'portrait' },
    sheet: {
      width: 595.2756 * 2 + 2 * MARK_MARGIN_PT,
      height: 841.8898 + 2 * MARK_MARGIN_PT,
    },
    marks: { enabled: true, marginMm: 8 },
  };
  const sheetMmW = 2 * 210 + 16;
  const sheetMmH = 297 + 16;

  // A3（420×297）两个方向都放不下 436×313 的印张
  const a3Quote = buildPaperQuote(markedPlan, [
    { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
  ]);
  assert.strictEqual(a3Quote.feasible, false);
  assert.strictEqual(a3Quote.selected, null);
  assert.ok(Math.abs(a3Quote.layout.sheet.widthMm - sheetMmW) < 0.01);
  assert.ok(Math.abs(a3Quote.layout.sheet.heightMm - sheetMmH) < 0.01);

  // 更大的纸张可容纳；利用率按实际印张面积（含 8mm 空白）计算
  const bigQuote = buildPaperQuote(markedPlan, [
    { name: '大度对开', widthMm: 889, heightMm: 597, pricePerSheet: 2, setupFee: 60 },
  ]);
  assert.strictEqual(bigQuote.feasible, true);
  const expectedUtil = (sheetMmW * sheetMmH) / (889 * 597);
  assert.ok(Math.abs(bigQuote.selected.utilization - expectedUtil) < 1e-3,
    `利用率应按 436×313 印张计算，实际 ${bigQuote.selected.utilization}`);

  // 旧方案（无 sheet 字段）保持原判定：A3 恰好容纳 420×297 印张
  const legacyPlan = {
    sheets: [{ sheet: 1 }, { sheet: 2 }],
    sourceCount: 8, paddedCount: 0, totalCount: 8, blanks: 0,
    panel: { width: 595.2756, height: 841.8898, orientation: 'portrait' },
  };
  const legacyQuote = buildPaperQuote(legacyPlan, [
    { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
  ]);
  assert.strictEqual(legacyQuote.feasible, true);
  assert.ok(Math.abs(legacyQuote.layout.sheet.widthMm - 420) < 0.01);
  assert.ok(Math.abs(legacyQuote.layout.sheet.heightMm - 297) < 0.01);
  assert.ok(Math.abs(legacyQuote.selected.utilization - 1) < 1e-4);

  // 未启用标记的新方案：sheet 记录原印张尺寸，报价结果与旧方案一致
  const plainQuote = buildPaperQuote(plainRes.plan, [
    { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
  ]);
  assert.strictEqual(plainQuote.feasible, true);
  assert.ok(Math.abs(plainQuote.layout.sheet.widthMm - legacyQuote.layout.sheet.widthMm) < 0.02);
  assert.ok(Math.abs(plainQuote.layout.sheet.heightMm - legacyQuote.layout.sheet.heightMm) < 0.02);
  assert.strictEqual(plainQuote.selected.totalCost, legacyQuote.selected.totalCost);

  console.log('✅ 报价按实际印张宽高通过：标记后 A3 放不下、大纸按新尺寸算利用率，');
  console.log('   未启用/旧方案结果保持原样');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
