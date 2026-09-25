'use strict';

// 骑马钉爬移补偿（creep）测试：
//   1. 纸厚解析（0.05～0.5 mm，非法值明确报错）；
//   2. 单侧内移量＝（帖内张号－1）×纸厚，分册签帖各帖分别从零计算；
//   3. 端到端：同一印张正背两面左页向右、右页向左平移，半区矩形裁剪
//      （槽位裁切在各自半区），补白保持空白，页序/纸张尺寸/用纸数不变；
//   4. 未启用时方案与输出保持原样；
//   5. 缺页补印沿用本次纸厚与选项，生成与完整拼版对应印张逐页一致的 PDF；
//   6. HTTP 接口：/api/impose 与 /api/reprint 字段透传、非法纸厚 400。

const assert = require('assert');
const zlib = require('zlib');
const http = require('http');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const {
  MIN_PAPER_THICKNESS_MM,
  MAX_PAPER_THICKNESS_MM,
  parsePaperThicknessMm,
  creepShiftMm,
  annotateCreep,
  buildImpositionPlan,
  buildSignaturePlan,
  imposePdf,
} = require('../lib/impose');
const { reprintPdf } = require('../lib/reprint');
const { app } = require('../server');

const PT_PER_MM = 72 / 25.4;

// ---------- 1. 纸厚解析 ----------
assert.strictEqual(MIN_PAPER_THICKNESS_MM, 0.05);
assert.strictEqual(MAX_PAPER_THICKNESS_MM, 0.5);
for (const ok of [0.05, 0.1, 0.123, 0.5, '0.05', ' 0.2 ', '.5', '0.500']) {
  const v = parsePaperThicknessMm(ok);
  assert.ok(v >= 0.05 && v <= 0.5, `应接受 ${JSON.stringify(ok)} -> ${v}`);
}
for (const bad of [0, 0.04, 0.51, 1, -0.1, NaN, '', '   ', 'abc', '0.05mm', '1e-2', null, undefined, true]) {
  assert.throws(
    () => parsePaperThicknessMm(bad),
    /纸厚必须是 0\.05～0\.5 mm/,
    `应拒绝 ${JSON.stringify(bad)}`,
  );
}
console.log('✅ 纸厚解析通过：仅接受 0.05～0.5 mm 数值，非法值给出明确错误');

// ---------- 2. 内移量与分册重置 ----------
assert.strictEqual(creepShiftMm(1, 0.1), 0);      // 最外层第 1 张不平移
assert.strictEqual(creepShiftMm(2, 0.1), 0.1);
assert.strictEqual(creepShiftMm(3, 0.1), 0.2);
assert.strictEqual(creepShiftMm(20, 0.5), 9.5);  // 每帖 20 张时最内层

const wholePlan = annotateCreep(buildImpositionPlan(16), 0.1);
assert.deepStrictEqual(
  wholePlan.sheets.map((s) => s.creep.shiftMm),
  [0, 0.1, 0.2, 0.3],
);

// 13 页、每帖 2 张：两帖各 2 张纸，帖内张号都从 1 起，补偿量分别从零计算
const sigPlan = annotateCreep(buildSignaturePlan(13, 2), 0.1);
assert.deepStrictEqual(
  sigPlan.signatures.map((sig) => sig.sheets.map((s) => s.creep.shiftMm)),
  [[0, 0.1], [0, 0.1]],
);
console.log('✅ 内移量计算通过：（张号－1）×纸厚，分册签帖各帖分别从零计算');

// 读取输出页的内容流文本
function decodePageContent(doc, pageIndex) {
  const node = doc.getPage(pageIndex).node;
  const contents = node.get(PDFName.of('Contents'));
  const refs = typeof contents.asArray === 'function' ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return zlib.inflateSync(Buffer.from(stream.getContents())).toString('latin1');
  }).join('\n');
}

// 每个源页由 pdf-lib 绘制为一个 q…Do…Q 块，块内首个 cm 即放置平移
// （其后 rotate/scale/skew 的 cm 对 0 角/1:1 放置均为单位矩阵）。
function parseSlotTranslates(content) {
  const out = [];
  const blocks = content.split(/^Q$/m);
  for (const block of blocks) {
    const m = /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+cm/.exec(block);
    if (m) out.push({ x: Number(m[5]), y: Number(m[6]) });
  }
  return out;
}

