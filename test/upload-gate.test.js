'use strict';

// 统一资源闸门集成测试：以极小限额把子进程方式启动真实 HTTP 服务，验证
// 1) 全局并发上限：占满后五个上传接口均在解析前返回 503 + Retry-After，
//    名额在响应结束/连接断开（含解析失败）后释放；
// 2) 总上传量按实际接收字节计数：Content-Length 超限与 chunked 超限均 413；
// 3) 既有单文件大小限制与逐文件行为保留；
// 4) /api/health 等非上传接口不受闸门限制。
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const ROUTES = ['/api/preflight', '/api/preflight/batch', '/api/preflight/diff', '/api/impose', '/api/reprint'];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时\n${stderr}`)), 5000);
    child.stdout.on('data', function onData(d) {
      if (d.toString().includes('已启动')) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 code=${code}\n${stderr}`));
    });
  });
  return { child, port };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

// 读取完整 HTTP/1.1 响应；响应已完整到达后的 socket 错误（RST/EPIPE）一律忽略
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let parsed = null;
    let settled = false;
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      if (err) reject(err);
      else resolve(value);
    };
    function parseHead() {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return null;
      const lines = buf.slice(0, idx).toString().split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > -1) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return { status, headers, headerEnd: idx + 4 };
    }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!parsed) parsed = parseHead();
      if (!parsed) return;
      const len = Number(parsed.headers['content-length']);
      // 带 Content-Length：读满即返回（响应可能保持 keep-alive，连接未必关闭）
      if (Number.isFinite(len) && buf.length >= parsed.headerEnd + len) {
        finish({
          status: parsed.status,
          headers: parsed.headers,
          body: buf.slice(parsed.headerEnd, parsed.headerEnd + len),
        });
      }
    }
    function onClose() {
      if (!parsed) parsed = parseHead();
      if (parsed) {
        // 服务器以连接关闭界定响应体时也接受
        finish({
          status: parsed.status,
          headers: parsed.headers,
          body: buf.slice(parsed.headerEnd),
        });
      } else {
        finish(null, new Error('响应到达前连接已关闭'));
      }
    }
    function onError(err) {
      finish(null, err);
    }
    socket.on('error', onError);
    socket.on('data', onData);
    socket.on('close', onClose);
  });
}

