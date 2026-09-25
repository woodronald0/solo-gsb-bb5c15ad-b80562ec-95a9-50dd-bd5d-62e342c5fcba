'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, rgb, degrees, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const {
  buildImpositionPlan,
  buildSignaturePlan,
  parseMaxSheetsPerSignature,
  MAX_SHEETS_PER_SIGNATURE,
  blanksForCount,
  normalizeRotation,
  effectivePageSize,
  computePanelSize,
  slotPlacement,
  imposePdf,
} = require('../lib/impose');

// ---------- 1. 页序算法单测 ----------
function planToArray(plan) {
  return plan.sheets.flatMap((s) => [
    ['F', s.front.left.page, s.front.right.page],
    ['B', s.back.left.page, s.back.right.page],
  ]);
}

assert.strictEqual(blanksForCount(1), 3);
assert.strictEqual(blanksForCount(4), 0);
assert.strictEqual(blanksForCount(5), 3);
assert.strictEqual(blanksForCount(10), 2);
assert.strictEqual(blanksForCount(12), 0);

// 8 页：F[8|1] B[2|7], F[6|3] B[4|5]
const p8 = buildImpositionPlan(8);
assert.deepStrictEqual(p8.sheets[0].front.left, { page: 8, blank: false });
assert.deepStrictEqual(p8.sheets[0].front.right, { page: 1, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.left, { page: 2, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.right, { page: 7, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.left, { page: 6, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.right, { page: 3, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.left, { page: 4, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.right, { page: 5, blank: false });
assert.strictEqual(p8.paddedCount, 0);

// 5 页 -> 补 3 空白（位置 6,7,8 为空白）
const p5 = buildImpositionPlan(5);
assert.strictEqual(p5.paddedCount, 3);
assert.strictEqual(p5.sheets[0].front.left.blank, true);   // 8 = blank
assert.strictEqual(p5.sheets[0].front.right.page, 1);
assert.strictEqual(p5.sheets[0].back.left.page, 2);
assert.strictEqual(p5.sheets[0].back.right.blank, true);   // 7 = blank
assert.strictEqual(p5.sheets[1].front.left.blank, true);   // 6 = blank
assert.strictEqual(p5.sheets[1].back.left.page, 4);
assert.strictEqual(p5.sheets[1].back.right.page, 5);

// 所有槽位覆盖：每张纸 4 页，非空白页恰好 1..N
function coverage(n) {
  const plan = buildImpositionPlan(n);
  assert.strictEqual(plan.totalCount % 4, 0);
  const pages = [];
  for (const s of plan.sheets) {
    for (const side of ['front', 'back']) {
      for (const pos of ['left', 'right']) {
        const slot = s[side][pos];
        if (!slot.blank) pages.push(slot.page);
      }
    }
  }
  assert.strictEqual(pages.length, n, `n=${n} coverage count`);
  assert.deepStrictEqual([...pages].sort((a, b) => a - b), [...Array(n).keys()].map((i) => i + 1));
}
for (let n = 1; n <= 40; n++) coverage(n);

console.log('✅ 页序算法测试通过 (1..40 页全覆盖)');

// ---------- 1b. 分册签帖模式单测 ----------
// 1b.1 每帖纸张数校验：仅接受 1～20 的整数
assert.strictEqual(MAX_SHEETS_PER_SIGNATURE, 20);
for (const ok of [1, 2, 20, '3', '  4 ']) {
  assert.ok(Number.isInteger(parseMaxSheetsPerSignature(ok)), `应接受 ${JSON.stringify(ok)}`);
}
for (const bad of [0, -1, 21, 100, 1.5, NaN, '', '  ', 'abc', '4.0', '0x4', null, undefined, true]) {
  assert.throws(() => parseMaxSheetsPerSignature(bad), /1～20/, `应拒绝 ${JSON.stringify(bad)}`);
}
assert.throws(() => buildSignaturePlan(8, 0), /1～20/);
assert.throws(() => buildSignaturePlan(8, 21), /1～20/);
assert.throws(() => buildSignaturePlan(0, 4), /至少需要包含 1 页/);

// 1b.2 切分：13 页、每帖 2 张（容量 8 页）-> 两帖（8 页 + 5 页）
const sig13 = buildSignaturePlan(13, 2);
assert.strictEqual(sig13.signatureMode, true);
assert.strictEqual(sig13.signatureCount, 2);
assert.strictEqual(sig13.sheetCount, 2 + 2); // 第一帖 8 页 2 张，第二帖 5 页补 3 白 2 张
assert.strictEqual(sig13.paddedCount, 3);    // 第一帖满载不补白，仅末帖补 3
assert.deepStrictEqual(
  sig13.signatures.map((s) => [s.startPage, s.endPage, s.sourceCount, s.blanks, s.sheets.length]),
  [[1, 8, 8, 0, 2], [9, 13, 5, 3, 2]],
);

// 第一帖等价于 8 页整册：F[8|1] B[2|7]
assert.deepStrictEqual(sig13.signatures[0].sheets[0].front, {
  left: { page: 8, blank: false },
  right: { page: 1, blank: false },
});
assert.deepStrictEqual(sig13.signatures[0].sheets[0].back, {
  left: { page: 2, blank: false },
  right: { page: 7, blank: false },
});

// 第二帖为全局 9～13（帖内 1～5，补 3 白）：F[空白|9] B[10|空白]
const sig2 = sig13.signatures[1];
assert.strictEqual(sig2.sheets[0].front.left.blank, true);
assert.strictEqual(sig2.sheets[0].front.right.page, 9);
assert.strictEqual(sig2.sheets[0].back.left.page, 10);
assert.strictEqual(sig2.sheets[0].back.right.blank, true);
assert.strictEqual(sig2.sheets[1].back.left.page, 12);
assert.strictEqual(sig2.sheets[1].back.right.page, 13);
// 帖内纸张编号独立从 1 开始
assert.deepStrictEqual(sig2.sheets.map((s) => s.sheet), [1, 2]);

// 1b.3 边界：容量整除时最后一帖满载，无需补白；恰好一帖时与整册结果页序一致
const sig16 = buildSignaturePlan(16, 2);
assert.strictEqual(sig16.signatureCount, 2);
assert.strictEqual(sig16.paddedCount, 0);
assert.deepStrictEqual(
  sig16.signatures.map((s) => [s.startPage, s.endPage, s.blanks, s.sheets.length]),
  [[1, 8, 0, 2], [9, 16, 0, 2]],
);
for (const n of [1, 7, 8, 16]) {
  const one = buildSignaturePlan(n, 20);
  assert.strictEqual(one.signatureCount, 1, `n=${n} 应只有一帖`);
  assert.strictEqual(one.paddedCount, blanksForCount(n));
  assert.strictEqual(one.sheetCount, buildImpositionPlan(n).sheets.length);
  assert.strictEqual(one.signatures[0].sheets.length, buildImpositionPlan(n).sheets.length);
}

// 1b.4 全覆盖：任意页数 / 每帖纸张数下，全局页 1..N 各出现一次，补白仅在各帖末尾
function signatureCoverage(n, maxSheets) {
  const plan = buildSignaturePlan(n, maxSheets);
  const capacity = maxSheets * 4;
  assert.strictEqual(plan.signatureCount, Math.ceil(n / capacity));
  let expectedBlanks = 0;
  for (let start = 1; start <= n; start += capacity) {
    expectedBlanks += blanksForCount(Math.min(capacity, n - start + 1));
  }
  assert.strictEqual(plan.paddedCount, expectedBlanks, `n=${n} max=${maxSheets} 补白总数`);

  const pages = [];
  let blanks = 0;
  for (const sig of plan.signatures) {
    for (const s of sig.sheets) {
      for (const side of ['front', 'back']) {
        for (const pos of ['left', 'right']) {
          const slot = s[side][pos];
          if (slot.blank) blanks += 1;
          else pages.push(slot.page);
        }
      }
    }
  }
  assert.strictEqual(blanks, expectedBlanks, `n=${n} max=${maxSheets} 空白槽位数`);
  assert.strictEqual(pages.length, n, `n=${n} max=${maxSheets} 覆盖页数`);
  assert.deepStrictEqual(
    [...pages].sort((a, b) => a - b),
    [...Array(n).keys()].map((i) => i + 1),
  );
  assert.strictEqual(plan.sheetCount * 4, n + expectedBlanks);
}
for (let n = 1; n <= 85; n++) {
  for (const max of [1, 2, 3, 20]) signatureCoverage(n, max);
}

console.log('✅ 分册签帖算法测试通过（切分/帖末补白/帖内编号/1..85 全覆盖/非法上限拒绝）');

// ---------- 2. 混合尺寸适配单测 ----------
// 2.1 旋转角规范化：负角、超圈角、非 90 倍数
assert.strictEqual(normalizeRotation(0), 0);
assert.strictEqual(normalizeRotation(90), 90);
assert.strictEqual(normalizeRotation(180), 180);
assert.strictEqual(normalizeRotation(270), 270);
assert.strictEqual(normalizeRotation(-90), 270);
assert.strictEqual(normalizeRotation(450), 90);
assert.strictEqual(normalizeRotation(89.6), 90);

// 2.2 统一面板尺寸：取全部页面有效宽高的最大值，并给出方向
const mixedPanel = computePanelSize([
  { width: 595.28, height: 841.89 }, // A4 竖版
  { width: 841.89, height: 595.28 }, // A4 横版（旋转后的有效宽高）
  { width: 300, height: 400 },       // 小尺寸页
]);
assert.ok(Math.abs(mixedPanel.width - 841.89) < 1e-6);
assert.ok(Math.abs(mixedPanel.height - 841.89) < 1e-6);
assert.strictEqual(mixedPanel.orientation, 'square');
assert.strictEqual(computePanelSize([{ width: 595.28, height: 841.89 }]).orientation, 'portrait');
assert.strictEqual(computePanelSize([{ width: 841.89, height: 595.28 }]).orientation, 'landscape');

// 2.3 槽位放置：任意旋转下，旋转后的内容包围盒恰好居中于半区
function placedBBox(srcW, srcH, rotation, originX, panelW, panelH) {
  const p = slotPlacement(srcW, srcH, rotation, originX, panelW, panelH);
  const rad = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [[0, 0], [srcW, 0], [0, srcH], [srcW, srcH]].map(([cx, cy]) => [
    p.x + cx * cos - cy * sin,
    p.y + cx * sin + cy * cos,
  ]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

for (const rotation of [0, 90, 180, 270]) {
  const srcW = 595.28;
  const srcH = 841.89;
  const panelW = 900;
  const panelH = 900;
  const originX = 900; // 右半区
  const bbox = placedBBox(srcW, srcH, rotation, originX, panelW, panelH);
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? srcH : srcW;
  const dispH = swapped ? srcW : srcH;
  const eps = 1e-6;
  assert.ok(Math.abs(bbox.minX - (originX + (panelW - dispW) / 2)) < eps, `rot=${rotation} minX`);
  assert.ok(Math.abs(bbox.maxX - (originX + (panelW + dispW) / 2)) < eps, `rot=${rotation} maxX`);
  assert.ok(Math.abs(bbox.minY - (panelH - dispH) / 2) < eps, `rot=${rotation} minY`);
  assert.ok(Math.abs(bbox.maxY - (panelH + dispH) / 2) < eps, `rot=${rotation} maxY`);
}

console.log('✅ 混合尺寸适配单测通过（旋转规范化 / 统一面板 / 各角度槽位居中）');

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

// ---------- 3. 端到端：生成 10 页 PDF，拼版后校验 ----------
(async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28; // A4 竖版 (pt)
  const PAGE_H = 841.89;
  for (let i = 1; i <= 10; i++) {
    const page = src.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();

  const { pdfBytes, plan } = await imposePdf(srcBytes);
  const out = await PDFDocument.load(pdfBytes);

  // 10 页 -> 12 面板 -> 3 张纸 -> 6 个输出页面
  assert.strictEqual(out.getPageCount(), 6, '输出页数应为 2 × 张数');
  assert.strictEqual(plan.sheets.length, 3);
  assert.strictEqual(plan.paddedCount, 2);

  // 统一面板 = A4 竖版；输出页面为横向 A3：宽 = 2×A4宽，高 = A4高
  assert.ok(Math.abs(plan.panel.width - PAGE_W) < 0.01, `面板宽 ${plan.panel.width}`);
  assert.ok(Math.abs(plan.panel.height - PAGE_H) < 0.01, `面板高 ${plan.panel.height}`);
  assert.strictEqual(plan.panel.orientation, 'portrait');
  const outPage = out.getPage(0);
  assert.ok(Math.abs(outPage.getWidth() - PAGE_W * 2) < 0.5, `宽度 ${outPage.getWidth()}`);
  assert.ok(Math.abs(outPage.getHeight() - PAGE_H) < 0.5, `高度 ${outPage.getHeight()}`);

  fs.writeFileSync('/tmp/out-10pages.pdf', pdfBytes);
  console.log('✅ 端到端拼版通过：10 页 -> 3 张纸(6 面)，输出横向尺寸正确');
  console.log('   页序预览：');
  for (const s of plan.sheets) {
    const f = (p) => (p.blank ? '空白' : `${p.page}`);
    console.log(`   第${s.sheet}张 正面 [${f(s.front.left)} | ${f(s.front.right)}]  背面 [${f(s.back.left)} | ${f(s.back.right)}]`);
  }

  // ---------- 4. 端到端：混合尺寸 + 旋转页面 ----------
  const A4W = 595.28;
  const A4H = 841.89;

  // 4.1 effectivePageSize：旋转 270° 的页面有效宽高互换
  const rotDoc = await PDFDocument.create();
  const rp = rotDoc.addPage([200, 100]);
  rp.setRotation(degrees(270));
  const eff = effectivePageSize(rp);
  assert.strictEqual(eff.rotation, 270);
  assert.strictEqual(eff.width, 100);
  assert.strictEqual(eff.height, 200);

  // 4.2 构造 5 页混合 PDF：竖版 A4 ×2、小页、/Rotate 90 的 A4、横版介质 900×500
  const mixed = await PDFDocument.create();
  const mfont = await mixed.embedFont(StandardFonts.Helvetica);
  for (const label of ['M1', 'M2']) {
    const p = mixed.addPage([A4W, A4H]);
    p.drawText(label, { x: 200, y: 400, size: 40, font: mfont });
  }
  const p3 = mixed.addPage([300, 400]);
  p3.drawText('M3', { x: 100, y: 200, size: 30, font: mfont });
  const p4 = mixed.addPage([A4W, A4H]);
  p4.setRotation(degrees(90)); // 显示为横版 841.89 × 595.28
  p4.drawText('M4', { x: 200, y: 400, size: 40, font: mfont });
  const p5 = mixed.addPage([900, 500]);
  p5.drawText('M5', { x: 400, y: 250, size: 40, font: mfont });
  const mixedBytes = await mixed.save();

  const { pdfBytes: mixedOut, plan: mixedPlan } = await imposePdf(mixedBytes);

  // 统一面板：宽 = max(595.28, 595.28, 300, 841.89, 900) = 900
  //          高 = max(841.89, 841.89, 400, 595.28, 500) = 841.89
  assert.ok(Math.abs(mixedPlan.panel.width - 900) < 0.01, `面板宽 ${mixedPlan.panel.width}`);
  assert.ok(Math.abs(mixedPlan.panel.height - A4H) < 0.01, `面板高 ${mixedPlan.panel.height}`);
  assert.strictEqual(mixedPlan.panel.orientation, 'landscape');

  // 5 页 -> 补 3 白 -> 8 面板 -> 2 张纸 -> 4 个输出页面，纸张 = 1800 × 841.89
  const mixedDoc = await PDFDocument.load(mixedOut);
  assert.strictEqual(mixedDoc.getPageCount(), 4, '输出页数应为 2 × 张数');
  assert.strictEqual(mixedPlan.paddedCount, 3);
  const sheet0 = mixedDoc.getPage(0);
  assert.ok(Math.abs(sheet0.getWidth() - 1800) < 0.01, `纸宽 ${sheet0.getWidth()}`);
  assert.ok(Math.abs(sheet0.getHeight() - A4H) < 0.01, `纸高 ${sheet0.getHeight()}`);

  // 页序与补白规则不变：第 2 张纸背面 = [第 4 页 | 第 5 页]
  assert.strictEqual(mixedPlan.sheets[1].back.left.page, 4);
  assert.strictEqual(mixedPlan.sheets[1].back.right.page, 5);

  // 4.3 旋转页（源第 4 页，位于第 2 张纸背面左半区 = 输出第 4 页）：
  // 内容流应包含 -90° 旋转矩阵，且平移锚点使旋转后的内容居中于左半区
  const backContent = decodePageContent(mixedDoc, 3);
  const ops = parseCmOperators(backContent);
  const expectX = (900 - A4H) / 2;                 // 左半区水平居中：29.055
  const expectY = (A4H - A4W) / 2 + A4W;           // 锚点上移一个显示高度：718.585
  const rotOp = ops.find((m) => Math.abs(m[0]) < 1e-6 && Math.abs(m[1] + 1) < 1e-6
    && Math.abs(m[2] - 1) < 1e-6 && Math.abs(m[3]) < 1e-6);
  assert.ok(rotOp, '旋转页应带有 -90° 旋转矩阵');
  const moveOp = ops.find((m) => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6
    && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6
    && Math.abs(m[4] - expectX) < 0.01 && Math.abs(m[5] - expectY) < 0.01);
  assert.ok(moveOp, `旋转页应平移到 (${expectX.toFixed(3)}, ${expectY.toFixed(3)})`);

  // 4.4 小页（源第 3 页，第 2 张纸正面右半区 = 输出第 3 页）1:1 居中，无缩放无旋转
  const frontContent = decodePageContent(mixedDoc, 2);
  const frontOps = parseCmOperators(frontContent);
  const smallX = 900 + (900 - 300) / 2;            // 右半区水平居中：1200
  const smallY = (A4H - 400) / 2;                  // 垂直居中：220.945
  const smallOp = frontOps.find((m) => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6
    && Math.abs(m[2]) < 1e-6 && Math.abs(m[3] - 1) < 1e-6
    && Math.abs(m[4] - smallX) < 0.01 && Math.abs(m[5] - smallY) < 0.01);
  assert.ok(smallOp, `小页应 1:1 居中于 (${smallX}, ${smallY.toFixed(3)})`);

  fs.writeFileSync('/tmp/out-mixed.pdf', mixedOut);
  console.log('✅ 端到端混合尺寸拼版通过：5 页(含旋转/小页/横版) -> 2 张纸(4 面)');
  console.log(`   统一面板：${mixedPlan.panel.width} × ${mixedPlan.panel.height} pt（${mixedPlan.panel.orientation}）`);

  // ---------- 5. 端到端：分册签帖模式 ----------
  const sigSrc = await PDFDocument.create();
  const sigFont = await sigSrc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 13; i++) {
    const p = sigSrc.addPage([PAGE_W, PAGE_H]);
    p.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font: sigFont, color: rgb(0, 0, 0) });
  }
  const sigSrcBytes = await sigSrc.save();

  // 13 页、每帖 2 张（8 页容量）-> 2 帖（8 页 + 5 页补 3 白）-> 共 4 张纸 -> 8 个输出页
  const { pdfBytes: sigBytes, plan: sigPlan } = await imposePdf(sigSrcBytes, { maxSheetsPerSignature: 2 });
  const sigOut = await PDFDocument.load(sigBytes);
  assert.strictEqual(sigOut.getPageCount(), 8, '签帖输出页数应为 2 × 总张数');
  assert.strictEqual(sigPlan.signatureMode, true);
  assert.strictEqual(sigPlan.signatureCount, 2);
  assert.strictEqual(sigPlan.sheetCount, 4);
  assert.strictEqual(sigPlan.paddedCount, 3);
  assert.strictEqual(sigPlan.maxSheetsPerSignature, 2);
  // 输出页仍为横向 A3 尺寸
  assert.ok(Math.abs(sigOut.getPage(0).getWidth() - PAGE_W * 2) < 0.5);
  assert.ok(Math.abs(sigOut.getPage(0).getHeight() - PAGE_H) < 0.5);

  // 非法上限在核心层直接拒绝
  await assert.rejects(
    () => imposePdf(sigSrcBytes, { maxSheetsPerSignature: 0 }),
    /1～20/,
  );
  await assert.rejects(
    () => imposePdf(sigSrcBytes, { maxSheetsPerSignature: 21 }),
    /1～20/,
  );

  // 未启用（缺省）保持整册行为：13 页 -> 帖末补 3 白到 16 面板 -> 4 张纸 -> 8 个输出页
  const { pdfBytes: wholeBytes, plan: wholePlan } = await imposePdf(sigSrcBytes);
  const wholeOut = await PDFDocument.load(wholeBytes);
  assert.strictEqual(wholePlan.signatureMode, undefined);
  assert.strictEqual(wholePlan.paddedCount, 3);
  assert.strictEqual(wholePlan.sheets.length, 4);
  assert.strictEqual(wholeOut.getPageCount(), 8);

  fs.writeFileSync('/tmp/out-signatures.pdf', sigBytes);
  console.log('✅ 端到端分册签帖拼版通过：13 页(每帖 2 张) -> 2 帖 4 张纸(8 面)，末帖帖末补白 3 页');
  for (const sig of sigPlan.signatures) {
    console.log(`   第${sig.signature}帖 原始页 ${sig.startPage}-${sig.endPage}（${sig.sourceCount} 页，补白 ${sig.blanks}）：`);
    for (const s of sig.sheets) {
      const f = (p) => (p.blank ? '空白' : `${p.page}`);
      console.log(`     帖内第${s.sheet}张 正面 [${f(s.front.left)} | ${f(s.front.right)}]  背面 [${f(s.back.left)} | ${f(s.back.right)}]`);
    }
  }
})();