// 裁剪矩形（re）、裁剪操作（W 非零环绕 + n 结束路径）、XObject 绘制（Do）
function parseClipRects(content) {
  return content.split('\n')
    .map((line) => /^(-?[\d.eE+-]+) (-?[\d.eE+-]+) (-?[\d.eE+-]+) (-?[\d.eE+-]+) re$/.exec(line))
    .filter(Boolean)
    .map((m) => m.slice(1, 5).map(Number));
}
const countOps = (content, op) => content.split('\n').filter((line) => line.trim() === op).length;
const countDo = (content) => content.split('\n').filter((line) => /^\/\S+ Do$/.test(line.trim())).length;

const PAGE_W = 595.28; // A4 竖版
const PAGE_H = 841.89;

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([PAGE_W, PAGE_H]).drawText(`PAGE ${i}`, {
      x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0),
    });
  }
  return doc.save();
}

(async () => {
  const srcBytes = await makePdf(8);

  // ---------- 3. 端到端：启用爬移补偿 ----------
  const res = await imposePdf(srcBytes, { creepCompensation: true, paperThicknessMm: '0.1' });
  const out = await PDFDocument.load(res.pdfBytes);
  const plan = res.plan;

  // 3.1 方案状态与逐张补偿量；页序与整册方案一致；纸张尺寸/页数不变
  assert.deepStrictEqual(plan.creep, { enabled: true, paperThicknessMm: 0.1 });
  assert.deepStrictEqual(plan.sheets.map((s) => s.creep.shiftMm), [0, 0.1]);
  assert.deepStrictEqual(
    plan.sheets.map((s) => [s.front, s.back]),
    buildImpositionPlan(8).sheets.map((s) => [s.front, s.back]),
    '爬移不得改变页序',
  );
  assert.strictEqual(out.getPageCount(), 4);
  assert.ok(Math.abs(out.getPage(0).getWidth() - PAGE_W * 2) < 0.01, '纸张宽度不变');
  assert.ok(Math.abs(out.getPage(0).getHeight() - PAGE_H) < 0.01, '纸张高度不变');

  const eps = 0.01;
  const shiftPt = 0.1 * PT_PER_MM;

  // 3.2 第 1 张（补偿量 0）：无裁剪路径，页面位置与未启用时一致
  for (const idx of [0, 1]) {
    const c = decodePageContent(out, idx);
    assert.strictEqual(parseClipRects(c).length, 0, `第 1 张输出第 ${idx + 1} 页不应裁剪`);
    assert.strictEqual(countOps(c, 'W'), 0);
    assert.strictEqual(countOps(c, 'n'), 0);
    const xs = parseSlotTranslates(c).map((t) => t.x).sort((a, b) => a - b);
    assert.deepStrictEqual(xs.length, 2);
    assert.ok(Math.abs(xs[0] - 0) < eps, `左页 x=${xs[0]}`);
    assert.ok(Math.abs(xs[1] - PAGE_W) < eps, `右页 x=${xs[1]}`);
  }

  // 3.3 第 2 张（补偿量 0.1mm）：正背两面左页向右、右页向左；半区裁剪
  for (const idx of [2, 3]) {
    const c = decodePageContent(out, idx);
    const rects = parseClipRects(c);
    assert.strictEqual(rects.length, 2, `第 2 张输出第 ${idx + 1} 页应有两个半区裁剪矩形`);
    // 裁剪在各自半区：左半区 [0,0,PAGE_W,PAGE_H]、右半区 [PAGE_W,0,PAGE_W,PAGE_H]
    const found = rects.filter((r) =>
      (Math.abs(r[0]) < eps && Math.abs(r[2] - PAGE_W) < eps && Math.abs(r[3] - PAGE_H) < eps)
      || (Math.abs(r[0] - PAGE_W) < eps && Math.abs(r[2] - PAGE_W) < eps && Math.abs(r[3] - PAGE_H) < eps));
    assert.strictEqual(found.length, 2, '裁剪矩形应恰好为左、右两个半区');
    assert.strictEqual(countOps(c, 'W'), 2);
    assert.strictEqual(countOps(c, 'n'), 2);

    const xs = parseSlotTranslates(c).map((t) => t.x).sort((a, b) => a - b);
    assert.strictEqual(xs.length, 2);
    assert.ok(Math.abs(xs[0] - shiftPt) < eps, `左页向右平移：x=${xs[0]} ≈ +${shiftPt}`);
    assert.ok(Math.abs(xs[1] - (PAGE_W - shiftPt)) < eps,
      `右页向左平移：x=${xs[1]} ≈ ${PAGE_W - shiftPt}`);
  }
  console.log('✅ 端到端爬移补偿通过：第 1 张不平移；第 2 张正背两面左页右移/右页左移 0.1mm，');
  console.log('   槽位在各自半区内裁剪，页序、纸张尺寸与输出页数不变');

  // 3.4 与定位标记叠加：纸张加大 8mm 边距，裁剪半区随版心偏移、爬移量不变
  const marked = await imposePdf(srcBytes, {
    registrationMarks: true,
    creepCompensation: true,
    paperThicknessMm: 0.1,
  });
  const markedOut = await PDFDocument.load(marked.pdfBytes);
  const { MARK_MARGIN_PT } = require('../lib/sheet-marks');
  assert.ok(Math.abs(markedOut.getPage(0).getWidth() - (PAGE_W * 2 + 2 * MARK_MARGIN_PT)) < eps);
  const mc = decodePageContent(markedOut, 2);
  const mRects = parseClipRects(mc);
  assert.strictEqual(mRects.length, 2);
  for (const r of mRects) {
    assert.ok(Math.abs(r[0] - MARK_MARGIN_PT) < eps || Math.abs(r[0] - (MARK_MARGIN_PT + PAGE_W)) < eps,
      '叠加定位标记时裁剪半区应随版心偏移 8mm');
    assert.ok(Math.abs(r[1] - MARK_MARGIN_PT) < eps);
    assert.ok(Math.abs(r[3] - PAGE_H) < eps);
  }
  const mxs = parseSlotTranslates(mc).map((t) => t.x).sort((a, b) => a - b);
  assert.ok(Math.abs(mxs[0] - (MARK_MARGIN_PT + shiftPt)) < eps);
  assert.ok(Math.abs(mxs[1] - (MARK_MARGIN_PT + PAGE_W - shiftPt)) < eps);
  console.log('✅ 爬移补偿 + 定位标记叠加通过：半区随版心偏移 8mm，内移量保持 0.1mm');

  // ---------- 4. 补白保持空白 ----------
  const paddedBytes = await makePdf(5); // 补 3 白 -> 2 张纸
  // 第 1 张 F[空白|1] B[2|空白]，第 2 张 F[空白|3] B[4|5]
  const paddedPlain = await imposePdf(paddedBytes);
  const paddedCreep = await imposePdf(
    paddedBytes,
    { creepCompensation: true, paperThicknessMm: 0.1 },
  );
  const paddedDoc = await PDFDocument.load(paddedCreep.pdfBytes);
  const expectedDo = [1, 1, 1, 2]; // 各输出页实际绘制的非空白槽位数
  for (let i = 0; i < 4; i += 1) {
    const c = decodePageContent(paddedDoc, i);
    const plain = decodePageContent(await PDFDocument.load(paddedPlain.pdfBytes), i);
    assert.strictEqual(countDo(c), expectedDo[i], `第 ${i + 1} 输出页非空白槽位数`);
    assert.strictEqual(countDo(c), countDo(plain), '补白槽位在爬移前后都不绘制');
  }
  // 第 1 张补偿量 0：补白侧无裁剪路径（空白不参与裁剪/绘制）
  assert.strictEqual(parseClipRects(decodePageContent(paddedDoc, 0)).length, 0);
  assert.strictEqual(parseClipRects(decodePageContent(paddedDoc, 1)).length, 0);
  // 第 2 张：正面只有右页（第 3 页）一个半区裁剪；背面两页都绘制
  assert.strictEqual(parseClipRects(decodePageContent(paddedDoc, 2)).length, 1);
  assert.strictEqual(parseClipRects(decodePageContent(paddedDoc, 3)).length, 2);
  console.log('✅ 补白保持空白通过：补白槽位不绘制也不裁剪，非空白槽位数与未启用时一致');

  // ---------- 5. 未启用时输出保持原样 ----------
  const off = await imposePdf(srcBytes, { creepCompensation: false });
  assert.deepStrictEqual(off.plan.creep, { enabled: false, paperThicknessMm: 0 });
  assert.ok(!('creep' in off.plan.sheets[0]), '未启用时每张纸不写 creep 字段');
  const offDoc = await PDFDocument.load(off.pdfBytes);
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(
      decodePageContent(offDoc, i),
      decodePageContent(await PDFDocument.load((await imposePdf(srcBytes)).pdfBytes), i),
      '未启用爬移时输出内容应与原行为逐字节一致',
    );
  }
  // 启用开关为真但纸厚非法 -> 明确错误
  for (const bad of [undefined, '', '0.01', '0.6', 'abc']) {
    await assert.rejects(
      () => imposePdf(srcBytes, { creepCompensation: true, paperThicknessMm: bad }),
      /纸厚必须是 0\.05～0\.5 mm/,
      `非法纸厚 ${JSON.stringify(bad)} 应被拒绝`,
    );
  }
  console.log('✅ 未启用保持原样通过：方案与输出内容均不变；非法纸厚明确报错');

  // ---------- 6. 分册签帖：各帖补偿分别从零计算 ----------
  const sig13Bytes = await makePdf(13);
  const sigRes = await imposePdf(sig13Bytes, {
    maxSheetsPerSignature: 2,
    creepCompensation: true,
    paperThicknessMm: 0.1,
  });
  assert.deepStrictEqual(
    sigRes.plan.signatures.map((sig) => sig.sheets.map((s) => s.creep.shiftMm)),
    [[0, 0.1], [0, 0.1]],
  );
  const sigDoc = await PDFDocument.load(sigRes.pdfBytes);
  assert.strictEqual(sigDoc.getPageCount(), 8); // 页序/用纸不变
  // 两帖的第 1 张（输出页 0,1 与 4,5）都不平移；第 2 张（2,3 与 6,7）都平移 0.1mm
  for (const idx of [0, 1, 4, 5]) {
    assert.strictEqual(parseClipRects(decodePageContent(sigDoc, idx)).length, 0);
  }
  for (const idx of [2, 3, 6, 7]) {
    const xs = parseSlotTranslates(decodePageContent(sigDoc, idx)).map((t) => t.x).sort((a, b) => a - b);
    // 第二帖存在补白槽位，至少应出现 +0.1mm 的内移
    assert.ok(xs.some((x) => Math.abs(x - shiftPt) < eps)
      || xs.some((x) => Math.abs(x - (PAGE_W - shiftPt)) < eps),
      `输出第 ${idx + 1} 页应含 0.1mm 内移`);
  }
  console.log('✅ 分册签帖爬移通过：两帖各从帖内第 1 张（0mm）重新起算，用纸数与页序不变');

  // ---------- 7. 缺页补印沿用纸厚与选项 ----------
  const tenBytes = await makePdf(10); // 3 张纸，补偿量 0/0.1/0.2
  const { pdfBytes: fullBytes } = await imposePdf(tenBytes, {
    creepCompensation: true,
    paperThicknessMm: 0.1,
  });
  const fullDoc = await PDFDocument.load(fullBytes);

  const { pdfBytes: reprintBytes, reprint } = await reprintPdf(
    tenBytes,
    { creepCompensation: true, paperThicknessMm: 0.1 },
    '2,5-7',
  );
  assert.deepStrictEqual(reprint.creep, { enabled: true, paperThicknessMm: 0.1 });
  assert.deepStrictEqual(reprint.sheets.map((s) => s.sheet), [1, 3]);
  assert.deepStrictEqual(reprint.sheets.map((s) => s.creepShiftMm), [0, 0.2]);
  const reprintDoc = await PDFDocument.load(reprintBytes);
  assert.strictEqual(reprintDoc.getPageCount(), 4);
  // 与完整拼版对应印张（输出页 0,1,4,5）逐页一致：尺寸、平移与裁剪完全相同
  const expectedOrder = [0, 1, 4, 5];
  for (let i = 0; i < expectedOrder.length; i += 1) {
    assert.strictEqual(
      decodePageContent(reprintDoc, i),
      decodePageContent(fullDoc, expectedOrder[i]),
      `补印第 ${i + 1} 页应与完整拼版第 ${expectedOrder[i] + 1} 页一致`,
    );
  }

  // 分册补印：creepShiftMm 按帖内张号标注（命中第 2 帖两张：0 / 0.1）
  const sigReprint = await reprintPdf(
    sig13Bytes,
    { maxSheetsPerSignature: 2, creepCompensation: true, paperThicknessMm: 0.1 },
    '9,12',
  );
  assert.deepStrictEqual(
    sigReprint.reprint.sheets.map((s) => [s.signature, s.sheet, s.creepShiftMm]),
    [[2, 1, 0], [2, 2, 0.1]],
  );

  // 未启用爬移时补印方案记录 disabled、每张补偿量为 0
  const plainReprint = await reprintPdf(tenBytes, {}, '2');
  assert.deepStrictEqual(plainReprint.reprint.creep, { enabled: false, paperThicknessMm: 0 });
  assert.strictEqual(plainReprint.reprint.sheets[0].creepShiftMm, 0);
  console.log('✅ 爬移补印通过：沿用本次纸厚与选项，补印页与完整拼版对应印张逐页一致');

  // ---------- 8. HTTP 接口 ----------
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const boundary = '----creep-boundary';

  function multipart(text, fileData) {
    const chunks = [];
    for (const [name, value] of Object.entries(text || {})) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
    }
    if (fileData) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; `
          + 'filename="sample.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
      ));
      chunks.push(fileData);
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }

  function post(urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(parts),
        }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  try {
    // 8.1 拼版接口透传爬移选项
    const ok = await post('/api/impose', multipart(
      { creepCompensation: 'on', paperThicknessMm: '0.1' },
      Buffer.from(srcBytes),
    ));
    assert.strictEqual(ok.status, 200);
    const okPlan = JSON.parse(decodeURIComponent(ok.headers['x-imposition-plan']));
    assert.deepStrictEqual(okPlan.creep, { enabled: true, paperThicknessMm: 0.1 });
    assert.deepStrictEqual(okPlan.sheets.map((s) => s.creep.shiftMm), [0, 0.1]);
    const okPdf = await PDFDocument.load(ok.body);
    assert.strictEqual(okPdf.getPageCount(), 4);

    // 8.2 未勾选时方案为 disabled，且不含每张 creep 字段
    const offResp = await post('/api/impose', multipart({}, Buffer.from(srcBytes)));
    assert.strictEqual(offResp.status, 200);
    const offPlan = JSON.parse(decodeURIComponent(offResp.headers['x-imposition-plan']));
    assert.strictEqual(offPlan.creep.enabled, false);
    assert.ok(!('creep' in offPlan.sheets[0]));

    // 8.3 非法纸厚 / 勾选但缺纸厚 -> 400 且错误信息明确
    for (const text of [
      { creepCompensation: 'on', paperThicknessMm: '0.01' },
      { creepCompensation: 'on', paperThicknessMm: '0.6' },
      { creepCompensation: 'on', paperThicknessMm: 'abc' },
      { creepCompensation: 'on' },
    ]) {
      const bad = await post('/api/impose', multipart(text, Buffer.from(srcBytes)));
      assert.strictEqual(bad.status, 400, JSON.stringify(text));
      assert.match(JSON.parse(bad.body.toString()).error, /纸厚必须是 0\.05～0\.5 mm/);
    }

    // 8.4 补印接口透传爬移选项并逐张回传补偿量
    const rp = await post('/api/reprint', multipart(
      { pages: '2,5-7', creepCompensation: 'on', paperThicknessMm: '0.1' },
      Buffer.from(tenBytes),
    ));
    assert.strictEqual(rp.status, 200);
    const rpPlan = JSON.parse(decodeURIComponent(rp.headers['x-reprint-plan']));
    assert.deepStrictEqual(rpPlan.creep, { enabled: true, paperThicknessMm: 0.1 });
    assert.deepStrictEqual(rpPlan.sheets.map((s) => s.creepShiftMm), [0, 0.2]);
    assert.strictEqual((await PDFDocument.load(rp.body)).getPageCount(), 4);

    // 补印接口非法纸厚同样 400
    const rpBad = await post('/api/reprint', multipart(
      { pages: '2', creepCompensation: 'on', paperThicknessMm: '0' },
      Buffer.from(tenBytes),
    ));
    assert.strictEqual(rpBad.status, 400);
    assert.match(JSON.parse(rpBad.body.toString()).error, /纸厚必须是 0\.05～0\.5 mm/);

    console.log('✅ HTTP 接口通过：/api/impose 与 /api/reprint 透传爬移选项与逐张补偿量，');
    console.log('   非法/缺失纸厚返回 400 与明确错误，未勾选时方案向后兼容');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
