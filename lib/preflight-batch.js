'use strict';

/**
 * PDF 印前批量校验（batch preflight）。
 *
 * 一次最多处理 BATCH_PREFLIGHT_MAX_FILES 个 PDF：按输入顺序逐个复用
 * lib/preflight.js 的单文件校验。单个文件缺失、为空、非 PDF、损坏或加密时，
 * 只在该文件的结果中记录失败原因与失败代码，不抛出、不阻断其余文件。
 *
 * 汇总信息：
 *   - 顶层 summary：成功校验/失败文件数与全部文件的错误/警告/提示总数；
 *   - issueTotals：按问题代码（code）汇总出现次数（同一文件内同一代码的
 *     一个区段计 1  次，文档级问题计 1 次）及涉及文件（索引 + 文件名）。
 *
 * 交付放行判定（release decision）：
 *   - 可按问题代码（code）配置处置方式：block（阻断交付）/ warn（需复核）/
 *     ignore（忽略）；未配置时代码按其严重级别取默认处置：
 *     错误 → block、警告 → warn、提示 → ignore；
 *   - 每个成功校验的文件按「阻断优先于警告」判为 blocked（阻断交付）、
 *     review（需复核）或 passed（放行）；无法校验的文件为 undetermined（未判定）；
 *   - 整批放行结论的优先级为 blocked > undetermined > review > passed。
 *
 * 放行判定只引用、不改动原检测结果：单文件 report、文件级 passed（仅表示无
 * 错误级问题）与 summary.allPassed 的含义均保持不变。
 *
 * 单文件接口（/api/preflight）与本模块完全独立，二者输出结构均保持不变。
 */

const { preflightPdf, ISSUE_META } = require('./preflight');

/** 单次批量校验允许的文件数量上限（含校验失败的文件） */
const BATCH_PREFLIGHT_MAX_FILES = 10;

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * 放行处置（release action）：
 *   block  —— 阻断交付；
 *   warn   —— 需人工复核后放行；
 *   ignore —— 已知悉/接受，忽略该问题。
 */
const RELEASE_ACTIONS = { block: 'block', warn: 'warn', ignore: 'ignore' };

/** 未为某问题代码单独配置处置时，按严重级别套用的默认处置 */
const DEFAULT_ACTION_BY_SEVERITY = {
  error: 'block',
  warning: 'warn',
  info: 'ignore',
};

/** 处置的展示顺序（阻断优先于警告，警告优先于忽略） */
const ACTION_RANK = { block: 0, warn: 1, ignore: 2 };

/** 失败文件提示文案：与服务端单文件接口的错误文案保持一致的口径 */
const FAILURE_MESSAGES = {
  not_pdf: '仅支持 PDF 文件',
  invalid_pdf: '文件不是有效的 PDF（可能已损坏或被加密），无法进行印前校验',
  encrypted_pdf: 'PDF 已加密，无法进行印前校验',
  empty_document: 'PDF 不包含任何页面，无法进行印前校验',
};

/**
 * 解析调用方提供的放行策略覆盖项，返回规范化的「代码 → 处置」映射，
 * 其中只包含显式覆盖的代码（其余代码按严重级别取默认处置）。
 *
 * 接受：
 *   - undefined / null / 空字符串 —— 无任何覆盖；
 *   - 对象 { code: 'block' | 'warn' | 'ignore' }；
 *   - JSON 字符串（内容为上述对象）。
 * 未知问题代码、非法处置或非对象 JSON 直接抛错（由 HTTP 层转 400）。
 *
 * @param {object|string|undefined|null} input
 * @returns {Object<string, string>}
 */
function normalizeReleasePolicy(input) {
  if (input === undefined || input === null || input === '') return {};

  let policy = input;
  if (typeof input === 'string') {
    try {
      policy = JSON.parse(input);
    } catch (_) {
      throw new Error('放行策略必须是 JSON 对象（问题代码到处置方式的映射）');
    }
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('放行策略必须是对象：{ 问题代码: "block" | "warn" | "ignore" }');
  }

  const knownCodes = Object.keys(ISSUE_META);
  const normalized = {};
  for (const [code, action] of Object.entries(policy)) {
    if (!Object.prototype.hasOwnProperty.call(ISSUE_META, code)) {
      throw new Error(`未知问题代码「${code}」；可用代码：${knownCodes.join('、')}`);
    }
    if (!Object.prototype.hasOwnProperty.call(RELEASE_ACTIONS, action)) {
      throw new Error(`代码「${code}」的处置方式非法：${String(action)}`
        + '（只允许 block / warn / ignore）');
    }
    normalized[code] = action;
  }
  return normalized;
}

