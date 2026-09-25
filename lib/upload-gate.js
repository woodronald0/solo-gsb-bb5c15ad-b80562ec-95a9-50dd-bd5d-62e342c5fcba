'use strict';

/**
 * 上传资源闸门：作用于所有接收 PDF 上传的 multipart 接口
 * （单文件校验 / 批量校验 / 差异对比 / 拼版 / 补印），在请求进入 multer
 * 解析之前统一准入，包含两道独立防线：
 *
 * 1. 全局并发名额：同时处理的上传请求数达到上限时，立即返回
 *    503 + Retry-After，不进入解析。名额从准入一直占用到响应结束
 *    （res finish）或连接断开（res close），解析失败、校验失败、
 *    客户端中途断开等任何结局都会释放。被拒请求未读取的body由
 *    Node 服务器在响应结束后自动丢弃（req._dump），连接保持可用。
 *
 * 2. 单请求总上传字节上限：按实际接收到的字节逐个 data 事件累计
 *    （与 Content-Length 无关，因此无 Content-Length 的 chunked
 *    分块传输同样生效），超过上限立即返回 413 并断开 multer 解析；
 *    随后继续接收并丢弃剩余上传数据（lingering drain），保证客户端
 *    能完整收到 413 响应而不是连接重置。该限制与 multer 的单文件
 *    大小限制（LIMIT_FILE_SIZE）相互独立、同时生效：单文件超限仍由
 *    multer 按原逻辑拒绝。
 */

const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
// 503 时建议客户端多少秒后重试（Retry-After 响应头）
const RETRY_AFTER_SECONDS = 2;

function formatMb(bytes) {
  const mb = bytes / 1024 / 1024;
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/**
 * 创建上传闸门中间件。
 * @param {object} options
 * @param {number} options.maxConcurrent 全局并发名额（>0 的整数）
 * @param {number} options.maxTotalBytes 单请求总上传字节上限（>0 的整数）
 * @returns {function} Express 中间件；挂载 .activeUploads() 便于观测当前占用
 */
function createUploadGate({ maxConcurrent, maxTotalBytes } = {}) {
  const limit = Number.isInteger(maxConcurrent) && maxConcurrent > 0
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT_UPLOADS;
  const maxBytes = Number.isInteger(maxTotalBytes) && maxTotalBytes > 0
    ? maxTotalBytes
    : DEFAULT_MAX_TOTAL_UPLOAD_BYTES;

  let active = 0;

  // 停止解析并丢弃剩余上传数据：解除与 multer/busboy 的管道后让请求
  // 保持流动模式，后续 body 字节收到即弃，客户端得以正常发完并收到响应
  function drainRequest(req, onData) {
    req.removeListener('data', onData);
    req.unpipe();
    req.resume();
  }

  function uploadGate(req, res, next) {
    // —— 第一道：并发名额。满员时不读请求体，立即拒绝 ——
    if (active >= limit) {
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      return res.status(503).json({
        error: `上传服务繁忙（同时最多处理 ${limit} 个上传请求），请稍后重试`,
      });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    // 名额占用至响应结束或连接断开：正常响应（含解析失败后的错误响应）
    // 触发 finish；客户端中途断开连接触发 close。两者取先到者，只释放一次。
    res.on('finish', release);
    res.on('close', release);

    // —— 第二道：按实际接收字节累计的单请求总上传量上限 ——
    let received = 0;
    let rejected = false;
    const onData = (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received <= maxBytes) return;
      rejected = true;
      drainRequest(req, onData);
      // 响应可能已被下游（如 multer 单文件超限）先行发出，此时不再重复写响应
      if (res.headersSent || res.writableEnded) return;
      res.status(413).json({
        error: `上传总量超过大小限制（${formatMb(maxBytes)}MB）`,
      });
    };
    req.on('data', onData);

    return next();
  }

  // 供测试/运维观测当前占用的名额数
  uploadGate.activeUploads = () => active;
  uploadGate.limits = { maxConcurrent: limit, maxTotalBytes: maxBytes };
  return uploadGate;
}

module.exports = {
  createUploadGate,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_MAX_TOTAL_UPLOAD_BYTES,
  RETRY_AFTER_SECONDS,
};
