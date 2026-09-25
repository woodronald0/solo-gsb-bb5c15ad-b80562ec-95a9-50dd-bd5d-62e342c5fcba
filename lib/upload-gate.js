'use strict';

// PDF 上传接口的统一资源闸门，覆盖单文件校验、批量校验、差异对比、拼版、补印
// 五个 multipart 接口，在请求进入 multer 之前生效：
//
// 1) 全局并发准入：忙时在进入 multer 前立即拒绝（503 + Retry-After），不解析请求体；
//    名额一直占用到响应结束（finish）或连接断开（close），multer 解析失败/抛错同样释放。
// 2) 实际上传总量计数：按「实际接收到的请求体字节」累计（multipart 分帧字节一并计入）。
//    带 Content-Length 且超限的请求直接拒绝；无 Content-Length 的分块传输（chunked）
//    则随接收随计数，超限立即切断通向 multer/busboy 的管道并返回 413，
//    避免 memoryStorage 继续把超大文件读入内存。

const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const DEFAULT_MAX_TOTAL_UPLOAD_SIZE_MB = 100;

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function createUploadGate(options = {}) {
  const maxConcurrentUploads = parsePositiveInt(
    options.maxConcurrentUploads ?? process.env.UPLOAD_MAX_CONCURRENT,
    DEFAULT_MAX_CONCURRENT_UPLOADS,
  );
  const retryAfterSeconds = parsePositiveInt(
    options.retryAfterSeconds ?? process.env.UPLOAD_RETRY_AFTER_SECONDS,
    DEFAULT_RETRY_AFTER_SECONDS,
  );
  const maxTotalUploadBytes = parsePositiveInt(
    options.maxTotalUploadMb ?? process.env.MAX_TOTAL_UPLOAD_SIZE_MB,
    DEFAULT_MAX_TOTAL_UPLOAD_SIZE_MB,
  ) * 1024 * 1024;

  let activeUploads = 0;

  // 并发闸门：占住一个全局名额直到响应结束或连接断开
  function concurrencyGate(req, res, next) {
    if (activeUploads >= maxConcurrentUploads) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(503).json({
        error: `上传处理繁忙（并发处理上限 ${maxConcurrentUploads} 个），请 ${retryAfterSeconds} 秒后重试`,
        retryAfterSeconds,
      });
      // 已拒绝的请求不再读取 body；响应发出后断开连接，避免继续接收上传流量
      res.on('finish', () => req.destroy());
      return;
    }

    activeUploads += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploads -= 1;
    };
    // finish：响应正常/异常结束；close：连接中途断开。二者均须释放，
    // 因此包括 multer 解析失败（413/400/500）在内的任何结局都不会泄漏名额
    res.once('finish', release);
    res.once('close', release);
    next();
  }

  // 总上传量闸门：按实际接收字节计数，兼容 chunked
  function totalBytesGate(req, res, next) {
    let rejected = false;

    const rejectTooLarge = () => {
      if (rejected) return;
      rejected = true;
      // 移除计数监听器后 unpipe：此时 req 上不再有 data 监听器，
      // unpipe 会同步 pause 请求流，busboy 与 memoryStorage 都收不到后续字节
      req.removeListener('data', countBytes);
      req.unpipe();
      if (!res.headersSent) {
        const limitMb = maxTotalUploadBytes / 1024 / 1024;
        res.status(413).json({
          error: `本次上传总量超过限制（上限 ${limitMb}MB，含表单与分帧字节）`,
        });
      }
      // 响应刷出后销毁请求，彻底回收被挂起的 multer/busboy
      res.on('finish', () => req.destroy());
    };

    // 快速路径：Content-Length 已明确超限时，一个字节都不必读取
    const declaredLength = Number.parseInt(req.headers['content-length'], 10);
    if (Number.isInteger(declaredLength) && declaredLength > maxTotalUploadBytes) {
      rejectTooLarge();
      return;
    }

    // 慢路径：chunked 等无 Content-Length 场景，按实际接收字节累计
    let receivedBytes = 0;
    function countBytes(chunk) {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxTotalUploadBytes) {
        rejectTooLarge();
      }
    }
    req.on('data', countBytes);
    next();
  }

  return {
    // 供路由按序挂载：先并发准入，再总量计数，最后才是 multer
    uploadGate: [concurrencyGate, totalBytesGate],
    concurrencyGate,
    totalBytesGate,
    get activeUploads() {
      return activeUploads;
    },
    maxConcurrentUploads,
    retryAfterSeconds,
    maxTotalUploadBytes,
  };
}

module.exports = {
  createUploadGate,
  parsePositiveInt,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_RETRY_AFTER_SECONDS,
  DEFAULT_MAX_TOTAL_UPLOAD_SIZE_MB,
};
