'use strict';

// HTTP 集成测试：不监听固定端口，直接在 ephemeral 端口上启动 app。
const assert = require('assert');
const http = require('http');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { app } = require('../server');

function multipartBody(fields, boundary) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields.text || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of fields.files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
        + `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request(server, method, urlPath, { body, headers } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: headers || {},
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonRequest(server, urlPath, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return request(server, 'POST', urlPath, {
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    // 构造 5 页问题 PDF：尺寸不一致 + 无文字页 + 非 4 倍数
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i += 1) {
      const p = src.addPage([595.28, 841.89]);
      p.drawText(`PAGE ${i}`, { x: 80, y: 400, size: 24, font, color: rgb(0, 0, 0) });
    }
    const rotated = src.addPage([595.28, 841.89]);
    rotated.setRotation(degrees(180));
    rotated.drawText('ROTATED', { x: 80, y: 400, size: 24, font });
    const pdfBytes = Buffer.from(await src.save());

    // 1. 健康检查
    const health = await request(server, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body.toString()), { ok: true });

    // 2. 印前校验返回 JSON 报告（不返回 PDF），含 180° 错误也仍为 200
    const boundary = '----test-boundary';
    const body = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const preflightResp = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(preflightResp.status, 200);
    assert.ok(!preflightResp.headers['content-type'].includes('pdf'));
    const report = JSON.parse(preflightResp.body.toString());
    assert.strictEqual(report.pageCount, 5);
    assert.strictEqual(report.summary.passed, false);
    assert.ok(report.issues.some((i) => i.code === 'rotated_180' && i.pageFrom === 5));
    assert.ok(report.issues.some((i) => i.code === 'blank_padding'));

    // 3. 缺少文件 -> 400；非 PDF -> 400；垃圾内容 -> 422
    const empty = multipartBody({}, boundary);
    const missing = await request(server, 'POST', '/api/preflight', {
      body: empty,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': empty.length },
    });
    assert.strictEqual(missing.status, 400);

    const txtBody = multipartBody({
      files: [{ field: 'pdf', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') }],
    }, boundary);
    const badType = await request(server, 'POST', '/api/preflight', {
      body: txtBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': txtBody.length },
    });
    assert.strictEqual(badType.status, 400);

    const garbageBody = multipartBody({
      files: [{ field: 'pdf', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') }],
    }, boundary);
    const garbage = await request(server, 'POST', '/api/preflight', {
      body: garbageBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': garbageBody.length },
    });
    assert.strictEqual(garbage.status, 422);
    assert.match(JSON.parse(garbage.body.toString()).error, /无法校验/);

    // ---------- 批量印前校验 /api/preflight/batch ----------
    // 8 页干净 PDF（有文字、无旋转、4 的倍数），批量校验中应通过
    const batchDoc = await PDFDocument.create();
    const batchFont = await batchDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 8; i += 1) {
      batchDoc.addPage([595.28, 841.89]).drawText(`OK ${i}`, {
        x: 80, y: 400, size: 24, font: batchFont,
      });
    }
    const batchCleanBytes = Buffer.from(await batchDoc.save());

    // 3 个文件混合：正常 PDF（8 页无问题）、损坏 PDF、非 PDF（.txt）；
    // 按上传顺序逐个校验，坏文件只记录自身失败，不阻断其他文件。
    const batchBoundary = '----batch-boundary';
    const batchBody = multipartBody({
      files: [
        { field: 'pdfs', filename: 'good-8p.pdf', contentType: 'application/pdf', data: batchCleanBytes },
        { field: 'pdfs', filename: 'broken.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') },
        { field: 'pdfs', filename: 'note.txt', contentType: 'text/plain', data: Buffer.from('not a pdf') },
      ],
    }, batchBoundary);
    const batchResp = await request(server, 'POST', '/api/preflight/batch', {
      body: batchBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': batchBody.length,
      },
    });
    assert.strictEqual(batchResp.status, 200);
    const batch = JSON.parse(batchResp.body.toString());
    assert.strictEqual(batch.kind, 'preflight-batch');
    assert.strictEqual(batch.limit, 10);
    assert.strictEqual(batch.summary.total, 3);
    assert.strictEqual(batch.summary.completed, 1);
    assert.strictEqual(batch.summary.failed, 2);
    assert.strictEqual(batch.summary.passed, 1);
    assert.strictEqual(batch.summary.allPassed, false);

    assert.strictEqual(batch.files.length, 3);
    assert.strictEqual(batch.files[0].index, 0);
    assert.strictEqual(batch.files[0].status, 'completed');
    assert.strictEqual(batch.files[0].passed, true);
    assert.strictEqual(batch.files[0].pageCount, 8);
    assert.strictEqual(batch.files[0].file.name, 'good-8p.pdf');
    assert.ok(batch.files[0].report && Array.isArray(batch.files[0].report.issues));

    assert.strictEqual(batch.files[1].status, 'failed');
    assert.strictEqual(batch.files[1].errorCode, 'invalid_pdf');
    assert.match(batch.files[1].error, /PDF/);
    assert.strictEqual(batch.files[1].report, null);

    assert.strictEqual(batch.files[2].status, 'failed');
    assert.strictEqual(batch.files[2].errorCode, 'not_pdf');

    // 批量报告含交付放行判定：成功文件 release=passed；坏文件 undetermined；
    // 整批因坏文件且无阻断 → undetermined（优先级 blocked > undetermined > review > passed）
    assert.strictEqual(batch.files[0].release.decision, 'passed');
    assert.deepStrictEqual(batch.files[0].release.actionCounts, { block: 0, warn: 0, ignore: 0 });
    assert.strictEqual(batch.files[1].release.decision, 'undetermined');
    assert.strictEqual(batch.files[2].release.decision, 'undetermined');
    assert.strictEqual(batch.summary.release.decision, 'undetermined');
    assert.strictEqual(batch.summary.release.passed, 1);
    assert.strictEqual(batch.summary.release.undetermined, 2);
    assert.ok(batch.releasePolicy && Array.isArray(batch.releasePolicy.rules));
    assert.strictEqual(batch.releasePolicy.rules.length, 6);
    // issueTotals 每代码带处置字段（默认来源）
    for (const total of batch.issueTotals) {
      assert.ok(['block', 'warn', 'ignore'].includes(total.action));
      assert.strictEqual(total.actionSource, 'default');
    }

    // 全部为坏文件时仍返回 200，逐个记录原因
    const allBadBody = multipartBody({
      files: [
        { field: 'pdfs', filename: 'a.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-x') },
        { field: 'pdfs', filename: 'empty.pdf', contentType: 'application/pdf', data: Buffer.alloc(0) },
      ],
    }, batchBoundary);
    const allBad = await request(server, 'POST', '/api/preflight/batch', {
      body: allBadBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': allBadBody.length,
      },
    });
    assert.strictEqual(allBad.status, 200);
    const allBadJson = JSON.parse(allBad.body.toString());
    assert.strictEqual(allBadJson.summary.completed, 0);
    assert.strictEqual(allBadJson.summary.failed, 2);
    assert.strictEqual(allBadJson.files[1].errorCode, 'not_pdf');

    // 含问题代码汇总：上传两个带 180° 旋转错误的文件（同一 PDF 用不同文件名），
    // rotated_180 应计 2 次、涉及 2 个文件，blank_padding 同理
    const twoBadPdfsBody = multipartBody({
      files: [
        { field: 'pdfs', filename: 'copy-1.pdf', contentType: 'application/pdf', data: pdfBytes },
        { field: 'pdfs', filename: 'copy-2.pdf', contentType: 'application/pdf', data: pdfBytes },
      ],
    }, batchBoundary);
    const twoBadPdfs = await request(server, 'POST', '/api/preflight/batch', {
      body: twoBadPdfsBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': twoBadPdfsBody.length,
      },
    });
    assert.strictEqual(twoBadPdfs.status, 200);
    const twoBadJson = JSON.parse(twoBadPdfs.body.toString());
    assert.strictEqual(twoBadJson.summary.completed, 2);
    assert.strictEqual(twoBadJson.summary.passed, 0);
    assert.strictEqual(twoBadJson.summary.error, 2);
    const rot180 = twoBadJson.issueTotals.find((t) => t.code === 'rotated_180');
    assert.ok(rot180, 'issueTotals 应包含 rotated_180');
    assert.strictEqual(rot180.count, 2);
    assert.strictEqual(rot180.fileCount, 2);
    assert.deepStrictEqual(rot180.files.map((f) => f.index), [0, 1]);
    assert.deepStrictEqual(rot180.files.map((f) => f.name), ['copy-1.pdf', 'copy-2.pdf']);
    // 汇总按级别排序：错误（rotated_180）在提示（blank_padding）之前
    assert.strictEqual(twoBadJson.issueTotals[0].code, 'rotated_180');

    // 默认策略下错误阻断：两个文件 release=blocked，整批 blocked；
    // 但检测维度 summary.passed 仍为 0（passed 含义不随放行策略改变）
    assert.strictEqual(twoBadJson.files[0].release.decision, 'blocked');
    assert.strictEqual(twoBadJson.files[1].release.decision, 'blocked');
    assert.strictEqual(twoBadJson.summary.release.decision, 'blocked');
    assert.strictEqual(twoBadJson.summary.release.blocked, 2);
    const default180 = twoBadJson.issueTotals.find((t) => t.code === 'rotated_180');
    assert.strictEqual(default180.action, 'block');
    assert.strictEqual(default180.actionSource, 'default');

    // 自定义放行策略：把 rotated_180（错误）改为 ignore → 两文件均放行（剩余仅提示）
    const policyBody = multipartBody({
      text: { releasePolicy: JSON.stringify({ rotated_180: 'ignore' }) },
      files: [
        { field: 'pdfs', filename: 'copy-1.pdf', contentType: 'application/pdf', data: pdfBytes },
        { field: 'pdfs', filename: 'copy-2.pdf', contentType: 'application/pdf', data: pdfBytes },
      ],
    }, batchBoundary);
    const policyResp = await request(server, 'POST', '/api/preflight/batch', {
      body: policyBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': policyBody.length,
      },
    });
    assert.strictEqual(policyResp.status, 200);
    const policyJson = JSON.parse(policyResp.body.toString());
    assert.strictEqual(policyJson.files[0].release.decision, 'passed');
    assert.strictEqual(policyJson.files[0].passed, false, '检测 passed 不受策略影响，仍为 false');
    assert.strictEqual(policyJson.summary.release.decision, 'passed');
    assert.strictEqual(policyJson.releasePolicy.custom.rotated_180, 'ignore');
    const custom180 = policyJson.issueTotals.find((t) => t.code === 'rotated_180');
    assert.strictEqual(custom180.action, 'ignore');
    assert.strictEqual(custom180.actionSource, 'custom');

    // 非法策略（未知代码）→ 400，不执行校验
    const badPolicyBody = multipartBody({
      text: { releasePolicy: JSON.stringify({ unknown_code: 'block' }) },
      files: [
        { field: 'pdfs', filename: 'copy-1.pdf', contentType: 'application/pdf', data: pdfBytes },
      ],
    }, batchBoundary);
    const badPolicyResp = await request(server, 'POST', '/api/preflight/batch', {
      body: badPolicyBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': badPolicyBody.length,
      },
    });
    assert.strictEqual(badPolicyResp.status, 400);
    assert.match(JSON.parse(badPolicyResp.body.toString()).error, /放行策略/);

    // 非法策略（处置值不合法 / 非 JSON 字符串）→ 400
    for (const badPolicy of [
      JSON.stringify({ rotated_180: 'reject' }),
      'not-a-json',
    ]) {
      const bpBody = multipartBody({
        text: { releasePolicy: badPolicy },
        files: [
          { field: 'pdfs', filename: 'copy-1.pdf', contentType: 'application/pdf', data: pdfBytes },
        ],
      }, batchBoundary);
      const bpResp = await request(server, 'POST', '/api/preflight/batch', {
        body: bpBody,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
          'Content-Length': bpBody.length,
        },
      });
      assert.strictEqual(bpResp.status, 400);
    }

    // 缺少文件 -> 400
    const batchEmpty = multipartBody({}, batchBoundary);
    const batchMissing = await request(server, 'POST', '/api/preflight/batch', {
      body: batchEmpty,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': batchEmpty.length,
      },
    });
    assert.strictEqual(batchMissing.status, 400);
    assert.match(JSON.parse(batchMissing.body.toString()).error, /pdfs/);

    // 超过 10 个 -> 400
    const eleven = multipartBody({
      files: Array.from({ length: 11 }, (_, i) => ({
        field: 'pdfs',
        filename: `f${i}.pdf`,
        contentType: 'application/pdf',
        data: batchCleanBytes,
      })),
    }, batchBoundary);
    const tooManyBatch = await request(server, 'POST', '/api/preflight/batch', {
      body: eleven,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': eleven.length,
      },
    });
    assert.strictEqual(tooManyBatch.status, 400);
    assert.match(JSON.parse(tooManyBatch.body.toString()).error, /1～10 个/);

    // 批量接口不影响单文件接口（再次调用仍 200）
    const batchSingleStillOk = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(batchSingleStillOk.status, 200);

    // ---------- 印前报告差异对比 ----------
    // 基准 5 页：第 5 页 180° 旋转（错误）+ 非 4 倍数补白
    const base = await PDFDocument.create();
    const baseFont = await base.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i += 1) {
      base.addPage([595.28, 841.89]).drawText(`BASE ${i}`, {
        x: 80, y: 400, size: 24, font: baseFont,
      });
    }
    const baseRot = base.addPage([595.28, 841.89]);
    baseRot.setRotation(degrees(180));
    baseRot.drawText('BASE 5', { x: 80, y: 400, size: 24, font: baseFont });
    const baseBytes = Buffer.from(await base.save());

    // 待交付 8 页：全部正常无旋转（问题全部解决，补白提示也消失），新增 3 页
    const finalDoc = await PDFDocument.create();
    const finalFont = await finalDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 8; i += 1) {
      finalDoc.addPage([595.28, 841.89]).drawText(`FINAL ${i}`, {
        x: 80, y: 400, size: 24, font: finalFont,
      });
    }
    const finalBytes = Buffer.from(await finalDoc.save());

    // 5. 正常对比 -> 200，180° 与补白均已解决，页数 5 -> 8
    const diffBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const diffResp = await request(server, 'POST', '/api/preflight/diff', {
      body: diffBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': diffBody.length },
    });
    assert.strictEqual(diffResp.status, 200);
    const diff = JSON.parse(diffResp.body.toString());
    assert.strictEqual(diff.kind, 'preflight-diff');
    assert.strictEqual(diff.pageCount.baseline, 5);
    assert.strictEqual(diff.pageCount.delivery, 8);
    assert.deepStrictEqual(diff.pageCount.addedPages, [6, 7, 8]);
    assert.ok(diff.resolved.some((e) => e.code === 'rotated_180'));
    assert.ok(diff.resolved.some((e) => e.code === 'blank_padding' && e.documentLevel));
    assert.strictEqual(diff.added.length, 0);
    assert.strictEqual(diff.persistent.length, 0);
    assert.strictEqual(diff.baseline.file.name, 'base.pdf');
    assert.strictEqual(diff.delivery.file.name, 'final.pdf');

    // 同一份 PDF 自比：三个分组为空、页数不变
    const selfBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'f.pdf', contentType: 'application/pdf', data: finalBytes },
        { field: 'delivery', filename: 'f.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const selfResp = await request(server, 'POST', '/api/preflight/diff', {
      body: selfBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': selfBody.length },
    });
    assert.strictEqual(selfResp.status, 200);
    const selfDiff = JSON.parse(selfResp.body.toString());
    assert.strictEqual(selfDiff.added.length, 0);
    assert.strictEqual(selfDiff.resolved.length, 0);
    assert.strictEqual(selfDiff.persistent.length, 0);
    assert.strictEqual(selfDiff.pageCount.delta, 0);

    // 6. 缺少任一字段 -> 400
    const oneOnlyBody = multipartBody({
      files: [{ field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes }],
    }, boundary);
    const oneOnly = await request(server, 'POST', '/api/preflight/diff', {
      body: oneOnlyBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': oneOnlyBody.length },
    });
    assert.strictEqual(oneOnly.status, 400);
    assert.match(JSON.parse(oneOnly.body.toString()).error, /baseline/);

    // 基准为非 PDF（.txt）-> 400
    const txtDiffBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const txtDiff = await request(server, 'POST', '/api/preflight/diff', {
      body: txtDiffBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': txtDiffBody.length },
    });
    assert.strictEqual(txtDiff.status, 400);
    assert.match(JSON.parse(txtDiff.body.toString()).error, /基准/);

    // 基准损坏 -> 422 且错误标明「基准」
    const brokenBaseBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'bad.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const brokenBase = await request(server, 'POST', '/api/preflight/diff', {
      body: brokenBaseBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': brokenBaseBody.length },
    });
    assert.strictEqual(brokenBase.status, 422);
    assert.match(JSON.parse(brokenBase.body.toString()).error, /基准 PDF 无法校验/);

    // 待交付损坏 -> 422 且错误标明「待交付」
    const brokenFinalBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes },
        { field: 'delivery', filename: 'bad.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') },
      ],
    }, boundary);
    const brokenFinal = await request(server, 'POST', '/api/preflight/diff', {
      body: brokenFinalBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': brokenFinalBody.length },
    });
    assert.strictEqual(brokenFinal.status, 422);
    assert.match(JSON.parse(brokenFinal.body.toString()).error, /待交付 PDF 无法校验/);

    // 7. 对比接口的使用不影响单文件校验（再次调用仍 200）
    const recheck = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(recheck.status, 200);

    // 4. 校验失败/有错误不阻断：同一文件仍可拼版，返回 application/pdf
    const imposeBody = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const imposeResp = await request(server, 'POST', '/api/impose', {
      body: imposeBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': imposeBody.length },
    });
    assert.strictEqual(imposeResp.status, 200);
    assert.ok(imposeResp.headers['content-type'].includes('application/pdf'));
    assert.ok(imposeResp.headers['x-imposition-plan']);
    const imposedPdf = await PDFDocument.load(imposeResp.body);
    // 5 页 -> 补 3 白 -> 8 面板 -> 2 张纸 -> 4 个输出页
    assert.strictEqual(imposedPdf.getPageCount(), 4);

    // ---------- 印刷用纸报价 /api/quote ----------
    // 5 页 -> 补白到 8 -> 2 张纸；A4 竖版面展开 420 × 297 mm
    const panel = { width: 595.2756, height: 841.8898, orientation: 'portrait' };
    const quotePlan = {
      sheets: [{ sheet: 1 }, { sheet: 2 }],
      sourceCount: 5, paddedCount: 3, totalCount: 8, blanks: 3,
      panel,
    };

    // 正常报价：A3 与 B2，选最低总价；A3 原向容纳（420×297），B2 更便宜
    const quoteResp = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [
        { name: 'A3 铜版', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
        { name: 'B2 胶版', widthMm: 500, heightMm: 707, pricePerSheet: 0.5, setupFee: 30 },
      ],
    });
    assert.strictEqual(quoteResp.status, 200);
    const quote = JSON.parse(quoteResp.body.toString());
    assert.strictEqual(quote.kind, 'paper-quote');
    assert.strictEqual(quote.feasible, true);
    assert.strictEqual(quote.selected.name, 'B2 胶版');
    assert.strictEqual(quote.selected.totalCost, 31);
    assert.strictEqual(quote.layout.sheetCount, 2);
    assert.strictEqual(quote.layout.runCount, 1);
    assert.ok(Math.abs(quote.layout.sheet.widthMm - 420) < 0.01);
    assert.ok(Math.abs(quote.layout.sheet.heightMm - 297) < 0.01);

    // 无纸张可容纳：HTTP 200 + feasible=false + 明确原因
    const noFitResp = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [{ name: 'A4', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 }],
    });
    assert.strictEqual(noFitResp.status, 200);
    const noFit = JSON.parse(noFitResp.body.toString());
    assert.strictEqual(noFit.feasible, false);
    assert.strictEqual(noFit.selected, null);
    assert.strictEqual(noFit.reasonCode, 'no_fitting_paper');
    assert.match(noFit.reason, /A4/);
    assert.strictEqual(noFit.options[0].fits, false);

    // 签帖方案：开机次数 = 帖数（3 帖 → 开机费 ×3）
    const sigQuoteResp = await jsonRequest(server, '/api/quote', {
      plan: {
        signatureMode: true,
        signatures: [
          { signature: 1, sheets: [{ sheet: 1 }] },
          { signature: 2, sheets: [{ sheet: 1 }] },
          { signature: 3, sheets: [{ sheet: 1 }] },
        ],
        sheetCount: 3, signatureCount: 3, panel,
      },
      papers: [{ name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 }],
    });
    assert.strictEqual(sigQuoteResp.status, 200);
    const sigQuote = JSON.parse(sigQuoteResp.body.toString());
    assert.strictEqual(sigQuote.layout.runCount, 3);
    assert.strictEqual(sigQuote.selected.setupCost, 150);
    assert.strictEqual(sigQuote.selected.totalCost, 153);

    // 参数错误 -> 400
    const missingPlan = await jsonRequest(server, '/api/quote', {
      papers: [{ widthMm: 420, heightMm: 297 }],
    });
    assert.strictEqual(missingPlan.status, 400);
    assert.match(JSON.parse(missingPlan.body.toString()).error, /plan/);

    const missingPapers = await jsonRequest(server, '/api/quote', { plan: quotePlan });
    assert.strictEqual(missingPapers.status, 400);
    assert.match(JSON.parse(missingPapers.body.toString()).error, /papers/);

    const emptyPapers = await jsonRequest(server, '/api/quote', { plan: quotePlan, papers: [] });
    assert.strictEqual(emptyPapers.status, 400);
    assert.match(JSON.parse(emptyPapers.body.toString()).error, /至少维护一种/);

    const badPaper = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [{ name: '坏', widthMm: -1, heightMm: 297 }],
    });
    assert.strictEqual(badPaper.status, 400);
    assert.match(JSON.parse(badPaper.body.toString()).error, /宽必须是大于 0/);

    // 超过 8 种纸张 -> 400
    const tooMany = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: Array(9).fill({ widthMm: 420, heightMm: 297 }),
    });
    assert.strictEqual(tooMany.status, 400);
    assert.match(JSON.parse(tooMany.body.toString()).error, /最多维护 8 种/);

    // 非法 JSON body -> 400
    const badJsonRaw = Buffer.from('{not-json');
    const badJson = await request(server, 'POST', '/api/quote', {
      body: badJsonRaw,
      headers: { 'Content-Type': 'application/json', 'Content-Length': badJsonRaw.length },
    });
    assert.strictEqual(badJson.status, 400);
    assert.match(JSON.parse(badJson.body.toString()).error, /JSON/);

    // ---------- 批量裁切下料 /api/cutting ----------
    // A4 竖版展开印张 420 × 297 mm：A3 恰好出 1 个，大度对开出 8 个
    const cuttingResp = await jsonRequest(server, '/api/cutting', {
      plan: quotePlan,
      papers: [
        { name: 'A3 铜版', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
        { name: '大度对开', widthMm: 889, heightMm: 1194, pricePerSheet: 2, setupFee: 0 },
        { name: 'A4 太小', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 },
      ],
      requiredSheets: 100,
    });
    assert.strictEqual(cuttingResp.status, 200);
    const cutting = JSON.parse(cuttingResp.body.toString());
    assert.strictEqual(cutting.kind, 'sheet-cutting-plan');
    assert.strictEqual(cutting.requiredSheets, 100);
    assert.strictEqual(cutting.feasible, true);
    assert.strictEqual(cutting.recommended.name, '大度对开');

    const cutA3 = cutting.options[0];
    assert.strictEqual(cutA3.yieldsPerSheet, 1);
    assert.strictEqual(cutA3.sheetsRequired, 100);
    assert.strictEqual(cutA3.waste.perSheetAreaMm2, 0);
    assert.strictEqual(cutA3.cutting.items.length, 1);
    assert.strictEqual(cutA3.cutting.cuts.length, 0);

    const cutBig = cutting.options[1];
    assert.strictEqual(cutBig.yieldsPerSheet, 8);
    assert.strictEqual(cutBig.sheetsRequired, 13);
    assert.strictEqual(cutBig.lastSheet.fullSheets, 12);
    assert.strictEqual(cutBig.lastSheet.lastSheetYield, 4);
    assert.strictEqual(cutBig.lastSheet.spareCapacity, 4);
    assert.strictEqual(cutBig.cutting.items.length, 8);
    assert.ok(cutBig.cutting.cuts.length >= 1);
    // 裁切图数据：所有印张都在原纸范围内、尺寸为印张原向或旋转 90°
    for (const it of cutBig.cutting.items) {
      assert.ok(it.xMm + it.widthMm <= 889.01 && it.yMm + it.heightMm <= 1194.01);
      const dims = it.rotated
        ? [297, 420]
        : [420, 297];
      assert.ok(Math.abs(it.widthMm - dims[0]) < 0.01 && Math.abs(it.heightMm - dims[1]) < 0.01);
    }

    // 全部原纸都放不下：HTTP 200 + feasible=false + 明确原因
    const cutNoFitResp = await jsonRequest(server, '/api/cutting', {
      plan: quotePlan,
      papers: [{ name: 'A4', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 }],
      requiredSheets: 5,
    });
    assert.strictEqual(cutNoFitResp.status, 200);
    const cutNoFit = JSON.parse(cutNoFitResp.body.toString());
    assert.strictEqual(cutNoFit.feasible, false);
    assert.strictEqual(cutNoFit.recommended, null);
    assert.strictEqual(cutNoFit.reasonCode, 'no_fitting_paper');
    assert.match(cutNoFit.reason, /A4/);
    assert.strictEqual(cutNoFit.options[0].feasible, false);
    assert.strictEqual(cutNoFit.options[0].reasons.length, 2);

    // 参数错误 -> 400
    const cutNoPlan = await jsonRequest(server, '/api/cutting', {
      papers: [{ widthMm: 420, heightMm: 297 }], requiredSheets: 1,
    });
    assert.strictEqual(cutNoPlan.status, 400);
    assert.match(JSON.parse(cutNoPlan.body.toString()).error, /plan/);

    const cutNoPapers = await jsonRequest(server, '/api/cutting', {
      plan: quotePlan, requiredSheets: 1,
    });
    assert.strictEqual(cutNoPapers.status, 400);
    assert.match(JSON.parse(cutNoPapers.body.toString()).error, /papers/);

    const cutNoQty = await jsonRequest(server, '/api/cutting', {
      plan: quotePlan, papers: [{ widthMm: 420, heightMm: 297 }],
    });
    assert.strictEqual(cutNoQty.status, 400);
    assert.match(JSON.parse(cutNoQty.body.toString()).error, /requiredSheets/);

    for (const badQty of [0, -1, 1.5, 'abc', null]) {
      const bad = await jsonRequest(server, '/api/cutting', {
        plan: quotePlan,
        papers: [{ widthMm: 420, heightMm: 297, pricePerSheet: 0, setupFee: 0 }],
        requiredSheets: badQty,
      });
      assert.strictEqual(bad.status, 400, `数量 ${JSON.stringify(badQty)} 应返回 400`);
      assert.match(JSON.parse(bad.body.toString()).error, /所需印张数/);
    }

    const cutBadPaper = await jsonRequest(server, '/api/cutting', {
      plan: quotePlan,
      papers: [{ widthMm: -1, heightMm: 297, pricePerSheet: 0, setupFee: 0 }],
      requiredSheets: 1,
    });
    assert.strictEqual(cutBadPaper.status, 400);
    assert.match(JSON.parse(cutBadPaper.body.toString()).error, /宽必须是大于 0/);

    // 裁切接口不影响报价接口（再次调用报价仍 200）
    const quoteStillOk = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [{ name: 'A3 铜版', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 }],
    });
    assert.strictEqual(quoteStillOk.status, 200);

    // ---------- 印张定位标记 /api/impose?registrationMarks=on ----------
    // 5 页 A4：启用后输出页 = (2×595.28+2×8mm) × (841.89+2×8mm)，方案记录实际印张宽高
    const MM8_PT = 8 * (72 / 25.4);
    const marksBody = multipartBody({
      text: { registrationMarks: 'on' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const marksResp = await request(server, 'POST', '/api/impose', {
      body: marksBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': marksBody.length,
      },
    });
    assert.strictEqual(marksResp.status, 200);
    assert.ok(marksResp.headers['content-type'].includes('application/pdf'));
    const marksPlan = JSON.parse(decodeURIComponent(marksResp.headers['x-imposition-plan']));
    assert.strictEqual(marksPlan.marks.enabled, true);
    assert.strictEqual(marksPlan.marks.marginMm, 8);
    assert.ok(Math.abs(marksPlan.sheet.width - (595.28 * 2 + 2 * MM8_PT)) < 0.01);
    assert.ok(Math.abs(marksPlan.sheet.height - (841.89 + 2 * MM8_PT)) < 0.01);
    const markedPdf = await PDFDocument.load(marksResp.body);
    assert.strictEqual(markedPdf.getPageCount(), 4); // 页数/页序与未启用一致
    assert.ok(Math.abs(markedPdf.getPage(0).getWidth() - (595.28 * 2 + 2 * MM8_PT)) < 0.5);
    assert.ok(Math.abs(markedPdf.getPage(0).getHeight() - (841.89 + 2 * MM8_PT)) < 0.5);

    // 未勾选（前面上文 imposeResp）：方案记录原印张尺寸，标记为未启用
    const plainImposePlan = JSON.parse(decodeURIComponent(imposeResp.headers['x-imposition-plan']));
    assert.strictEqual(plainImposePlan.marks.enabled, false);
    assert.ok(Math.abs(plainImposePlan.sheet.width - 595.28 * 2) < 0.01);
    assert.ok(Math.abs(plainImposePlan.sheet.height - 841.89) < 0.01);

    // 报价按实际印张宽高：启用标记后印张 436×313mm，A3（420×297）两个方向均放不下
    const marksQuoteResp = await jsonRequest(server, '/api/quote', {
      plan: marksPlan,
      papers: [{ name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 }],
    });
    assert.strictEqual(marksQuoteResp.status, 200);
    const marksQuote = JSON.parse(marksQuoteResp.body.toString());
    assert.strictEqual(marksQuote.feasible, false);
    assert.strictEqual(marksQuote.reasonCode, 'no_fitting_paper');
    assert.ok(Math.abs(marksQuote.layout.sheet.widthMm - (2 * 210 + 16)) < 0.05);
    assert.ok(Math.abs(marksQuote.layout.sheet.heightMm - (297 + 16)) < 0.05);

    // 同一文件未勾选时报价结果保持原样：A3 恰好容纳 420×297 印张
    const plainQuoteResp = await jsonRequest(server, '/api/quote', {
      plan: plainImposePlan,
      papers: [{ name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 }],
    });
    assert.strictEqual(plainQuoteResp.status, 200);
    const plainQuote = JSON.parse(plainQuoteResp.body.toString());
    assert.strictEqual(plainQuote.feasible, true);
    assert.ok(Math.abs(plainQuote.layout.sheet.widthMm - 420) < 0.05);
    assert.ok(Math.abs(plainQuote.layout.sheet.heightMm - 297) < 0.05);

    // ---------- 缺页补印 /api/reprint ----------
    // 5 页文档 -> 补 3 白 -> 2 张纸：第1张 F[空白|1] B[2|空白]，第2张 F[空白|3] B[4|5]
    const reprintBody = multipartBody({
      text: { pages: '2,5' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const reprintResp = await request(server, 'POST', '/api/reprint', {
      body: reprintBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': reprintBody.length,
      },
    });
    assert.strictEqual(reprintResp.status, 200);
    assert.ok(reprintResp.headers['content-type'].includes('application/pdf'));
    assert.ok(reprintResp.headers['x-reprint-plan']);
    const reprintPlan = JSON.parse(decodeURIComponent(reprintResp.headers['x-reprint-plan']));
    assert.strictEqual(reprintPlan.kind, 'reprint-plan');
    assert.deepStrictEqual(reprintPlan.pages, [2, 5]);
    assert.strictEqual(reprintPlan.sheetCount, 2);
    assert.strictEqual(reprintPlan.pageCount, 4);
    assert.strictEqual(reprintPlan.signatureMode, false);
    assert.deepStrictEqual(reprintPlan.sheets.map((s) => s.sheet), [1, 2]);
    assert.deepStrictEqual(reprintPlan.sheets[0].hitPages, [2]);
    assert.deepStrictEqual(reprintPlan.sheets[1].hitPages, [5]);
    const reprintPdfDoc = await PDFDocument.load(reprintResp.body);
    assert.strictEqual(reprintPdfDoc.getPageCount(), 4, '2 张补印纸 -> 4 个输出页');
    // 保留原印张尺寸（未启用定位标记：2 × 面板宽 × 面板高）
    assert.ok(Math.abs(reprintPdfDoc.getPage(0).getWidth() - 595.28 * 2) < 0.5);
    assert.ok(Math.abs(reprintPdfDoc.getPage(0).getHeight() - 841.89) < 0.5);

    // 同一印张命中多页只补印一次：第 1、2 页同在第 1 张纸
    const sameSheetBody = multipartBody({
      text: { pages: '1,2' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const sameSheetResp = await request(server, 'POST', '/api/reprint', {
      body: sameSheetBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': sameSheetBody.length,
      },
    });
    assert.strictEqual(sameSheetResp.status, 200);
    const sameSheetPlan = JSON.parse(decodeURIComponent(sameSheetResp.headers['x-reprint-plan']));
    assert.strictEqual(sameSheetPlan.sheetCount, 1, '同一印张命中多页只补印一次');
    assert.deepStrictEqual(sameSheetPlan.sheets[0].hitPages, [1, 2]);
    assert.strictEqual((await PDFDocument.load(sameSheetResp.body)).getPageCount(), 2);

    // 分册签帖：每帖 1 张（容量 4 页）-> 第1帖页 1-4（输出页 1-2）、第2帖页 5（输出页 3-4）
    const sigReprintBody = multipartBody({
      text: { pages: '5', signatureMode: 'on', maxSheetsPerSignature: '1' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const sigReprintResp = await request(server, 'POST', '/api/reprint', {
      body: sigReprintBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': sigReprintBody.length,
      },
    });
    assert.strictEqual(sigReprintResp.status, 200);
    const sigReprintPlan = JSON.parse(decodeURIComponent(sigReprintResp.headers['x-reprint-plan']));
    assert.strictEqual(sigReprintPlan.signatureMode, true);
    assert.strictEqual(sigReprintPlan.sheetCount, 1);
    assert.strictEqual(sigReprintPlan.sheets[0].signature, 2);
    assert.strictEqual(sigReprintPlan.sheets[0].sheet, 1);
    assert.deepStrictEqual(sigReprintPlan.sheets[0].hitPages, [5]);
    assert.deepStrictEqual(sigReprintPlan.sheets[0].outputPages, [3, 4], '累计第 1 帖的输出页偏移');
    assert.strictEqual((await PDFDocument.load(sigReprintResp.body)).getPageCount(), 2);

    // 启用定位标记：补印印张保留 8mm 空白边距后的尺寸
    const marksReprintBody = multipartBody({
      text: { pages: '2', registrationMarks: 'on' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const marksReprintResp = await request(server, 'POST', '/api/reprint', {
      body: marksReprintBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': marksReprintBody.length,
      },
    });
    assert.strictEqual(marksReprintResp.status, 200);
    const marksReprintDoc = await PDFDocument.load(marksReprintResp.body);
    assert.strictEqual(marksReprintDoc.getPageCount(), 2);
    assert.ok(Math.abs(marksReprintDoc.getPage(0).getWidth() - (595.28 * 2 + 2 * MM8_PT)) < 0.5);
    assert.ok(Math.abs(marksReprintDoc.getPage(0).getHeight() - (841.89 + 2 * MM8_PT)) < 0.5);

    // 缺少 pages 字段 / 空输入 -> 400
    const noPagesBody = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const noPagesResp = await request(server, 'POST', '/api/reprint', {
      body: noPagesBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': noPagesBody.length,
      },
    });
    assert.strictEqual(noPagesResp.status, 400);
    assert.match(JSON.parse(noPagesResp.body.toString()).error, /请输入需要补印的原稿页码/);

    const emptyPagesBody = multipartBody({
      text: { pages: '   ' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const emptyPagesResp = await request(server, 'POST', '/api/reprint', {
      body: emptyPagesBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': emptyPagesBody.length,
      },
    });
    assert.strictEqual(emptyPagesResp.status, 400);
    assert.match(JSON.parse(emptyPagesResp.body.toString()).error, /请输入需要补印的原稿页码/);

    // 格式错误 -> 400
    const badPagesBody = multipartBody({
      text: { pages: 'abc' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const badPagesResp = await request(server, 'POST', '/api/reprint', {
      body: badPagesBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': badPagesBody.length,
      },
    });
    assert.strictEqual(badPagesResp.status, 400);
    assert.match(JSON.parse(badPagesResp.body.toString()).error, /格式错误/);

    // 越界页码（5 页文档）-> 400
    const outOfRangeBody = multipartBody({
      text: { pages: '9' },
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const outOfRangeResp = await request(server, 'POST', '/api/reprint', {
      body: outOfRangeBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': outOfRangeBody.length,
      },
    });
    assert.strictEqual(outOfRangeResp.status, 400);
    assert.match(JSON.parse(outOfRangeResp.body.toString()).error, /超出原稿页码范围（1～5）/);

    // 缺少文件 -> 400；非 PDF -> 400；损坏 PDF -> 422
    const reprintNoFileBody = multipartBody({ text: { pages: '2' } }, boundary);
    const reprintNoFile = await request(server, 'POST', '/api/reprint', {
      body: reprintNoFileBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': reprintNoFileBody.length,
      },
    });
    assert.strictEqual(reprintNoFile.status, 400);

    const reprintTxtBody = multipartBody({
      text: { pages: '2' },
      files: [{ field: 'pdf', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') }],
    }, boundary);
    const reprintTxt = await request(server, 'POST', '/api/reprint', {
      body: reprintTxtBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': reprintTxtBody.length,
      },
    });
    assert.strictEqual(reprintTxt.status, 400);

    const reprintGarbageBody = multipartBody({
      text: { pages: '2' },
      files: [{ field: 'pdf', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') }],
    }, boundary);
    const reprintGarbage = await request(server, 'POST', '/api/reprint', {
      body: reprintGarbageBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': reprintGarbageBody.length,
      },
    });
    assert.strictEqual(reprintGarbage.status, 422);

    // 补印接口不影响拼版接口（再次调用仍 200）
    const imposeStillOk = await request(server, 'POST', '/api/impose', {
      body: imposeBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': imposeBody.length,
      },
    });
    assert.strictEqual(imposeStillOk.status, 200);

    console.log('✅ HTTP 集成测试通过：preflight 200 返回 JSON（含错误不阻断），缺文件 400，');
    console.log('   非 PDF 400，损坏文件 422；同一份带错误报告的 PDF 仍可成功 /api/impose；');
    console.log('   批量校验 /api/preflight/batch：坏文件不阻断好文件、按代码汇总、缺文件/超 10 个 400、');
    console.log('   交付放行策略（自定义覆盖 200、非法策略 400）与逐文件/整批放行判定');
    console.log('   缺页补印 /api/reprint：命中定位与成对抽取 200、同张只补一次、分册偏移、');
    console.log('   定位标记尺寸保留；空输入/格式错误/越界 400，缺文件/非 PDF 400，损坏 422');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
