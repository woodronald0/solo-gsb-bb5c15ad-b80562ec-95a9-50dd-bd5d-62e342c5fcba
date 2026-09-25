'use strict';

/**
 * 印前报告差异对比（preflight diff）。
 *
 * 输入两份由 lib/preflight.js 的 preflightPdf() 产出的同构报告：
 *   - baseline：基准 PDF（上一版 / 客户确认版）的报告；
 *   - delivery：待交付 PDF（当前导出文件）的报告。
 *
 * 对齐规则：
 *   1. 逐页问题（issue.pages 非空）按「页码 + 问题代码」对齐：
 *      - 仅待交付中出现的实例计入 added（新增问题）；
 *      - -仅基准中出现的实例计入 resolved（已解决问题）；
 *      - 两份都出现的计入 persistent（仍存在问题），并逐页比较检测值
 *        （detected.detail），变化时记入 detailChangedPages。
 *      同一问题代码若只在部分页码上消失/新增，会同时出现在多个分组中，
 *      各分组仅包含对应页码。
 *   2. 文档级问题（无页码，如 blank_padding）仅按问题代码对齐，
 *      检测值（报告 message）变化时标记 detailChanged。
 *   3. 页数按页码对齐：超出对方页数的尾部页面记为 added/removed 页
 *      （工具不比对页面内容，无法识别插入/删除导致的整体位移）。
 *
 * 该模块只做纯数据比对，不触碰 PDF 字节，也不依赖拼版流程；
 * 单文件校验（/api/preflight）与拼版（/api/impose）完全不受其影响。
 */

const { ISSUE_META } = require('./preflight');

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * 问题代码的展示元数据：优先使用当前版本的 ISSUE_META，
 * 报告中携带的字段作为兜底（兼容旧版本报告里可能存在的新代码）。
 */
function describeCode(code, fallbackIssue) {
  const meta = ISSUE_META[code];
  if (meta) {
    return { severity: meta.severity, title: meta.title, advice: meta.advice };
  }
  return {
    severity: (fallbackIssue && fallbackIssue.severity) || 'info',
    title: (fallbackIssue && fallbackIssue.title) || code,
    advice: (fallbackIssue && fallbackIssue.advice) || '',
  };
}

/**
 * 从一份报告中抽取问题实例。
 *
 * @returns {{
 *   pageMap: Map<string, {code:string, page:number, detail:string, issue:object}>,
 *   documentMap: Map<string, {code:string, detail:string, issue:object}>
 * }}
 *   pageMap 的键为 `${code}@${page}`；documentMap 收集文档级（无页码）问题。
 */
function collectInstances(report) {
  const pageMap = new Map();
  const documentMap = new Map();
  for (const issue of report.issues || []) {
    if (issue.pages && issue.pages.length) {
      const detectedByPage = new Map(
        (issue.detected || []).map((d) => [d.page, d.detail]),
      );
      for (const page of issue.pages) {
        pageMap.set(`${issue.code}@${page}`, {
          code: issue.code,
          page,
          detail: detectedByPage.has(page) ? detectedByPage.get(page) : '',
          issue,
        });
      }
    } else {
      documentMap.set(issue.code, {
        code: issue.code,
        detail: issue.message || '',
        issue,
      });
    }
  }
  return { pageMap, documentMap };
}

function createEntry(code, fallbackIssue, documentLevel) {
  const meta = describeCode(code, fallbackIssue);
  return {
    code,
    severity: meta.severity,
    title: meta.title,
    advice: meta.advice,
    documentLevel,
    pages: [],
    baselineDetails: [],
    deliveryDetails: [],
    detailChangedPages: [],
    baselineDetail: null,
    deliveryDetail: null,
    detailChanged: false,
  };
}

function ensureEntry(map, code, fallbackIssue, documentLevel) {
  if (!map.has(code)) {
    map.set(code, createEntry(code, fallbackIssue, documentLevel));
  }
  return map.get(code);
}

/**
 * 条目输出整形：逐页条目按页码排序并给出 pageCount；
 * 文档级条目只保留文档级字段，避免把空页码数组暴露给消费方。
 */
