'use strict';

// 上传资源闸门测试：全局并发名额（503 + Retry-After、名额占用至响应结束或
// 连接断开、解析失败也释放）与单请求总上传字节上限（按实际接收字节累计，
// 含无 Content-Length 的 chunked 传输，超限 413）；同时验证既有单文件大小
// 限制与批量逐文件失败隔离不受影响。
// 注意：环境变量必须在 require server 之前设置（配置在加载时读取）。
process.env.MAX_CONCURRENT_UPLOADS = '1';
process.env.MAX_TOTAL_UPLOAD_MB = '2';
process.env.MAX_FILE_SIZE_MB = '1';

const assert = require('assert');
const http = require('http');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { app, uploadGate } = require('../server');

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
    let gotResponse = false;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: headers || {},
    }, (res) => {
      gotResponse = true;
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    // 服务器 413 后会销毁 socket 中断上传；已拿到响应时忽略后续写错误
    req.on('error', (err) => { if (!gotResponse) reject(err); });
    if (body) req.write(body);
    req.end();
  });
}

// 发起一个不带 Content-Length 的 POST（Node 自动使用 chunked 分块编码），
// 返回 req 句柄与响应 Promise，调用方可自行控制写入节奏或中途断开
function startChunkedRequest(server, urlPath, headers = {}) {
  const { port } = server.address();
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method: 'POST',
    headers,
  });
  let gotResponse = false;
  const response = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      gotResponse = true;
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    // 服务器 413 后会销毁 socket 中断上传；已拿到响应时忽略后续写错误
    req.on('error', (err) => { if (!gotResponse) reject(err); });
  });
  return { req, response };
}

