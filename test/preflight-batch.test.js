'use strict';

// 批量印前校验 · 交付放行判定测试：
//   - 默认处置：错误阻断、警告复核、提示忽略；
//   - 自定义策略（含 JSON 字符串）的覆盖、默认/自定义来源与非法参数报错；
//   - 逐文件 blocked / review / passed 与无法校验 undetermined；
//     阻断优先于警告；整批优先级 blocked > undetermined > review > passed；
//   - 原检测报告、文件级 passed 与 summary.allPassed 含义保持不变；
//   - 完整批量 JSON 内嵌 releasePolicy 与逐文件 release。

const assert = require('assert');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const {
  preflightPdfBatch,
  normalizeReleasePolicy,
  buildReleasePolicy,
  evaluateFileRelease,
} = require('../lib/preflight-batch');

// ---------- 1. 策略规范化纯函数 ----------

// 1.1 缺省 / 空值 → 无覆盖
assert.deepStrictEqual(normalizeReleasePolicy(undefined), {});
assert.deepStrictEqual(normalizeReleasePolicy(null), {});
assert.deepStrictEqual(normalizeReleasePolicy(''), {});
assert.deepStrictEqual(normalizeReleasePolicy({}), {});

// 1.2 JSON 字符串与对象等价
assert.deepStrictEqual(
  normalizeReleasePolicy('{"rotated_180":"ignore","transparency":"block"}'),
  { rotated_180: 'ignore', transparency: 'block' },
);

// 1.3 未知代码 / 非法处置 / 非对象 JSON / 非法 JSON 均抛错
assert.throws(() => normalizeReleasePolicy({ not_a_code: 'block' }), /未知问题代码/);
assert.throws(() => normalizeReleasePolicy({ rotated_180: 'reject' }), /处置方式非法/);
assert.throws(() => normalizeReleasePolicy('[]'), /必须是对象/);
assert.throws(() => normalizeReleasePolicy('{bad-json'), /JSON 对象/);
assert.throws(() => normalizeReleasePolicy([1, 2]), /必须是对象/);

// 1.4 策略快照：默认规则与覆盖来源
{
  const snapshot = buildReleasePolicy({ rotated_180: 'ignore' });
  assert.deepStrictEqual(snapshot.defaults, {
    error: 'block', warning: 'warn', info: 'ignore',
  });
  assert.deepStrictEqual(snapshot.custom, { rotated_180: 'ignore' });
  const r180 = snapshot.rules.find((r) => r.code === 'rotated_180');
  assert.strictEqual(r180.action, 'ignore');
  assert.strictEqual(r180.source, 'custom');
  const tr = snapshot.rules.find((r) => r.code === 'transparency');
  assert.strictEqual(tr.action, 'warn');
  assert.strictEqual(tr.source, 'default');
  const bp = snapshot.rules.find((r) => r.code === 'blank_padding');
  assert.strictEqual(bp.action, 'ignore');
  // 排序：错误 → 警告 → 提示
  assert.strictEqual(snapshot.rules[0].code, 'rotated_180');
}

// ---------- 2. 端到端：构造不同检测结果的 PDF ----------

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([spec.w || 595.28, spec.h || 841.89]);
    if (!spec.noText) {
      page.drawText(spec.text || `PAGE ${spec.n}`, { x: 80, y: 400, size: 24, font, color: rgb(0, 0, 0) });
    }
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
  }
  return Buffer.from(await doc.save());
}