function finalizeEntry(entry) {
  if (entry.documentLevel) {
    return {
      code: entry.code,
      severity: entry.severity,
      title: entry.title,
      advice: entry.advice,
      documentLevel: true,
      baselineDetail: entry.baselineDetail,
      deliveryDetail: entry.deliveryDetail,
      detailChanged: entry.detailChanged,
    };
  }
  const byPage = (a, b) => a.page - b.page;
  entry.pages.sort((a, b) => a - b);
  entry.baselineDetails.sort(byPage);
  entry.deliveryDetails.sort(byPage);
  entry.detailChangedPages.sort((a, b) => a - b);
  return {
    code: entry.code,
    severity: entry.severity,
    title: entry.title,
    advice: entry.advice,
    documentLevel: false,
    pages: entry.pages,
    pageCount: entry.pages.length,
    baselineDetails: entry.baselineDetails,
    deliveryDetails: entry.deliveryDetails,
    detailChangedPages: entry.detailChangedPages,
  };
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.code.localeCompare(b.code);
  }).map(finalizeEntry);
}

/** 按严重级别统计问题实例数：逐页问题按页计，文档级问题按 1 项计 */
function tally(entries) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of entries) {
    const amount = entry.documentLevel ? 1 : entry.pages.length;
    counts[entry.severity] += amount;
  }
  return {
    error: counts.error,
    warning: counts.warning,
    info: counts.info,
    total: counts.error + counts.warning + counts.info,
    codes: entries.length,
  };
}

function compactPageRecord(record) {
  return {
    mediaWidth: record.mediaWidth,
    mediaHeight: record.mediaHeight,
    widthMm: record.widthMm,
    heightMm: record.heightMm,
    rotation: record.rotation,
    transparent: record.transparent,
    textExtractable: record.textExtractable,
  };
}

/**
 * 比对两份印前校验报告，返回结构化差异结果（可直接 JSON 序列化下载）。
 *
 * @param {object} baselineReport 基准 PDF 的 preflightPdf 报告
 * @param {object} deliveryReport 待交付 PDF 的 preflightPdf 报告
 * @returns {object} 差异报告
 */
