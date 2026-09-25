'use strict';

// 印刷用纸报价纯函数测试：版面读取、纸张规范化、旋转枚举、选优与不可行原因。
const assert = require('assert');
const {
  PT_PER_MM,
  MAX_PAPER_SPECS,
  mmToPt,
  normalizePaperSpecs,
  readLayout,
  buildPaperQuote,
} = require('../lib/quote');

function mm(pt) {
  return pt / PT_PER_MM;
}

// ---------- 1. 版面读取 ----------

// A4 竖版面板（pt），展开印张 = 420 × 297 mm
const PANEL_A4 = { width: 595.2756, height: 841.8898, orientation: 'portrait' };
const planA4 = {
  sheets: [{ sheet: 1 }, { sheet: 2 }],
  sourceCount: 8, paddedCount: 0, totalCount: 8, blanks: 0,
  panel: PANEL_A4,
};

const layoutA4 = readLayout(planA4);
assert.strictEqual(layoutA4.sheetCount, 2);
assert.strictEqual(layoutA4.runCount, 1);
assert.strictEqual(layoutA4.signatureMode, false);
assert.strictEqual(layoutA4.signatureCount, null);

// 签帖模式：3 帖、帖内 2+2+1 张 → 总 5 张、开机 3 次
const sigPlan = {
  signatureMode: true,
  signatures: [
    { signature: 1, sheets: [{ sheet: 1 }, { sheet: 2 }] },
    { signature: 2, sheets: [{ sheet: 1 }, { sheet: 2 }] },
    { signature: 3, sheets: [{ sheet: 1 }] },
  ],
  sheetCount: 5, signatureCount: 3,
  panel: PANEL_A4,
};
const sigLayout = readLayout(sigPlan);
assert.strictEqual(sigLayout.sheetCount, 5);
assert.strictEqual(sigLayout.runCount, 3);
assert.strictEqual(sigLayout.signatureMode, true);

// 无效方案
assert.throws(() => readLayout(null), /缺少拼版方案/);
assert.throws(() => readLayout({ sheets: [] }), /panel/);
assert.throws(() => readLayout({ panel: { width: 0, height: 10 } }), /面板尺寸无效/);
assert.throws(() => readLayout({ panel: PANEL_A4, sheets: [] }), /sheets 纸张列表/);
assert.throws(
  () => readLayout({ signatureMode: true, signatures: [], panel: PANEL_A4 }),
  /signatures 签帖列表/,
);
assert.throws(
  () => readLayout({ signatureMode: true, signatures: [{ sheets: [] }], panel: PANEL_A4 }),
  /不包含任何纸张/,
);

// ---------- 2. 纸张规格规范化 ----------

const specs = normalizePaperSpecs([
  { name: 'A3', widthMm: '420', heightMm: 297, pricePerSheet: 0.8, setupFee: 50 },
  { widthMm: 500, heightMm: 707, pricePerSheet: 2, setupFee: 0 }, // 数字字符串/缺名兜底
]);
assert.strictEqual(specs[0].widthMm, 420);
assert.strictEqual(specs[1].name, '纸张 2');

assert.throws(() => normalizePaperSpecs({}), /papers 必须是纸张规格数组/);
assert.throws(() => normalizePaperSpecs([]), /至少维护一种/);
assert.throws(
  () => normalizePaperSpecs(Array(MAX_PAPER_SPECS + 1).fill({ widthMm: 1, heightMm: 1 })),
  new RegExp(`最多维护 ${MAX_PAPER_SPECS} 种`),
);
assert.throws(() => normalizePaperSpecs([{ widthMm: 0, heightMm: 1 }]), /宽必须是大于 0/);
assert.throws(() => normalizePaperSpecs([{ widthMm: 1, heightMm: 'abc' }]), /高必须是大于 0/);
assert.throws(() => normalizePaperSpecs([{ widthMm: 1, heightMm: 1, pricePerSheet: -1 }]), /单价/);
assert.throws(() => normalizePaperSpecs([{ widthMm: 1, heightMm: 1, pricePerSheet: 0, setupFee: -0.1 }]), /开机费/);

// ---------- 3. 报价：枚举方向并选择最低总价 ----------