async function waitFor(cond, label, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const gateReleased = () => uploadGate.activeUploads() === 0;

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    assert.strictEqual(uploadGate.limits.maxConcurrent, 1);
    assert.strictEqual(uploadGate.limits.maxTotalBytes, 2 * 1024 * 1024);

    // 1 页正常 PDF（远小于 1MB 单文件上限与 2MB 总量上限）
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText('GATE', { x: 80, y: 400, size: 24, font });
    const pdfBytes = Buffer.from(await doc.save());

    const boundary = '----gate-boundary';
    const smallBody = multipartBody({
      files: [{ field: 'pdf', filename: 'ok.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const multipartHeaders = (body) => ({
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    });

    // 1. 正常小文件不受闸门影响 -> 200
    const ok = await request(server, 'POST', '/api/preflight', {
      body: smallBody,
      headers: multipartHeaders(smallBody),
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body.toString()).pageCount, 1);
    await waitFor(gateReleased, '正常响应后名额释放');

    // 2. 既有单文件大小限制保留：1.5MB 单文件（< 2MB 总量上限）-> 413 单文件提示
    const bigFileBody = multipartBody({
      files: [{
        field: 'pdf',
        filename: 'big.pdf',
        contentType: 'application/pdf',
        data: Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 'a'),
      }],
    }, boundary);
    const tooBigFile = await request(server, 'POST', '/api/preflight', {
      body: bigFileBody,
      headers: multipartHeaders(bigFileBody),
    });
    assert.strictEqual(tooBigFile.status, 413);
    assert.match(JSON.parse(tooBigFile.body.toString()).error, /文件超过大小限制（1MB）/);
    await waitFor(gateReleased, '单文件超限响应后名额释放');

    // 3. 总量上限（带 Content-Length）：批量 3 × 0.9MB（单文件均 < 1MB，
    //    合计约 2.7MB > 2MB）-> 413 总量提示，而非单文件提示
    const batchBoundary = '----gate-batch';
    const batchBigBody = multipartBody({
      files: [0, 1, 2].map((i) => ({
        field: 'pdfs',
        filename: `part-${i}.pdf`,
        contentType: 'application/pdf',
        data: Buffer.alloc(Math.floor(0.9 * 1024 * 1024), 'b'),
      })),
    }, batchBoundary);
    assert.ok(batchBigBody.length > 2 * 1024 * 1024);
    const tooBigTotal = await request(server, 'POST', '/api/preflight/batch', {
      body: batchBigBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
        'Content-Length': batchBigBody.length,
      },
    });
    assert.strictEqual(tooBigTotal.status, 413);
    assert.match(JSON.parse(tooBigTotal.body.toString()).error, /上传总量超过大小限制（2MB）/);
    await waitFor(gateReleased, '总量超限响应后名额释放');

    // 4. 总量上限对无 Content-Length 的 chunked 分块传输同样生效 -> 413
    const chunked = startChunkedRequest(server, '/api/preflight/batch', {
      'Content-Type': `multipart/form-data; boundary=${batchBoundary}`,
    });
    await new Promise((resolve) => {
      let offset = 0;
      const timer = setInterval(() => {
        if (chunked.req.destroyed || !chunked.req.writable) {
          clearInterval(timer);
          return resolve();
        }
        const end = Math.min(offset + 64 * 1024, batchBigBody.length);
        chunked.req.write(batchBigBody.subarray(offset, end));
        offset = end;
        if (offset >= batchBigBody.length) {
          clearInterval(timer);
          chunked.req.end();
          resolve();
        }
      }, 2);
    });
    const chunkedResp = await chunked.response;
    assert.strictEqual(chunkedResp.status, 413);
    assert.match(JSON.parse(chunkedResp.body.toString()).error, /上传总量超过大小限制（2MB）/);
    await waitFor(gateReleased, 'chunked 总量超限响应后名额释放');

    // 5. 并发名额：占用唯一名额的慢请求未完成时，新上传立即 503 + Retry-After；
    //    非上传接口（健康检查、JSON 报价）不受闸门限制
    const hold = startChunkedRequest(server, '/api/preflight', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
    hold.req.flushHeaders(); // 只发请求头，先不写 body：闸门在进 multer 前已占名额
    await waitFor(() => uploadGate.activeUploads() === 1, '慢请求占用名额');

    const busy = await request(server, 'POST', '/api/preflight', {
      body: smallBody,
      headers: multipartHeaders(smallBody),
    });
    assert.strictEqual(busy.status, 503);
    assert.strictEqual(busy.headers['retry-after'], '2');
    assert.match(JSON.parse(busy.body.toString()).error, /繁忙/);

    const healthWhileBusy = await request(server, 'GET', '/api/health');
    assert.strictEqual(healthWhileBusy.status, 200);
    const quoteWhileBusy = await request(server, 'POST', '/api/quote', {
      body: Buffer.from('{}'),
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    });
    assert.strictEqual(quoteWhileBusy.status, 400, 'JSON 接口不受上传闸门限制');

    // 慢请求补完 body 后正常完成 -> 200，名额随之释放，后续上传恢复
    hold.req.end(smallBody);
    const holdResp = await hold.response;
    assert.strictEqual(holdResp.status, 200);
    await waitFor(gateReleased, '慢请求完成后名额释放');

    const afterRelease = await request(server, 'POST', '/api/preflight', {
      body: smallBody,
      headers: multipartHeaders(smallBody),
    });
    assert.strictEqual(afterRelease.status, 200);
    await waitFor(gateReleased, '名额复用后释放');

    // 6. 客户端中途断开连接：名额同样释放
    const abort = startChunkedRequest(server, '/api/preflight', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
    // 断开后该请求不会有响应，忽略其 Promise 拒绝（socket hang up）
    abort.response.catch(() => {});
    abort.req.flushHeaders();
    await waitFor(() => uploadGate.activeUploads() === 1, '断开前名额被占用');
    abort.req.destroy();
    await waitFor(gateReleased, '连接断开后名额释放');

    // 7. multipart 解析失败（boundary 不匹配）：返回错误响应后名额也释放
    const garbageBody = Buffer.from('this is not multipart content at all');
    const parseFail = await request(server, 'POST', '/api/preflight', {
      body: garbageBody,
      headers: {
        'Content-Type': 'multipart/form-data; boundary=----no-such-boundary',
        'Content-Length': garbageBody.length,
      },
    });
    assert.strictEqual(parseFail.status, 500);
    await waitFor(gateReleased, '解析失败响应后名额释放');

    // 8. 闸门经历各类拒绝后仍正常工作
    const finalOk = await request(server, 'POST', '/api/preflight', {
      body: smallBody,
      headers: multipartHeaders(smallBody),
    });
    assert.strictEqual(finalOk.status, 200);
    await waitFor(gateReleased, '最终名额释放');

    console.log('✅ 上传资源闸门测试通过：并发满员 503 + Retry-After，名额占用至响应结束/连接断开，');
    console.log('   解析失败同样释放；总量上限按实际接收字节累计（含 chunked）超限 413；');
    console.log('   单文件大小限制保留（413 单文件提示），非上传接口不受闸门限制');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