function diffPreflightReports(baselineReport, deliveryReport) {
  if (!baselineReport || !deliveryReport) {
    throw new Error('缺少基准或待交付印前校验报告，无法对比');
  }
  if (!Array.isArray(baselineReport.issues) || !Array.isArray(deliveryReport.issues)
    || !Array.isArray(baselineReport.pages) || !Array.isArray(deliveryReport.pages)) {
    throw new Error('印前校验报告结构不完整，无法对比');
  }

  const baseline = collectInstances(baselineReport);
  const delivery = collectInstances(deliveryReport);

  const addedMap = new Map();
  const resolvedMap = new Map();
  const persistentMap = new Map();

  // 逐页问题：按 页码 + 代码 对齐
  const pageDiffs = new Map(); // page -> { added:Set, resolved:Set, persistent:Set }
  const ensurePageDiff = (page) => {
    if (!pageDiffs.has(page)) {
      pageDiffs.set(page, { added: new Set(), resolved: new Set(), persistent: new Set() });
    }
    return pageDiffs.get(page);
  };

  const pageKeys = new Set([
    ...baseline.pageMap.keys(),
    ...delivery.pageMap.keys(),
  ]);
  for (const key of pageKeys) {
    const b = baseline.pageMap.get(key);
    const d = delivery.pageMap.get(key);
    if (b && !d) {
      const entry = ensureEntry(resolvedMap, b.code, b.issue, false);
      entry.pages.push(b.page);
      entry.baselineDetails.push({ page: b.page, detail: b.detail });
      ensurePageDiff(b.page).resolved.add(b.code);
    } else if (!b && d) {
      const entry = ensureEntry(addedMap, d.code, d.issue, false);
      entry.pages.push(d.page);
      entry.deliveryDetails.push({ page: d.page, detail: d.detail });
      ensurePageDiff(d.page).added.add(d.code);
    } else if (b && d) {
      const entry = ensureEntry(persistentMap, b.code, b.issue, false);
      entry.pages.push(b.page);
      entry.baselineDetails.push({ page: b.page, detail: b.detail });
      entry.deliveryDetails.push({ page: d.page, detail: d.detail });
      if (b.detail !== d.detail) entry.detailChangedPages.push(b.page);
      ensurePageDiff(b.page).persistent.add(b.code);
    }
  }

  // 文档级问题：仅按代码对齐（如 blank_padding 随页数变化出现/消失或文案变化）
  const documentCodes = new Set([
    ...baseline.documentMap.keys(),
    ...delivery.documentMap.keys(),
  ]);
  for (const code of documentCodes) {
    const b = baseline.documentMap.get(code);
    const d = delivery.documentMap.get(code);
    if (b && !d) {
      ensureEntry(resolvedMap, code, b.issue, true).baselineDetail = b.detail;
    } else if (!b && d) {
      ensureEntry(addedMap, code, d.issue, true).deliveryDetail = d.detail;
    } else if (b && d) {
      const entry = ensureEntry(persistentMap, code, b.issue, true);
      entry.baselineDetail = b.detail;
      entry.deliveryDetail = d.detail;
      entry.detailChanged = b.detail !== d.detail;
    }
  }

  const added = sortEntries([...addedMap.values()]);
  const resolved = sortEntries([...resolvedMap.values()]);
  const persistent = sortEntries([...persistentMap.values()]);

  // 页数变化：按页码对齐，超出对方页数的尾部页面记为新增/移除页
  const baselineCount = baselineReport.pageCount;
  const deliveryCount = deliveryReport.pageCount;
  const addedPages = [];
  const removedPages = [];
  for (let p = baselineCount + 1; p <= deliveryCount; p += 1) addedPages.push(p);
  for (let p = deliveryCount + 1; p <= baselineCount; p += 1) removedPages.push(p);

  // 逐页明细：保留页同时给出指标变化标记
  const pages = [];
  const maxPages = Math.max(baselineCount, deliveryCount);
  for (let page = 1; page <= maxPages; page += 1) {
    const baseRecord = page <= baselineCount ? baselineReport.pages[page - 1] : null;
    const deliveryRecord = page <= deliveryCount ? deliveryReport.pages[page - 1] : null;
    const status = !baseRecord ? 'added' : !deliveryRecord ? 'removed' : 'retained';

    let changes = null;
    if (baseRecord && deliveryRecord) {
      changes = {
        sizeChanged: baseRecord.mediaWidth !== deliveryRecord.mediaWidth
          || baseRecord.mediaHeight !== deliveryRecord.mediaHeight,
        rotationChanged: baseRecord.rotation !== deliveryRecord.rotation,
        transparencyChanged: baseRecord.transparent !== deliveryRecord.transparent,
        // 任一方「无法判定」(null) 时不标记变化，避免把未知当作差异
        textChanged: baseRecord.textExtractable !== null
          && deliveryRecord.textExtractable !== null
          && baseRecord.textExtractable !== deliveryRecord.textExtractable,
      };
    }

    const diff = pageDiffs.get(page);
    pages.push({
      page,
      status,
      baseline: baseRecord ? compactPageRecord(baseRecord) : null,
      delivery: deliveryRecord ? compactPageRecord(deliveryRecord) : null,
      changes,
      issues: {
        added: diff ? [...diff.added].sort() : [],
        resolved: diff ? [...diff.resolved].sort() : [],
        persistent: diff ? [...diff.persistent].sort() : [],
      },
    });
  }

  const summary = {
    added: tally([...addedMap.values()]),
    resolved: tally([...resolvedMap.values()]),
    persistent: tally([...persistentMap.values()]),
    addedPages: addedPages.length,
    removedPages: removedPages.length,
    pagesWithAddedIssues: [...pageDiffs.values()].filter((d) => d.added.size > 0).length,
    pagesWithResolvedIssues: [...pageDiffs.values()].filter((d) => d.resolved.size > 0).length,
    pagesWithPersistentIssues: [...pageDiffs.values()].filter((d) => d.persistent.size > 0).length,
  };

  return {
    schemaVersion: 1,
    kind: 'preflight-diff',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    baseline: {
      file: baselineReport.file || { name: null, sizeBytes: null },
      pageCount: baselineCount,
      passed: baselineReport.summary ? baselineReport.summary.passed : null,
      issuesTotal: baselineReport.summary ? baselineReport.summary.issuesTotal : null,
    },
    delivery: {
      file: deliveryReport.file || { name: null, sizeBytes: null },
      pageCount: deliveryCount,
      passed: deliveryReport.summary ? deliveryReport.summary.passed : null,
      issuesTotal: deliveryReport.summary ? deliveryReport.summary.issuesTotal : null,
    },
    pageCount: {
      baseline: baselineCount,
      delivery: deliveryCount,
      delta: deliveryCount - baselineCount,
      addedPages,
      removedPages,
    },
    summary,
    added,
    resolved,
    persistent,
    pages,
  };
}

module.exports = {
  diffPreflightReports,
  collectInstances,
};