/** 解析单个问题代码的最终处置与来源（default / custom） */
function resolveAction(code, severity, custom) {
  if (custom && Object.prototype.hasOwnProperty.call(custom, code)) {
    return { action: custom[code], source: 'custom' };
  }
  return {
    action: DEFAULT_ACTION_BY_SEVERITY[severity] || 'warn',
    source: 'default',
  };
}

/**
 * 生成完整放行策略快照（写入批量 JSON，便于审计当次判定依据）：
 * 固定默认规则 + 覆盖项 + 逐代码的最终规则（按 严重级别 → 代码 排序）。
 */
function buildReleasePolicy(custom) {
  const rules = Object.keys(ISSUE_META)
    .map((code) => {
      const severity = ISSUE_META[code].severity;
      const resolved = resolveAction(code, severity, custom);
      return {
        code,
        severity,
        title: ISSUE_META[code].title,
        action: resolved.action,
        source: resolved.source,
      };
    })
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      return a.code.localeCompare(b.code);
    });
  return {
    defaults: { ...DEFAULT_ACTION_BY_SEVERITY },
    custom: { ...custom },
    rules,
  };
}

/**
 * 根据单文件报告与放行策略，计算该文件的交付放行判定。
 *
 * 同一文件内同一代码只列 1 条（区段已在单文件报告中合并），count 为该代码
 * 在本文件中的区段/文档级问题条数；triggered 按 处置（阻断→警告→忽略）、
 * 严重级别、代码排序。判定优先级：任一阻断 → blocked；否则任一警告 →
 * review；否则 passed。
 *
 * @returns {{ decision: string, actionCounts: object, triggered: Array }}
 */
function evaluateFileRelease(report, custom) {
  const countByCode = new Map();
  for (const issue of report.issues) {
    const prev = countByCode.get(issue.code);
    if (prev) {
      prev.count += 1;
    } else {
      countByCode.set(issue.code, {
        code: issue.code,
        severity: issue.severity,
        title: issue.title,
        count: 1,
      });
    }
  }

  const triggered = [...countByCode.values()].map((entry) => {
    const resolved = resolveAction(entry.code, entry.severity, custom);
    return { ...entry, action: resolved.action, source: resolved.source };
  });
  triggered.sort((a, b) => {
    const actionDiff = ACTION_RANK[a.action] - ACTION_RANK[b.action];
    if (actionDiff !== 0) return actionDiff;
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.code.localeCompare(b.code);
  });

  const actionCounts = { block: 0, warn: 0, ignore: 0 };
  for (const item of triggered) actionCounts[item.action] += 1;

  let decision = 'passed';
  if (actionCounts.block > 0) decision = 'blocked';
  else if (actionCounts.warn > 0) decision = 'review';

  return { decision, actionCounts, triggered };
}

/**
 * 判断上传内容是否为 PDF：以 PDF 文件头魔数为准；部分浏览器以
 * application/octet-stream 上传时，回退校验文件名后缀。
 */
function looksLikePdf(buffer, originalname, mimetype) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return true;
  return (!mimetype || mimetype === 'application/octet-stream')
    && /\.pdf$/i.test(originalname || '');
}

/**
 * 对一组文件按顺序执行印前校验，返回完整批量报告。
 *
 * @param {Array<{ buffer: Buffer, originalname?: string, size?: number }>} files
 *        已完成 multipart 解析的文件（顺序即上传顺序）
 * @param {{ releasePolicy?: Object<string, string> }} [options]
 *        releasePolicy 为经 normalizeReleasePolicy 规范化的代码级处置覆盖项
 * @returns {Promise<object>} 批量报告对象（可直接 JSON 序列化下载）
 */