// A3（420×297，恰好放下，单价高）与 B2（500×707，单价低）
const quote = buildPaperQuote(planA4, [
  { name: 'A3 铜版', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
  { name: 'B2 胶版', widthMm: 500, heightMm: 707, pricePerSheet: 0.5, setupFee: 30 },
]);
assert.strictEqual(quote.feasible, true);
assert.strictEqual(quote.options.length, 2);
assert.ok(quote.options.every((o) => o.fits));

const a3 = quote.options[0];
// A3 原向恰好容纳（420×297），旋转后 297 < 420 不可行
assert.strictEqual(a3.placement.orientation, 'as_is');
assert.strictEqual(a3.placement.rotated, false);
assert.ok(a3.placement.slackWidthMm <= 0.01);
assert.ok(a3.placement.slackHeightMm <= 0.01);
// 利用率 = 版面面积 / 纸张面积 = 100%
assert.ok(Math.abs(a3.utilization - 1) < 1e-4, `A3 利用率应为 100%，实际 ${a3.utilization}`);
assert.strictEqual(a3.utilizationPercent, 100);
// 2 张：纸张费 2 元 + 开机 50 元 = 52 元
assert.strictEqual(a3.paperCost, 2);
assert.strictEqual(a3.setupCost, 50);
assert.strictEqual(a3.totalCost, 52);

const b2 = quote.options[1];
// B2 原向与旋转均可，slack 相同选原向
assert.strictEqual(b2.placement.orientation, 'as_is');
// 纸张费 2 × 0.5 = 1，开机 30 → 31 元，低于 A3
assert.strictEqual(b2.totalCost, 31);
// 利用率 = 420×297 / 500×707 ≈ 35.3%
const expectedUtilB2 = (420 * 297) / (500 * 707);
assert.ok(Math.abs(b2.utilization - expectedUtilB2) < 1e-3);

// 最低总价方案选中 B2
assert.strictEqual(quote.selected.name, 'B2 胶版');
assert.strictEqual(quote.selected.totalCost, 31);

// 版面信息：2 张纸 / 1 次开机 / 展开 420 × 297 mm
assert.strictEqual(quote.layout.sheetCount, 2);
assert.strictEqual(quote.layout.runCount, 1);
assert.strictEqual(quote.layout.signatureMode, false);
assert.ok(Math.abs(quote.layout.sheet.widthMm - 420) < 0.01);
assert.ok(Math.abs(quote.layout.sheet.heightMm - 297) < 0.01);

// ---------- 4. 仅旋转方向可容纳 ----------

// B3 353×500：原向宽 353 < 420 放不下；旋转 90° 后 500×353 可放
const rotateQuote = buildPaperQuote(planA4, [
  { name: 'B3', widthMm: 353, heightMm: 500, pricePerSheet: 0.6, setupFee: 20 },
]);
assert.strictEqual(rotateQuote.feasible, true);
assert.strictEqual(rotateQuote.selected.name, 'B3');
assert.strictEqual(rotateQuote.selected.placement.orientation, 'rotated_90');
assert.strictEqual(rotateQuote.selected.placement.rotated, true);
// 旋转后使用纸张的高×宽作为占用尺寸
assert.strictEqual(rotateQuote.selected.placement.paperWidthUsedMm, 500);
assert.strictEqual(rotateQuote.selected.placement.paperHeightUsedMm, 353);
assert.ok(Math.abs(rotateQuote.selected.placement.slackWidthMm - 80) < 0.01);
assert.ok(Math.abs(rotateQuote.selected.placement.slackHeightMm - 56) < 0.01);

// ---------- 5. 全部不可行：明确原因 ----------

const noFit = buildPaperQuote(planA4, [
  { name: 'A4', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 },
]);
assert.strictEqual(noFit.feasible, false);
assert.strictEqual(noFit.selected, null);
assert.strictEqual(noFit.reasonCode, 'no_fitting_paper');
assert.match(noFit.reason, /420/);
assert.match(noFit.reason, /A4/);
const opt = noFit.options[0];
assert.strictEqual(opt.fits, false);
assert.strictEqual(opt.reasons.length, 2);
const asIs = opt.reasons.find((r) => r.orientation === 'as_is');
const rotated = opt.reasons.find((r) => r.orientation === 'rotated_90');
// 原向 297×210：宽度不足 123mm、高度不足 87mm
assert.ok(Math.abs(asIs.shortageWidthMm - 123) < 0.01, `原向宽度不足: ${asIs.shortageWidthMm}`);
assert.ok(Math.abs(asIs.shortageHeightMm - 87) < 0.01);
assert.match(asIs.message, /宽度不足/);
assert.match(asIs.message, /高度不足/);
// 旋转后 210×297：宽度仍不足 210mm，高度恰好够
assert.ok(Math.abs(rotated.shortageWidthMm - 210) < 0.01);
assert.strictEqual(rotated.shortageHeightMm, 0);
assert.match(rotated.message, /宽度不足/);
assert.doesNotMatch(rotated.message, /高度不足/);

// ---------- 6. 分册签帖：开机次数 = 帖数 ----------

const sigQuote = buildPaperQuote(sigPlan, [
  { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
]);
assert.strictEqual(sigQuote.feasible, true);
assert.strictEqual(sigQuote.layout.sheetCount, 5);
assert.strictEqual(sigQuote.layout.runCount, 3);
assert.strictEqual(sigQuote.layout.signatureCount, 3);
// 纸张费 5 元 + 开机费 50 × 3 = 150 → 155 元
assert.strictEqual(sigQuote.selected.paperCost, 5);
assert.strictEqual(sigQuote.selected.setupCost, 150);
assert.strictEqual(sigQuote.selected.totalCost, 155);

// ---------- 7. 选优：总价相同优先利用率高/纸张小/顺序靠前 ----------

const tie = buildPaperQuote(planA4, [
  // 两种纸张总价相同（单价 1、开机 50、2 张 → 52 元）
  { name: '大纸', widthMm: 600, heightMm: 600, pricePerSheet: 1, setupFee: 50 },
  { name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
]);
assert.strictEqual(tie.options.every((o) => o.totalCost === 52), true);
assert.strictEqual(tie.selected.name, 'A3'); // 利用率 100% 胜出

// ---------- 8. 结构稳定性（外部 JSON 消费字段） ----------

const json = JSON.parse(JSON.stringify(quote));
assert.strictEqual(json.kind, 'paper-quote');
assert.strictEqual(json.schemaVersion, 1);
assert.strictEqual(typeof json.generatedAt, 'string');
for (const o of json.options) {
  assert.ok(typeof o.name === 'string');
  assert.ok(o.paper.widthMm > 0 && o.paper.heightMm > 0);
  assert.ok(typeof o.paperCost === 'number');
  assert.ok(typeof o.setupCost === 'number');
  assert.ok(typeof o.totalCost === 'number');
}

// 浮点换算自检：210mm -> 595.27559…pt
assert.ok(Math.abs(mmToPt(210) - 595.2756) < 1e-3);
assert.ok(Math.abs(mm(595.2756) - 210) < 1e-3);

console.log('✅ 用纸报价纯函数测试通过：版面读取、方向枚举、最低总价选优、');
console.log('   旋转容纳、分册开机次数、不可行原因与金额/利用率计算');
