'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { imposePdf, parseMaxSheetsPerSignature, parsePaperThicknessMm } = require('./lib/impose');
const { reprintPdf, ReprintInputError } = require('./lib/reprint');
const { preflightPdf } = require('./lib/preflight');
const {
  preflightPdfBatch,
  looksLikePdf: bufferLooksLikePdf,
  normalizeReleasePolicy,
  BATCH_PREFLIGHT_MAX_FILES,
} = require('./lib/preflight-batch');
const { diffPreflightReports } = require('./lib/preflight-diff');
const { buildPaperQuote } = require('./lib/quote');
const { buildCuttingPlan } = require('./lib/cutting');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024
  || 50 * 1024 * 1024;

// 上传文件仅保留在内存中（拼版后直接返回，不写磁盘）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

app.use(express.static(path.join(__dirname, 'public')));

// 报价接口仅接收拼版方案 + 纸张规格的 JSON（无文件上传）
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * 判断上传内容是否为 PDF：以 PDF 文件头魔数为准；部分浏览器以
 * application/octet-stream 上传时，回退校验文件名后缀。
 */
function looksLikePdf(file) {
  return bufferLooksLikePdf(file.buffer, file.originalname, file.mimetype);
}

function missingFileResponse(res) {
  return res.status(400).json({ error: '请通过字段 pdf 上传一个 PDF 文件' });
}

/**
 * 从 multipart 表单读取拼版选项：分册签帖、印张定位标记、骑马钉爬移补偿。
 * 与 /api/impose、/api/reprint 完全一致；任一字段非法时抛出带明确信息的
 * Error（HTTP 层统一按 400 返回）。
 * @param {object} body req.body
 * @returns {object} imposePdf / reprintPdf 使用的选项对象
 */
function readImposeOptions(body) {
  const options = {};
  if (body && body.signatureMode === 'on') {
    options.maxSheetsPerSignature =
      parseMaxSheetsPerSignature(body.maxSheetsPerSignature);
  }
  if (body && body.registrationMarks === 'on') {
    options.registrationMarks = true;
  }
  if (body && body.creepCompensation === 'on') {
    // 启用爬移补偿时纸厚必填且必须为 0.05～0.5 mm
    options.creepCompensation = true;
    options.paperThicknessMm = parsePaperThicknessMm(body.paperThicknessMm);
  }
  return options;
}

// 印前校验接口：仅逐页检查并返回 JSON 报告，不生成拼版文件。
// 报告中即便存在错误/警告也以 200 返回（校验结果本身），不阻断后续拼版。
app.post('/api/preflight', upload.single('pdf'), async (req, res) => {
  if (!req.file) return missingFileResponse(res);
  if (!looksLikePdf(req.file)) {
    return res.status(400).json({ error: '仅支持 PDF 文件' });
  }
  try {
    const report = await preflightPdf(req.file.buffer, {
      fileName: req.file.originalname,
      sizeBytes: req.file.size,
    });
    return res.json(report);
  } catch (err) {
    return res.status(422).json({
      error: `无法校验该 PDF：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 批量印前校验：multipart 字段 pdfs 一次接收 1～10 个 PDF，按上传顺序逐个
// 复用单文件校验。单个文件缺失/为空、非 PDF、损坏或加密时只在该文件结果中
// 记录失败原因（status=failed + errorCode/error），不阻断其他文件；
// 只要批量请求本身可解析就整体返回 200（含部分或全部文件失败的情况）。
const batchUpload = upload.array('pdfs', BATCH_PREFLIGHT_MAX_FILES);

app.post('/api/preflight/batch', (req, res) => {
  batchUpload(req, res, (err) => {
    if (err) {
      // multer .array() 超过 maxCount 或出现其他文件字段时都会抛
      // LIMIT_UNEXPECTED_FILE；LIMIT_FILE_COUNT 为 busboy 全局文件数上限，
      // 一并按「数量/字段不合法」返回 400
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          error: `请通过字段 pdfs 上传 1～${BATCH_PREFLIGHT_MAX_FILES} 个 PDF 文件`,
        });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）`,
        });
      }
      return res.status(500).json({ error: '上传解析失败' });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        error: `请通过字段 pdfs 上传 1～${BATCH_PREFLIGHT_MAX_FILES} 个 PDF 文件`,
      });
    }

    // 可选字段 releasePolicy：按问题代码覆盖放行处置（block/warn/ignore），
    // JSON 对象或其字符串形式；缺省时代码按严重级别取默认处置。非法策略 400。
    let releasePolicy;
    try {
      releasePolicy = normalizeReleasePolicy(req.body && req.body.releasePolicy);
    } catch (err) {
      return res.status(400).json({
        error: `放行策略无效：${err && err.message ? err.message : '未知错误'}`,
      });
    }

    preflightPdfBatch(files, { releasePolicy })
      .then((report) => res.json(report))
      .catch((batchErr) => res.status(500).json({
        error: `批量校验失败：${batchErr && batchErr.message ? batchErr.message : '未知错误'}`,
      }));
  });
});