async function preflightPdfBatch(files, options = {}) {
  const generatedAt = new Date().toISOString();
  const customPolicy = options.releasePolicy || {};
  const releasePolicy = buildReleasePolicy(customPolicy);
  const results = [];
  // code -> { count, files: Set, filesMeta: [{index, name}] }
  const codeAgg = new Map();

  let completed = 0;
  let failed = 0;
  let passedFiles = 0;
  let totalError = 0;
  let totalWarning = 0;
  let totalInfo = 0;
  const releaseCounts = { blocked: 0, review: 0, passed: 0, undetermined: 0 };

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const fileName = file && file.originalname ? file.originalname : null;
    const sizeBytes = typeof file.size === 'number' ? file.size : (file.buffer ? file.buffer.length : null);

    // 空文件（0 字节）无法按魔数判定，直接记为该文件失败，不阻断后续文件
    if (!file.buffer || file.buffer.length === 0
      || !looksLikePdf(file.buffer, file.originalname, file.mimetype)) {
      results.push({
        index,
        status: 'failed',
        file: { name: fileName, sizeBytes },
        pageCount: null,
        passed: false,
        errorCode: 'not_pdf',
        error: FAILURE_MESSAGES.not_pdf,
        counts: { error: 0, warning: 0, info: 0, issuesTotal: 0, pagesWithIssues: 0 },
        // 无法校验的文件不参与放行判定，单独标为「未判定」
        release: { decision: 'undetermined', actionCounts: { block: 0, warn: 0, ignore: 0 }, triggered: [] },
        report: null,
      });
      failed += 1;
      releaseCounts.undetermined += 1;
      continue;
    }

    let report;
    try {
      report = await preflightPdf(file.buffer, { fileName, sizeBytes });
    } catch (err) {
      const errorCode = (err && err.errCode) || 'invalid_pdf';
      results.push({
        index,
        status: 'failed',
        file: { name: fileName, sizeBytes },
        pageCount: null,
        passed: false,
        errorCode,
        error: FAILURE_MESSAGES[errorCode]
          || `无法校验该 PDF：${err && err.message ? err.message : '未知错误'}`,
        counts: { error: 0, warning: 0, info: 0, issuesTotal: 0, pagesWithIssues: 0 },
        release: { decision: 'undetermined', actionCounts: { block: 0, warn: 0, ignore: 0 }, triggered: [] },
        report: null,
      });
      failed += 1;
      releaseCounts.undetermined += 1;
      continue;
    }

    const { summary } = report;
    completed += 1;
    totalError += summary.error;
    totalWarning += summary.warning;
    totalInfo += summary.info;
    if (summary.passed) passedFiles += 1;

    const release = evaluateFileRelease(report, customPolicy);
    releaseCounts[release.decision] += 1;

    // 同一文件内同一代码只计 1 次（区段已在单文件报告中合并）
    for (const issue of report.issues) {
      let entry = codeAgg.get(issue.code);
      if (!entry) {
        entry = {
          code: issue.code,
          severity: issue.severity,
          title: issue.title,
          count: 0,
          filesSet: new Set(),
          files: [],
        };
        codeAgg.set(issue.code, entry);
      }
      entry.count += 1;
      if (!entry.filesSet.has(index)) {
        entry.filesSet.add(index);
        entry.files.push({ index, name: fileName });
      }
    }

    results.push({
      index,
      status: 'completed',
      file: { name: fileName, sizeBytes },
      pageCount: report.pageCount,
      passed: summary.passed,
      errorCode: null,
      error: null,
      counts: {
        error: summary.error,
        warning: summary.warning,
        info: summary.info,
        issuesTotal: summary.issuesTotal,
        pagesWithIssues: summary.pagesWithIssues,
      },
      // 交付放行判定（阻断 / 需复核 / 放行）及触发代码与处置
      release,
      // 完整单文件报告原样内嵌，保证「下载完整批量 JSON」内容齐备
      report,
    });
  }

  const issueTotals = [...codeAgg.values()]
    .map((entry) => {
      const resolved = resolveAction(entry.code, entry.severity, customPolicy);
      return {
        code: entry.code,
        severity: entry.severity,
        title: entry.title,
        action: resolved.action,
        actionSource: resolved.source,
        count: entry.count,
        files: entry.files,
        fileCount: entry.files.length,
      };
    })
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      return a.code.localeCompare(b.code);
    });

  // 整批放行结论：阻断优先，其次未判定（需人工确认能否交付），再次需复核，最后放行
  let batchDecision = 'passed';
  if (releaseCounts.blocked > 0) batchDecision = 'blocked';
  else if (releaseCounts.undetermined > 0) batchDecision = 'undetermined';
  else if (releaseCounts.review > 0) batchDecision = 'review';

  return {
    schemaVersion: 1,
    kind: 'preflight-batch',
    tool: 'booklet-imposer',
    generatedAt,
    limit: BATCH_PREFLIGHT_MAX_FILES,
    releasePolicy,
    summary: {
      total: results.length,
      completed,
      failed,
      passed: passedFiles,
      error: totalError,
      warning: totalWarning,
      info: totalInfo,
      // 所有成功校验的文件均无错误级问题才算整批通过
      allPassed: failed === 0 && passedFiles === results.length,
      // 交付放行汇总（检测维度的 passed / allPassed 含义不变，见上）
      release: {
        blocked: releaseCounts.blocked,
        review: releaseCounts.review,
        passed: releaseCounts.passed,
        undetermined: releaseCounts.undetermined,
        decision: batchDecision,
      },
    },
    issueTotals,
    files: results,
  };
}

module.exports = {
  BATCH_PREFLIGHT_MAX_FILES,
  FAILURE_MESSAGES,
  RELEASE_ACTIONS,
  DEFAULT_ACTION_BY_SEVERITY,
  normalizeReleasePolicy,
  buildReleasePolicy,
  resolveAction,
  evaluateFileRelease,
  looksLikePdf,
  preflightPdfBatch,
};