(async () => {
  // A：5 页 + 第 5 页 180° → rotated_180(错误) + blank_padding(提示)
  const bytesA = await makePdf([
    { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 },
    { n: 5, rotation: 180, text: 'UPSIDE DOWN' },
  ]);
  // B：4 页干净
  const bytesB = await makePdf([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  // C：1 页无文字（4 的倍数）→ no_extractable_text(提示)
  const bytesC = await makePdf([{ n: 1, noText: true, w: 595.28, h: 841.89 }]);

  // ---------- 2.1 默认策略 ----------
  const files = [
    { buffer: bytesA, originalname: 'a-rot180.pdf', size: bytesA.length },
    { buffer: bytesB, originalname: 'b-clean.pdf', size: bytesB.length },
    { buffer: bytesC, originalname: 'c-notext.pdf', size: bytesC.length },
    { buffer: Buffer.from('%PDF-broken'), originalname: 'd-broken.pdf', size: 11 },
    { buffer: Buffer.alloc(0), originalname: 'e-empty.pdf', size: 0 },
  ];
  const report = await preflightPdfBatch(files);

  assert.strictEqual(report.summary.completed, 3);
  assert.strictEqual(report.summary.failed, 2);

  // 文件 A：检测不通过（有错误）；默认策略下错误阻断 → blocked
  const a = report.files[0];
  assert.strictEqual(a.status, 'completed');
  assert.strictEqual(a.passed, false, 'passed 仍只表示无错误级问题');
  assert.strictEqual(a.release.decision, 'blocked');
  assert.deepStrictEqual(a.release.actionCounts, { block: 1, warn: 0, ignore: 1 });
  const aBlocked = a.release.triggered.filter((t) => t.action === 'block');
  assert.strictEqual(aBlocked.length, 1);
  assert.strictEqual(aBlocked[0].code, 'rotated_180');
  assert.strictEqual(aBlocked[0].source, 'default');
  const aIgnored = a.release.triggered.filter((t) => t.action === 'ignore');
  assert.ok(aIgnored.some((t) => t.code === 'blank_padding'));
  // triggered 排序：阻断在前
  assert.strictEqual(a.release.triggered[0].action, 'block');

  // 文件 B：无问题 → 检测通过、放行 passed
  const b = report.files[1];
  assert.strictEqual(b.passed, true);
  assert.strictEqual(b.release.decision, 'passed');
  assert.deepStrictEqual(b.release.actionCounts, { block: 0, warn: 0, ignore: 0 });
  assert.deepStrictEqual(b.release.triggered, []);

  // 文件 C：仅提示（无文字 + 1 页需补白，均为提示）→ 检测通过（passed 含义不变）；
  // 默认提示忽略 → 放行
  const c = report.files[2];
  assert.strictEqual(c.passed, true);
  assert.strictEqual(c.release.decision, 'passed');
  assert.deepStrictEqual(c.release.actionCounts, { block: 0, warn: 0, ignore: 2 });
  const cNoText = c.release.triggered.find((t) => t.code === 'no_extractable_text');
  assert.strictEqual(cNoText.action, 'ignore');

  // 文件 D/E：无法校验 → undetermined
  assert.strictEqual(report.files[3].release.decision, 'undetermined');
  assert.strictEqual(report.files[4].release.decision, 'undetermined');

  // 整批：有 blocked（优先）→ blocked，即使同时存在 undetermined
  assert.strictEqual(report.summary.release.decision, 'blocked');
  assert.deepStrictEqual(
    {
      blocked: report.summary.release.blocked,
      review: report.summary.release.review,
      passed: report.summary.release.passed,
      undetermined: report.summary.release.undetermined,
    },
    { blocked: 1, review: 0, passed: 2, undetermined: 2 },
  );

  // 原检测维度字段含义不变（B 与 C 均无错误级问题，passed=2；A 有错误）
  assert.strictEqual(report.summary.passed, 2);
  assert.strictEqual(report.summary.allPassed, false);
  assert.ok(report.files[0].report && Array.isArray(report.files[0].report.issues));

  // issueTotals 带处置；rotated_180 为 block、no_extractable_text 为 ignore
  const total180 = report.issueTotals.find((t) => t.code === 'rotated_180');
  assert.strictEqual(total180.action, 'block');
  assert.strictEqual(total180.actionSource, 'default');
  const totalNoText = report.issueTotals.find((t) => t.code === 'no_extractable_text');
  assert.strictEqual(totalNoText.action, 'ignore');

  // 策略快照写入完整批量 JSON
  assert.ok(report.releasePolicy && Array.isArray(report.releasePolicy.rules));
  assert.strictEqual(report.releasePolicy.rules.length, 6);
  assert.deepStrictEqual(report.releasePolicy.custom, {});

  // ---------- 2.2 自定义策略：错误忽略 + 提示阻断 ----------
  // A 的 rotated_180 改为 ignore 后只剩提示（blank_padding 默认 ignore）→ passed；
  // C 的 no_extractable_text 改为 block → blocked。
  const custom = { rotated_180: 'ignore', no_extractable_text: 'block' };
  const customReport = await preflightPdfBatch(files, { releasePolicy: custom });
  const ca = customReport.files[0];
  assert.strictEqual(ca.passed, false, '检测维度：180° 仍是错误，passed=false 不变');
  assert.strictEqual(ca.release.decision, 'passed', '放行维度：阻断/警告代码均无 → 放行');
  const ca180 = ca.release.triggered.find((t) => t.code === 'rotated_180');
  assert.strictEqual(ca180.action, 'ignore');
  assert.strictEqual(ca180.source, 'custom');

  const cc = customReport.files[2];
  assert.strictEqual(cc.release.decision, 'blocked');
  assert.strictEqual(cc.release.triggered[0].action, 'block');
  assert.strictEqual(cc.release.triggered[0].source, 'custom');

  // 整批：C 阻断 → blocked（A 已不阻断）
  assert.strictEqual(customReport.summary.release.decision, 'blocked');
  assert.strictEqual(customReport.summary.release.blocked, 1);
  assert.deepStrictEqual(customReport.releasePolicy.custom, custom);
  const customTotal = customReport.issueTotals.find((t) => t.code === 'no_extractable_text');
  assert.strictEqual(customTotal.action, 'block');
  assert.strictEqual(customTotal.actionSource, 'custom');

  // ---------- 2.3 警告 → 需复核；阻断优先于警告 ----------
  // 干净 4 页 PDF 无警告；构造含 90° 旋转（警告）的 4 页文档
  const bytesWarn = await makePdf([
    { n: 1 }, { n: 2 }, { n: 3 },
    { n: 4, rotation: 90, text: 'ROTATED 90' },
  ]);
  const warnReport = await preflightPdfBatch([
    { buffer: bytesWarn, originalname: 'w.pdf', size: bytesWarn.length },
    { buffer: bytesB, originalname: 'b.pdf', size: bytesB.length },
  ]);
  assert.strictEqual(warnReport.files[0].passed, true, '90° 是警告，检测 passed=true');
  assert.strictEqual(warnReport.files[0].release.decision, 'review');
  assert.deepStrictEqual(warnReport.files[0].release.actionCounts, { block: 0, warn: 1, ignore: 0 });
  // 整批无阻断/未判定，但有 review → review
  assert.strictEqual(warnReport.summary.release.decision, 'review');
  assert.strictEqual(warnReport.summary.release.review, 1);
  assert.strictEqual(warnReport.summary.release.passed, 1);

  // 同一文件同时含阻断与警告时判 blocked（阻断优先）：
  // A（错误+提示）+ 把 transparency 之外引入警告不便构造，改用策略把
  // blank_padding(提示) 设为 warn：A 同时有 block 与 warn → 仍 blocked
  const mixed = await preflightPdfBatch(
    [{ buffer: bytesA, originalname: 'a.pdf', size: bytesA.length }],
    { releasePolicy: { blank_padding: 'warn' } },
  );
  assert.strictEqual(mixed.files[0].release.decision, 'blocked');
  assert.deepStrictEqual(mixed.files[0].release.actionCounts, { block: 1, warn: 1, ignore: 0 });

  // ---------- 2.4 无法校验优先于需复核 ----------
  // 一个警告文件（review）+ 一个坏文件（undetermined），无阻断 → undetermined
  const undecided = await preflightPdfBatch([
    { buffer: bytesWarn, originalname: 'w.pdf', size: bytesWarn.length },
    { buffer: Buffer.from('not pdf at all'), originalname: 'x.txt', size: 14 },
  ]);
  assert.strictEqual(undecided.summary.release.decision, 'undetermined');
  assert.strictEqual(undecided.summary.release.review, 1);
  assert.strictEqual(undecided.summary.release.undetermined, 1);

  // ---------- 2.5 全部干净 → passed ----------
  const allClean = await preflightPdfBatch([
    { buffer: bytesB, originalname: 'b1.pdf', size: bytesB.length },
    { buffer: bytesB, originalname: 'b2.pdf', size: bytesB.length },
  ]);
  assert.strictEqual(allClean.summary.release.decision, 'passed');
  assert.strictEqual(allClean.summary.release.passed, 2);
  assert.strictEqual(allClean.summary.allPassed, true);

  // ---------- 3. evaluateFileRelease 直接单测（伪造报告） ----------
  const fakeReport = {
    issues: [
      { code: 'transparency', severity: 'warning', title: '透明' },
      { code: 'blank_padding', severity: 'info', title: '补白' },
      { code: 'blank_padding', severity: 'info', title: '补白' }, // 同代码多条 → 计 1
    ],
  };
  const ev = evaluateFileRelease(fakeReport, {});
  assert.strictEqual(ev.decision, 'review');
  assert.deepStrictEqual(ev.actionCounts, { block: 0, warn: 1, ignore: 1 });
  assert.strictEqual(ev.triggered.find((t) => t.code === 'blank_padding').count, 2);
  assert.strictEqual(ev.triggered[0].action, 'warn', '阻断/警告排序在前');

  console.log('✅ 批量放行判定测试通过：默认处置（错误阻断/警告复核/提示忽略）、自定义覆盖、');
  console.log('   逐文件 blocked/review/passed/undetermined、阻断优先与整批优先级、');
  console.log('   策略快照导出，以及 passed/allPassed/原报告含义不变');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