function requestHead(method, urlPath, headers) {
  const lines = [`${method} ${urlPath} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// 分块写入 body；服务器提前拒绝（413/503 后断连）时静默结束
function writeAll(socket, body, chunkSize = 16384) {
  return new Promise((resolve) => {
    let off = 0;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        socket.removeListener('close', finish);
        socket.removeListener('error', finish);
        resolve();
      }
    };
    socket.on('close', finish);
    socket.on('error', finish);
    function step() {
      if (done) return;
      if (off >= body.length) {
        socket.end();
        finish();
        return;
      }
      const part = body.slice(off, Math.min(off + chunkSize, body.length));
      off += part.length;
      if (socket.write(part)) setImmediate(step);
      else socket.once('drain', step);
    }
    step();
  });
}

async function send(port, urlPath, body, headers, method = 'POST') {
  const socket = await connect(port);
  const allHeaders = method === 'GET'
    ? headers
    : { 'Content-Length': body.length, ...headers };
  socket.write(requestHead(method, urlPath, allHeaders));
  const writing = method === 'GET' ? Promise.resolve() : writeAll(socket, body);
  const resp = await readResponse(socket);
  await writing;
  socket.destroy();
  return resp;
}

// 只发请求头（声明 Content-Length 但不发送 body），用于读取前置拒绝
async function sendHeadersOnly(port, urlPath, headers, method = 'POST') {
  const socket = await connect(port);
  socket.write(requestHead(method, urlPath, headers));
  const resp = await readResponse(socket);
  socket.destroy();
  return resp;
}

function multipartPdf(data, boundary = '----gate-boundary', field = 'pdf', filename = 'sample.pdf') {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; `
      + `filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

// 以 chunked 分块传输持续发送字节，直到服务器返回响应（用于无 Content-Length 总量计数）
function sendChunkedUntilResponse(port, urlPath, totalBytes) {
  return new Promise((resolve, reject) => {
    (async () => {
      const socket = await connect(port);
      socket.on('error', () => {});
      socket.write(requestHead('POST', urlPath, {
        'Content-Type': 'multipart/form-data; boundary=----gate-boundary',
        'Transfer-Encoding': 'chunked',
      }));
      const reader = readResponse(socket).then(
        (resp) => ({ resp }),
        (err) => ({ err }),
      );
      let settled = false;
      reader.then((r) => { settled = true; if (!r.err) resolve(r.resp); else reject(r.err); socket.destroy(); });

      const chunk = Buffer.alloc(64 * 1024, 0x58);
      let sent = 0;
      const tick = () => new Promise((r) => setImmediate(r));
      while (sent < totalBytes && !settled) {
        const head = Buffer.from(`${chunk.length.toString(16)}\r\n`);
        socket.write(head);
        const ok = socket.write(chunk);
        socket.write('\r\n');
        sent += chunk.length;
        if (!ok) await new Promise((r) => socket.once('drain', r));
        else await tick();
      }
    })().catch(reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 服务 A：并发 2、Retry-After 2s、总上传量 1MB、单文件 50MB ----
  const serverA = await startServer({
    UPLOAD_MAX_CONCURRENT: '2',
    UPLOAD_RETRY_AFTER_SECONDS: '2',
    MAX_TOTAL_UPLOAD_SIZE_MB: '1',
    MAX_FILE_SIZE_MB: '50',
  });
  const portA = serverA.port;

  try {
    const smallDoc = await PDFDocument.create();
    smallDoc.addPage([595.28, 841.89]);
    const smallPdf = Buffer.from(await smallDoc.save());
    const boundary = '----gate-boundary';
    const smallBody = multipartPdf(smallPdf, boundary);
    const mpHeaders = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    // 差异对比接口只接受 baseline/delivery 字段；占用连接发其合法前缀（不发完，
    // multer 持续等待后续字节），避免意外字段触发 LIMIT_UNEXPECTED_FILE
    const diffHoldBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="baseline"; `
        + `filename="base.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      smallPdf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="delivery"; `
        + `filename="final.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      smallPdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    // 0. 健康检查不受闸门限制
    const health = await send(portA, '/api/health', Buffer.alloc(0), {}, 'GET');
    assert.strictEqual(health.status, 200);

    // 1. 两个请求占住并发名额：只发头等待解析开始，再发部分 body 且不发完，
    //    multer 会一直等待后续字节，响应不结束、名额不释放
    const hold1 = await connect(portA);
    hold1.on('error', () => {});
    hold1.write(requestHead('POST', '/api/preflight', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': smallBody.length,
    }));

    const hold2 = await connect(portA);
    hold2.on('error', () => {});
    hold2.write(requestHead('POST', '/api/preflight/diff', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': diffHoldBody.length,
    }));
    await sleep(200);
    hold1.write(smallBody.slice(0, 200));
    hold2.write(diffHoldBody.slice(0, 200));
    await sleep(200);

    // 2. 名额占满期间 /api/health 仍可响应
    const healthBusy = await send(portA, '/api/health', Buffer.alloc(0), {}, 'GET');
    assert.strictEqual(healthBusy.status, 200, '健康检查不受上传并发闸门限制');

    // 3. 五个上传接口全部在进入 multer 前返回 503 + Retry-After
    for (const route of ROUTES) {
      const resp = await send(portA, route, smallBody, mpHeaders);
      assert.strictEqual(resp.status, 503, `${route} 忙时应返回 503`);
      assert.strictEqual(resp.headers['retry-after'], '2', `${route} 应带 Retry-After: 2`);
      const json = JSON.parse(resp.body.toString());
      assert.strictEqual(json.retryAfterSeconds, 2);
      assert.match(json.error, /繁忙/);
    }

    // 4. 完成其中一个占用中的请求 -> 200，名额释放，新请求可进入
    hold1.end(smallBody.slice(200));
    const finished1 = await readResponse(hold1);
    assert.strictEqual(finished1.status, 200);
    hold1.destroy();

    const freedResp = await send(portA, '/api/preflight', smallBody, mpHeaders);
    assert.strictEqual(freedResp.status, 200, '响应结束后名额应释放');

    // 5. 客户端中途断开 -> 名额也必须释放（解析未完成/失败不泄漏）
    hold2.destroy();
    await sleep(250);
    const afterAbort = await send(portA, '/api/preflight', smallBody, mpHeaders);
    assert.strictEqual(afterAbort.status, 200, '连接断开后名额应释放');

    // 6. Content-Length 明确超限：五个接口都在读取前返回 413
    for (const route of ROUTES) {
      const resp = await sendHeadersOnly(portA, route, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': 2 * 1024 * 1024,
      });
      assert.strictEqual(resp.status, 413, `${route} Content-Length 超限应返回 413`);
      assert.match(JSON.parse(resp.body.toString()).error, /上传总量/);
    }

    // 7. 无 Content-Length 的 chunked 传输：按实际接收字节计数，超限 413
    const chunkedResp = await sendChunkedUntilResponse(portA, '/api/preflight', 3 * 1024 * 1024);
    assert.strictEqual(chunkedResp.status, 413, 'chunked 传输实际上传量超限应 413');
    assert.match(JSON.parse(chunkedResp.body.toString()).error, /上传总量/);

    // 8. 413 拒绝同样释放并发名额
    const after413 = await send(portA, '/api/preflight', smallBody, mpHeaders);
    assert.strictEqual(after413.status, 200, '总量超限拒绝后名额应释放');

    const chunkedBatch = await sendChunkedUntilResponse(portA, '/api/preflight/batch', 3 * 1024 * 1024);
    assert.strictEqual(chunkedBatch.status, 413, '批量接口 chunked 超限也应 413');

    // 9. 限额以下的请求正常处理（总量限制不影响正常上传）
    const okResp = await send(portA, '/api/preflight', smallBody, mpHeaders);
    assert.strictEqual(okResp.status, 200);

    // ---- 服务 B：单文件 1MB、总上传量 50MB：验证既有单文件限制保留 ----
    const serverB = await startServer({
      UPLOAD_MAX_CONCURRENT: '4',
      MAX_TOTAL_UPLOAD_SIZE_MB: '50',
      MAX_FILE_SIZE_MB: '1',
    });
    const portB = serverB.port;
    try {
      // 10. 单文件超 50MB 总量远未到，应由 multer 按单文件限制拒绝 413
      const bigFile = multipartPdf(Buffer.alloc(2 * 1024 * 1024, 0x41), boundary, 'pdf', 'big.pdf');
      const bigResp = await send(
        portB,
        '/api/preflight',
        bigFile,
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      );
      assert.strictEqual(bigResp.status, 413, '单文件超 MAX_FILE_SIZE_MB 仍应 413');
      assert.match(JSON.parse(bigResp.body.toString()).error, /文件超过大小限制（1MB）/);

      // 11. 单文件拒绝后服务与名额均正常
      const stillOk = await send(
        portB,
        '/api/preflight',
        multipartPdf(smallPdf, boundary),
        mpHeaders,
      );
      assert.strictEqual(stillOk.status, 200);
    } finally {
      serverB.child.kill();
    }

    console.log('✅ 统一资源闸门测试通过：五个上传接口忙时 503 + Retry-After（解析前置），');
    console.log('   响应结束/连接断开/解析失败均释放名额；总上传量按实际字节计数，');
    console.log('   Content-Length 与 chunked 超限均 413；单文件大小限制与 health 豁免保留');
  } finally {
    serverA.child.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