// 印前报告差异对比：分别上传基准 PDF 与待交付 PDF，复用逐页校验后按
// 「页码 + 问题代码」对齐，返回新增/已解决/仍存在问题及页数变化。
// 任一文件缺失或非 PDF 返回 400；任一 PDF 损坏/加密返回 422 并标明是哪一份。
const diffUpload = upload.fields([
  { name: 'baseline', maxCount: 1 },
  { name: 'delivery', maxCount: 1 },
]);

app.post('/api/preflight/diff', diffUpload, async (req, res) => {
  const files = req.files || {};
  const baselineFile = files.baseline && files.baseline[0];
  const deliveryFile = files.delivery && files.delivery[0];
  if (!baselineFile || !deliveryFile) {
    return res.status(400).json({
      error: '请通过字段 baseline（基准 PDF）与 delivery（待交付 PDF）各上传一个 PDF 文件',
    });
  }
  if (!looksLikePdf(baselineFile)) {
    return res.status(400).json({ error: '基准文件仅支持 PDF 格式' });
  }
  if (!looksLikePdf(deliveryFile)) {
    return res.status(400).json({ error: '待交付文件仅支持 PDF 格式' });
  }

  // 两份文件分别校验：损坏/加密时在错误信息中标明具体是哪一份，便于定位
  let baselineReport;
  let deliveryReport;
  try {
    baselineReport = await preflightPdf(baselineFile.buffer, {
      fileName: baselineFile.originalname,
      sizeBytes: baselineFile.size,
    });
  } catch (err) {
    return res.status(422).json({
      error: `基准 PDF 无法校验：${err && err.message ? err.message : '未知错误'}`,
    });
  }
  try {
    deliveryReport = await preflightPdf(deliveryFile.buffer, {
      fileName: deliveryFile.originalname,
      sizeBytes: deliveryFile.size,
    });
  } catch (err) {
    return res.status(422).json({
      error: `待交付 PDF 无法校验：${err && err.message ? err.message : '未知错误'}`,
    });
  }

  try {
    const diff = diffPreflightReports(baselineReport, deliveryReport);
    return res.json(diff);
  } catch (err) {
    return res.status(422).json({
      error: `差异对比失败：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 拼版接口：上传 PDF，返回拼版后的 PDF；拼版页序方案通过响应头回传
app.post('/api/impose', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return missingFileResponse(res);
    }
    if (!looksLikePdf(req.file)) {
      return res.status(400).json({ error: '仅支持 PDF 文件' });
    }

    // 拼版选项：分册签帖 + 印张定位标记 + 骑马钉爬移补偿
    let options;
    try {
      options = readImposeOptions(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { pdfBytes, plan } = await imposePdf(req.file.buffer, options);

    // 页序方案为纯 ASCII JSON，放入自定义响应头供前端渲染预览
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="booklet-imposed.pdf"');
    res.setHeader('X-Imposition-Plan', encodeURIComponent(JSON.stringify(plan)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Imposition-Plan');
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    const message = err && err.message ? err.message : '拼版失败';
    // 加密 PDF、损坏文件、超大文件等都返回 422，便于前端提示
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    return res.status(422).json({ error: `无法处理该 PDF：${message}` });
  }
});

// 缺页补印接口：上传原 PDF + 受损页码表达式（字段 pages，如 "2,5-7"），
// 按与 /api/impose 相同的拼版选项复用拼版方案，定位受损页所在印张后
// 成对抽取正背面生成补印 PDF；补印明细通过响应头 X-Reprint-Plan 回传。
// 空输入、格式错误、越界页码等输入问题返回 400；损坏/加密 PDF 返回 422。
app.post('/api/reprint', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return missingFileResponse(res);
    }
    if (!looksLikePdf(req.file)) {
      return res.status(400).json({ error: '仅支持 PDF 文件' });
    }

    // 拼版选项与 /api/impose 完全一致：分册签帖 + 定位标记 + 爬移补偿
    let options;
    try {
      options = readImposeOptions(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { pdfBytes, reprint } = await reprintPdf(
      req.file.buffer,
      options,
      req.body ? req.body.pages : undefined,
    );

    // 补印明细为纯 ASCII JSON，放入自定义响应头供前端渲染命中列表
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="booklet-reprint.pdf"');
    res.setHeader('X-Reprint-Plan', encodeURIComponent(JSON.stringify(reprint)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Reprint-Plan');
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    // 空输入、格式错误、越界页码：明确的输入错误，返回 400
    if (err instanceof ReprintInputError) {
      return res.status(400).json({ error: err.message });
    }
    const message = err && err.message ? err.message : '补印失败';
    return res.status(422).json({ error: `无法处理该 PDF：${message}` });
  }
});

// 印刷用纸报价：根据拼版方案（统一面板/纸张数/分册签帖）与用户维护的
// 纸张规格，枚举每个纸张的原向与旋转 90°，选择可容纳版面的最低总价方案。
// 入参不合法返回 400；没有任何纸张可容纳时仍返回 200，结果中 feasible=false
// 并在 reason 中给出明确原因（属正常报价结果，便于前端直接展示）。
app.post('/api/quote', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: '请以 JSON body 提供拼版方案 plan 与纸张规格 papers' });
  }
  const { plan, papers } = body;
  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({ error: '缺少拼版方案 plan（请使用拼版响应头 X-Imposition-Plan 的内容）' });
  }
  if (!Array.isArray(papers)) {
    return res.status(400).json({ error: '缺少纸张规格数组 papers（宽、高、单价、开机费）' });
  }
  try {
    const quote = buildPaperQuote(plan, papers);
    return res.json(quote);
  } catch (err) {
    return res.status(400).json({
      error: `报价参数无效：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 批量裁切下料：拼版完成后传入拼版方案、页面维护的纸张规格与所需印张数，
// 沿用 plan.sheet 的实际输出尺寸枚举纸张原向/旋转 90°，以带记忆化的矩形
// 分割搜索生成可执行的直线贯通裁切树（非面积估算、非重叠摆放），返回每种
// 原纸的裁切图、单张产出、所需原纸张数与尾张余量。
// 入参（尺寸/数量）不合法返回 400；没有任何纸张能裁出时仍返回 200，结果中
// feasible=false 并在 reason 中说明原因（属正常结果，便于前端直接展示）。
app.post('/api/cutting', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: '请以 JSON body 提供拼版方案 plan、纸张规格 papers 与所需印张数 requiredSheets' });
  }
  const { plan, papers, requiredSheets } = body;
  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({ error: '缺少拼版方案 plan（请使用拼版响应头 X-Imposition-Plan 的内容）' });
  }
  if (!Array.isArray(papers)) {
    return res.status(400).json({ error: '缺少纸张规格数组 papers（宽、高、单价、开机费）' });
  }
  if (requiredSheets === undefined || requiredSheets === null) {
    return res.status(400).json({ error: '缺少所需印张数 requiredSheets（1～1000000 的整数）' });
  }
  try {
    const cutting = buildCuttingPlan(plan, papers, requiredSheets);
    return res.json(cutting);
  } catch (err) {
    return res.status(400).json({
      error: `裁切参数无效：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// JSON 解析错误等兜底
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体超过大小限制（1MB）' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

// 直接运行时启动服务；被测试代码 require 时不监听端口
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`小册子拼版应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app };
