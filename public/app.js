'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const preflightBtn = document.getElementById('preflight-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');
const signatureModeInput = document.getElementById('signature-mode');
const maxSheetsField = document.getElementById('max-sheets-field');
const maxSheetsInput = document.getElementById('max-sheets');
const registrationMarksInput = document.getElementById('registration-marks');
const creepCompensationInput = document.getElementById('creep-compensation');
const paperThicknessField = document.getElementById('paper-thickness-field');
const paperThicknessInput = document.getElementById('paper-thickness');
const summaryListEl = document.getElementById('summary-list');
const signatureSummaryEl = document.getElementById('signature-summary');
const reprintBoxEl = document.getElementById('reprint-box');
const reprintPagesInput = document.getElementById('reprint-pages');
const reprintBtn = document.getElementById('reprint-btn');
const reprintStatusEl = document.getElementById('reprint-status');
const reprintResultEl = document.getElementById('reprint-result');
const reprintDownloadBtn = document.getElementById('reprint-download-btn');

const reportEl = document.getElementById('report');
const reportVerdictEl = document.getElementById('report-verdict');
const reportSummaryEl = document.getElementById('report-summary');
const issueListEl = document.getElementById('issue-list');
const reportEmptyEl = document.getElementById('report-empty');
const reportDownloadBtn = document.getElementById('report-download-btn');
const pageTableBody = document.getElementById('page-table-body');
const pageDetailCount = document.getElementById('page-detail-count');
const filterChips = document.querySelectorAll('.filter-chip');
const filterCountEls = document.querySelectorAll('.chip-count');

const MAX_SHEETS = 20;
const MIN_PAPER_THICKNESS = 0.05;
const MAX_PAPER_THICKNESS = 0.5;

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';
let preflightReport = null;
let activeLevelFilter = 'all';
let reprintBlobUrl = null;
let reprintData = null;
// 本次拼版使用的选项（缺页补印需按相同选项复用拼版方案）
let lastImposeOptions = null;

signatureModeInput.addEventListener('change', () => {
  maxSheetsField.hidden = !signatureModeInput.checked;
});

creepCompensationInput.addEventListener('change', () => {
  paperThicknessField.hidden = !creepCompensationInput.checked;
});

/**
 * 校验纸厚：仅接受 0.05～0.5 mm 之间的数值（最多 3 位小数）。
 * @returns {number|null} 合法时返回数值，非法时返回 null（并已设置错误提示）
 */
function readPaperThickness() {
  const raw = paperThicknessInput.value;
  if (!/^\s*(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(raw)) {
    setStatus(`请填写纸张厚度（${MIN_PAPER_THICKNESS}～${MAX_PAPER_THICKNESS} mm 的数值）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < MIN_PAPER_THICKNESS || value > MAX_PAPER_THICKNESS) {
    setStatus(`纸张厚度必须在 ${MIN_PAPER_THICKNESS}～${MAX_PAPER_THICKNESS} mm 之间`, 'error');
    return null;
  }
  return value;
}

/**
 * 校验每帖最多纸张数：仅接受 1～20 的整数。
 * @returns {number|null} 合法时返回整数，非法时返回 null（并已设置错误提示）
 */
function readMaxSheets() {
  const raw = maxSheetsInput.value;
  if (!/^\s*\d+\s*$/.test(raw)) {
    setStatus(`请填写每帖最多纸张数（1～${MAX_SHEETS} 的整数）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > MAX_SHEETS) {
    setStatus(`每帖最多纸张数必须在 1～${MAX_SHEETS} 之间`, 'error');
    return null;
  }
  return value;
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
  summaryListEl.innerHTML = '';
  signatureSummaryEl.hidden = true;
  signatureSummaryEl.innerHTML = '';
  clearQuote();
  clearCutting();
  clearReprint();
}

/**
 * 重新选择文件时清空上一份校验报告；报告 JSON 通过 Blob 下载。
 */
function clearReport() {
  preflightReport = null;
  reportEl.hidden = true;
  issueListEl.innerHTML = '';
  pageTableBody.innerHTML = '';
  reportSummaryEl.innerHTML = '';
  reportVerdictEl.textContent = '';
  activeLevelFilter = 'all';
  updateFilterChips();
}

function selectFile(file) {
  clearResult();
  clearReport();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    preflightBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  preflightBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`, 'info');
}

// ---------- 印前校验 ----------

const SEVERITY_LABELS = { error: '错误', warning: '警告', info: '提示' };

function formatRange(issue) {
  if (issue.pageFrom === null || issue.pageTo === null) return '整篇文档';
  return issue.pageFrom === issue.pageTo
    ? `第 ${issue.pageFrom} 页`
    : `第 ${issue.pageFrom}～${issue.pageTo} 页`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

preflightBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  preflightBtn.disabled = true;
  imposeBtn.disabled = true;
  setStatus('正在执行印前校验，不会生成拼版文件…', 'info');

  const form = new FormData();
  form.append('pdf', selectedFile);

  try {
    const resp = await fetch('/api/preflight', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    preflightReport = await resp.json();
    renderReport(preflightReport);
    const { summary } = preflightReport;
    if (summary.error > 0) {
      setStatus(`校验完成：发现 ${summary.error} 个错误、${summary.warning} 个警告、`
        + `${summary.info} 个提示。仍可继续拼版，请先评估错误项。`, 'error');
    } else if (summary.warning > 0 || summary.info > 0) {
      setStatus(`校验完成：${summary.warning} 个警告、${summary.info} 个提示，不影响继续拼版。`, 'info');
    } else {
      setStatus('校验完成：未发现印前问题，可以直接拼版。', 'info');
    }
  } catch (err) {
    setStatus(err.message || '印前校验失败', 'error');
  } finally {
    preflightBtn.disabled = false;
    imposeBtn.disabled = false;
  }
});

function renderReport(report) {
  reportEl.hidden = false;

  const { summary, referenceSize } = report;
  reportVerdictEl.className = `report-verdict ${summary.passed ? 'ok' : 'bad'}`;
  reportVerdictEl.textContent = summary.passed
    ? `结论：未发现错误级问题（${report.pageCount} 页；主尺寸 ${referenceSize.widthMm} × `
      + `${referenceSize.heightMm} mm）。警告/提示可选择性处理，拼版不受阻断。`
    : `结论：发现 ${summary.error} 个错误级问题（${report.pageCount} 页；主尺寸 `
      + `${referenceSize.widthMm} × ${referenceSize.heightMm} mm）。建议修复后再印刷，`
      + '但仍可继续拼版。';

  renderReportSummary(summary);
  renderIssueList(report.issues);
  renderPageTable(report.pages);

  filterCountEls.forEach((el) => {
    const level = el.dataset.count;
    el.textContent = level === 'all' ? report.issues.length : summary[level];
  });
}

function renderReportSummary(summary) {
  reportSummaryEl.innerHTML = '';
  const cards = [
    { level: 'error', label: '错误', count: summary.error },
    { level: 'warning', label: '警告', count: summary.warning },
    { level: 'info', label: '提示', count: summary.info },
    { level: 'pages', label: '涉及页面', count: summary.pagesWithIssues },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    div.innerHTML = `<span class="stat-num">${card.count}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    reportSummaryEl.appendChild(div);
  }
}

function updateFilterChips() {
  filterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.level === activeLevelFilter);
  });
}

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeLevelFilter = chip.dataset.level;
    updateFilterChips();
    if (preflightReport) renderIssueList(preflightReport.issues);
  });
});

function renderIssueList(issues) {
  issueListEl.innerHTML = '';
  const visible = activeLevelFilter === 'all'
    ? issues
    : issues.filter((issue) => issue.severity === activeLevelFilter);

  reportEmptyEl.hidden = visible.length !== 0;

  for (const issue of visible) {
    const li = document.createElement('li');
    li.className = `issue ${issue.severity}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const badge = document.createElement('span');
    badge.className = `severity-badge ${issue.severity}`;
    badge.textContent = SEVERITY_LABELS[issue.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = issue.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = formatRange(issue)
      + (issue.pageCount > 1 ? `（连续 ${issue.pageCount} 页）` : '');
    head.append(badge, title, range);
    li.appendChild(head);

    const message = document.createElement('p');
    message.className = 'issue-message';
    message.textContent = issue.message;
    li.appendChild(message);

    if (issue.values && issue.values.length) {
      const dl = document.createElement('dl');
      dl.className = 'issue-values';
      for (const value of issue.values) {
        const dt = document.createElement('dt');
        dt.textContent = value.label;
        const dd = document.createElement('dd');
        dd.textContent = value.value;
        dl.append(dt, dd);
      }
      li.appendChild(dl);
    }

    const advice = document.createElement('p');
    advice.className = 'issue-advice';
    advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(issue.advice)}`;
    li.appendChild(advice);

    issueListEl.appendChild(li);
  }
}

function renderPageTable(pages) {
  pageTableBody.innerHTML = '';
  pageDetailCount.textContent = String(pages.length);
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const tr = document.createElement('tr');
    tr.className = p.issues.length ? 'has-issue' : 'clean';
    const issueText = p.issues.length
      ? p.issues.map((i) => SEVERITY_LABELS[i.severity] + '·' + i.title).join('；')
      : '—';
    tr.innerHTML = `<td>第 ${p.page} 页</td>`
      + `<td>${p.effectiveWidth.toFixed(1)} × ${p.effectiveHeight.toFixed(1)} pt`
      + `（${p.widthMm} × ${p.heightMm} mm）</td>`
      + `<td>${p.rotation}°</td>`
      + `<td>${p.transparent ? '是' : '否'}</td>`
      + `<td>${p.textExtractable === null ? '无法判定' : (p.textExtractable ? '可提取' : '不可提取')}</td>`
      + `<td class="page-issues">${escapeHtml(issueText)}</td>`;
    frag.appendChild(tr);
  }
  pageTableBody.appendChild(frag);
}

reportDownloadBtn.addEventListener('click', () => {
  if (!preflightReport) return;
  const json = JSON.stringify(preflightReport, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-印前校验报告.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const useSignatures = signatureModeInput.checked;
  let maxSheets = null;
  if (useSignatures) {
    maxSheets = readMaxSheets();
    if (maxSheets === null) return;
  }

  const useCreep = creepCompensationInput.checked;
  let paperThickness = null;
  if (useCreep) {
    paperThickness = readPaperThickness();
    if (paperThickness === null) return;
  }

  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);
  if (useSignatures) {
    form.append('signatureMode', 'on');
    form.append('maxSheetsPerSignature', String(maxSheets));
  }
  if (registrationMarksInput.checked) {
    form.append('registrationMarks', 'on');
  }
  if (useCreep) {
    form.append('creepCompensation', 'on');
    form.append('paperThicknessMm', String(paperThickness));
  }

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    // 记录本次拼版选项，缺页补印按相同选项复用拼版方案
    lastImposeOptions = {
      signatureMode: useSignatures,
      maxSheetsPerSignature: useSignatures ? maxSheets : null,
      registrationMarks: registrationMarksInput.checked,
      creepCompensation: useCreep,
      paperThicknessMm: useCreep ? paperThickness : null,
    };
    reprintBoxEl.hidden = false;

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
    requestQuote(plan);
    requestCutting(plan);
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

const ORIENTATION_LABELS = {
  portrait: '竖版',
  landscape: '横版',
  square: '方形',
};

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function appendSummaryItem(label, value) {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = value;
  li.append(`${label}：`, strong);
  summaryListEl.appendChild(li);
}

function renderSummary(plan) {
  const sheetCount = plan.signatureMode ? plan.sheetCount : plan.sheets.length;
  appendSummaryItem('原始页数', `${plan.sourceCount} 页`);
  appendSummaryItem('末尾补白', `${plan.paddedCount} 页`);
  if (plan.signatureMode) {
    appendSummaryItem(
      '签帖数量',
      `${plan.signatureCount} 帖（每帖最多 ${plan.maxSheetsPerSignature} 张纸）`,
    );
  }
  appendSummaryItem('用纸数量', `${sheetCount} 张（每张正反 4 页）`);
  if (plan.panel) {
    const { width, height, orientation } = plan.panel;
    appendSummaryItem(
      '统一面板',
      `${width.toFixed(1)} × ${height.toFixed(1)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`,
    );
    appendSummaryItem('页面方向', ORIENTATION_LABELS[orientation] || orientation);
  }
  if (plan.sheet) {
    appendSummaryItem(
      '印张尺寸',
      `${plan.sheet.width.toFixed(1)} × ${plan.sheet.height.toFixed(1)} pt`
        + `（约 ${ptToMm(plan.sheet.width)} × ${ptToMm(plan.sheet.height)} mm）`,
    );
  }
  if (plan.marks) {
    appendSummaryItem(
      '定位标记',
      plan.marks.enabled
        ? `已启用（版心四周各 ${plan.marks.marginMm} mm 空白）`
        : '未启用',
    );
  }
  if (plan.creep) {
    appendSummaryItem(
      '爬移补偿',
      plan.creep.enabled
        ? `已启用（纸厚 ${plan.creep.paperThicknessMm} mm；单侧内移量＝（帖内张号－1）×纸厚，正背两面左页向右、右页向左平移并在各自半区裁切）`
        : '未启用',
    );
  }

  if (plan.signatureMode) {
    renderSignatureSummary(plan);
  } else if (plan.creep && plan.creep.enabled) {
    renderCreepSummary(plan.sheets, plan);
  }
  summaryEl.hidden = false;
}

/**
 * 爬移补偿明细：逐张列出张号与单侧内移量（mm）。
 * @param {Array} sheets 方案中的纸张（含 sheet.creep.shiftMm）
 * @param {object} [plan] 整册模式下用于显示总张数；签帖模式传 null 由各帖自行渲染
 * @param {number} [sig] 帖号（签帖模式），用于标题区分
 */
function renderCreepSummary(sheets, plan, sig) {
  const wrap = document.createElement('div');
  wrap.className = 'creep-summary';

  const hint = document.createElement('p');
  hint.className = 'creep-hint';
  hint.textContent = sig
    ? `第 ${sig} 帖：爬移按帖内张号从零计算（单侧内移量＝（帖内张号－1）×纸厚）。`
    : '爬移按张号从零计算（单侧内移量＝（张号－1）×纸厚），正背两面相同；'
      + '左页向右、右页向左平移，超出各自半区（含越过中央折线）的部分裁掉，补白保持空白。';
  wrap.appendChild(hint);

  const table = document.createElement('table');
  table.className = 'creep-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>张号</th><th>单侧内移量（mm）</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sheet of sheets) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>第 ${sheet.sheet} 张</td>`
      + `<td>${formatShiftMm(sheet.creep ? sheet.creep.shiftMm : 0)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (plan) {
    signatureSummaryEl.innerHTML = '';
    signatureSummaryEl.appendChild(wrap);
    signatureSummaryEl.hidden = false;
  } else {
    // 签帖模式：追加到该帖分组内（由 renderSignatureSummary 调用）
    return wrap;
  }
}

/**
 * 内移量展示：0 显示为 0，其余去除多余尾零（最多 3 位小数）。
 */
function formatShiftMm(value) {
  const num = Number(value) || 0;
  return num.toFixed(3).replace(/\.?0+$/, '');
}

function renderSignatureSummary(plan) {
  const wrap = document.createElement('div');

  const hint = document.createElement('p');
  hint.className = 'signature-hint';
  hint.textContent = `按原页序切分为 ${plan.signatureCount} 帖，各帖仅在帖末补白；`
    + '结果 PDF 按帖号顺序连续输出，下载仍为一个文件。';
  wrap.appendChild(hint);

  const table = document.createElement('table');
  table.className = 'signature-table';
  const thead = document.createElement('thead');
  const creepOn = Boolean(plan.creep && plan.creep.enabled);
  thead.innerHTML = '<tr>'
    + '<th>帖号</th><th>原始页范围</th><th>原始页数</th>'
    + '<th>帖末补白</th><th>帖内纸张编号</th><th>用纸</th>'
    + (creepOn ? '<th>各张贴移补偿（单侧内移 mm）</th>' : '')
    + '</tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sig of plan.signatures) {
    const tr = document.createElement('tr');
    const range = sig.sourceCount === 1
      ? `第 ${sig.startPage} 页`
      : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
    const sheetNums = sig.sheets.map((s) => s.sheet).join(', ');
    tr.innerHTML = `<td>第 ${sig.signature} 帖</td>`
      + `<td>${range}</td>`
      + `<td>${sig.sourceCount} 页</td>`
      + `<td>${sig.blanks} 页</td>`
      + `<td class="sheet-nums">第 ${sheetNums} 张</td>`
      + `<td>${sig.sheets.length} 张</td>`
      + (creepOn
        ? `<td class="creep-cell">${sig.sheets
          .map((s) => `第${s.sheet}张 ${formatShiftMm(s.creep ? s.creep.shiftMm : 0)}`)
          .join('；')}</td>`
        : '');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // 爬移补偿启用时，再按帖给出张号→内移量明细（各帖分别从零计算）
  if (creepOn) {
    for (const sig of plan.signatures) {
      wrap.appendChild(renderCreepSummary(sig.sheets, null, sig.signature));
    }
  }

  signatureSummaryEl.innerHTML = '';
  signatureSummaryEl.appendChild(wrap);
  signatureSummaryEl.hidden = false;
}

/**
 * 统一遍历方案中的纸张：整册模式直接遍历 plan.sheets；
 * 签帖模式按帖序遍历，并在每帖前插入帖标题分组。
 */
function forEachSheet(plan, callbacks) {
  if (plan.signatureMode) {
    for (const sig of plan.signatures) {
      callbacks.onSignature(sig);
      for (const sheet of sig.sheets) {
        callbacks.onSheet(sheet, sig);
      }
    }
  } else {
    for (const sheet of plan.sheets) {
      callbacks.onSheet(sheet, null);
    }
  }
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();
  // 预览按真实纸张比例渲染：优先用方案记录的实际印张宽高（含定位标记边距），
  // 缺省回退为 宽 = 2 × 面板宽，高 = 面板高
  const sheetRatio = plan.sheet && plan.sheet.height > 0
    ? plan.sheet.width / plan.sheet.height
    : (plan.panel && plan.panel.height > 0
      ? (2 * plan.panel.width) / plan.panel.height
      : 2);

  forEachSheet(plan, {
    onSignature(sig) {
      const group = document.createElement('div');
      group.className = 'signature-group';
      const range = sig.sourceCount === 1
        ? `第 ${sig.startPage} 页`
        : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
      group.textContent = `第 ${sig.signature} 帖 · 原始页 ${range} · 帖末补白 ${sig.blanks} 页`
        + ` · 用纸 ${sig.sheets.length} 张`;
      frag.appendChild(group);
    },
    onSheet(sheet, sig) {
      const card = document.createElement('div');
      card.className = 'sheet';

      const title = document.createElement('div');
      title.className = 'sheet-title';
      const creepText = sheet.creep && sheet.creep.shiftMm > 0
        ? ` · 单侧内移 ${formatShiftMm(sheet.creep.shiftMm)} mm`
        : '';
      if (sig) {
        title.textContent = `第 ${sig.signature} 帖 · 帖内第 ${sheet.sheet} 张纸 / 共 ${sig.sheets.length} 张${creepText}`;
      } else {
        title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${plan.sheets.length} 张${creepText}`;
      }
      card.appendChild(title);

      card.appendChild(buildSide('正面', sheet.front, false, sheetRatio));
      card.appendChild(buildSide('背面', sheet.back, true, sheetRatio));

      frag.appendChild(card);
    },
  });
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack, sheetRatio) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.style.aspectRatio = String(sheetRatio);
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}

// ---------- 印前报告差异对比 ----------

const diffBaselineInput = document.getElementById('diff-baseline-input');
const diffDeliveryInput = document.getElementById('diff-delivery-input');
const diffBaselineName = document.getElementById('diff-baseline-name');
const diffDeliveryName = document.getElementById('diff-delivery-name');
const diffBtn = document.getElementById('diff-btn');
const diffStatusEl = document.getElementById('diff-status');
const diffReportEl = document.getElementById('diff-report');
const diffVerdictEl = document.getElementById('diff-verdict');
const diffMetaEl = document.getElementById('diff-meta');
const diffSummaryEl = document.getElementById('diff-summary');
const diffIssueListEl = document.getElementById('diff-issue-list');
const diffIssueEmptyEl = document.getElementById('diff-issue-empty');
const diffPageTableBody = document.getElementById('diff-page-table-body');
const diffPageCount = document.getElementById('diff-page-count');
const diffDownloadBtn = document.getElementById('diff-download-btn');
const diffFilterChips = document.querySelectorAll('.diff-filter-chip');

const DIFF_GROUP_LABELS = { added: '新增问题', resolved: '已解决', persistent: '仍存在' };
const DIFF_STATUS_LABELS = { added: '新增页', removed: '移除页', retained: '保留页' };

let diffBaselineFile = null;
let diffDeliveryFile = null;
let diffReportData = null;
let activeDiffGroup = 'added';

function setDiffStatus(text, kind) {
  diffStatusEl.textContent = text || '';
  diffStatusEl.className = kind ? `status ${kind}` : 'status';
}

function updateDiffButton() {
  diffBtn.disabled = !diffBaselineFile || !diffDeliveryFile;
}

/**
 * 重新选择任一对比文件时清空上一次差异结果。
 */
function clearDiffReport() {
  diffReportData = null;
  diffReportEl.hidden = true;
  diffIssueListEl.innerHTML = '';
  diffPageTableBody.innerHTML = '';
  diffSummaryEl.innerHTML = '';
  diffMetaEl.innerHTML = '';
  diffVerdictEl.textContent = '';
}

function pickDiffFile(input, nameEl, which) {
  const file = input.files && input.files[0];
  clearDiffReport();
  if (!file) {
    if (which === 'baseline') {
      diffBaselineFile = null;
      nameEl.textContent = '点击选择基准 PDF';
    } else {
      diffDeliveryFile = null;
      nameEl.textContent = '点击选择待交付 PDF';
    }
    updateDiffButton();
    return;
  }
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    setDiffStatus('请选择 PDF 文件', 'error');
    input.value = '';
    return;
  }
  if (which === 'baseline') {
    diffBaselineFile = file;
  } else {
    diffDeliveryFile = file;
  }
  nameEl.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`;
  setDiffStatus('', '');
  updateDiffButton();
}

diffBaselineInput.addEventListener('change', () => {
  pickDiffFile(diffBaselineInput, diffBaselineName, 'baseline');
});
diffDeliveryInput.addEventListener('change', () => {
  pickDiffFile(diffDeliveryInput, diffDeliveryName, 'delivery');
});

diffBtn.addEventListener('click', async () => {
  if (!diffBaselineFile || !diffDeliveryFile) return;
  diffBtn.disabled = true;
  setDiffStatus('正在分别校验两份 PDF 并生成差异对比…', 'info');

  const form = new FormData();
  form.append('baseline', diffBaselineFile);
  form.append('delivery', diffDeliveryFile);

  try {
    const resp = await fetch('/api/preflight/diff', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `差异对比失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    diffReportData = await resp.json();
    activeDiffGroup = 'added';
    updateDiffFilterChips();
    renderDiffReport(diffReportData);
    const { summary } = diffReportData;
    if (summary.added.total > 0) {
      setDiffStatus(`对比完成：新增 ${summary.added.total} 项、已解决 ${summary.resolved.total} 项、`
        + `仍存在 ${summary.persistent.total} 项问题（按页计；文档级问题各计 1 项）。`, 'error');
    } else if (summary.persistent.total > 0) {
      setDiffStatus(`对比完成：无新增问题；已解决 ${summary.resolved.total} 项，`
        + `仍有 ${summary.persistent.total} 项问题存在。`, 'info');
    } else {
      setDiffStatus('对比完成：基准中的问题已全部解决，且未引入新问题。', 'info');
    }
  } catch (err) {
    clearDiffReport();
    setDiffStatus(err.message || '差异对比失败', 'error');
  } finally {
    diffBtn.disabled = false;
  }
});

function renderDiffMeta(data) {
  const { baseline, delivery, pageCount } = data;
  const deltaText = pageCount.delta === 0
    ? '页数一致'
    : (pageCount.delta > 0
      ? `增加 ${pageCount.delta} 页`
      : `减少 ${Math.abs(pageCount.delta)} 页`);
  const fileLine = (label, info) => {
    const name = info.file && info.file.name ? info.file.name : '未命名 PDF';
    return `<div class="diff-meta-item"><span class="diff-meta-label">${label}</span>`
      + `<span class="diff-meta-value">${escapeHtml(name)} · ${info.pageCount} 页</span></div>`;
  };
  diffMetaEl.innerHTML = fileLine('基准 PDF', baseline)
    + fileLine('待交付 PDF', delivery)
    + `<div class="diff-meta-item"><span class="diff-meta-label">页数变化</span>`
    + `<span class="diff-meta-value">${baseline.pageCount} → ${delivery.pageCount} 页（${deltaText}）`
    + `，新增页 ${pageCount.addedPages.length} / 移除页 ${pageCount.removedPages.length}</span></div>`;
}

function renderDiffSummary(data) {
  diffSummaryEl.innerHTML = '';
  const { summary } = data;
  const cards = [
    { level: 'error', label: '新增问题', count: summary.added.total },
    { level: 'ok', label: '已解决', count: summary.resolved.total },
    { level: 'warning', label: '仍存在', count: summary.persistent.total },
    { level: 'pages', label: '页数变化', count: data.pageCount.delta, signed: true },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    const numText = card.signed && card.count > 0 ? `+${card.count}` : String(card.count);
    div.innerHTML = `<span class="stat-num">${numText}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    diffSummaryEl.appendChild(div);
  }
}

function renderDiffVerdict(data) {
  const addedErrors = countSeverity(data.added, 'error');
  const resolvedErrors = countSeverity(data.resolved, 'error');
  const persistentErrors = countSeverity(data.persistent, 'error');
  diffVerdictEl.className = 'report-verdict '
    + (addedErrors > 0 || persistentErrors > 0 ? 'bad' : 'ok');
  diffVerdictEl.textContent = addedErrors > 0
    ? `结论：待交付版本引入了 ${addedErrors} 个错误级问题（仍存在错误 ${persistentErrors} 个，`
      + `已解决错误 ${resolvedErrors} 个），建议修复后再交付。`
    : (persistentErrors > 0
      ? `结论：未引入新的错误级问题；仍有 ${persistentErrors} 个错误级问题未解决`
        + `（已解决 ${resolvedErrors} 个），请确认后交付。`
      : `结论：待交付版本无错误级问题（已解决 ${resolvedErrors} 个错误，无残留错误）。`);
}

function countSeverity(entries, severity) {
  return entries
    .filter((entry) => entry.severity === severity)
    .reduce((sum, entry) => sum + (entry.documentLevel ? 1 : entry.pages.length), 0);
}

function updateDiffFilterChips() {
  diffFilterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.group === activeDiffGroup);
  });
}

diffFilterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeDiffGroup = chip.dataset.group;
    updateDiffFilterChips();
    if (diffReportData) renderDiffIssueList(diffReportData);
  });
});

function formatDiffPageList(pages) {
  if (!pages.length) return '—';
  return pages.map((p) => `第 ${p} 页`).join('、');
}

function renderDiffIssueList(data) {
  diffIssueListEl.innerHTML = '';
  const groups = { added: data.added, resolved: data.resolved, persistent: data.persistent };
  const entries = groups[activeDiffGroup];

  diffIssueEmptyEl.hidden = entries.length !== 0;
  diffIssueEmptyEl.textContent = entries.length === 0
    ? {
      added: '未发现新增问题：待交付版本没有引入新的印前问题。',
      resolved: '没有已解决的问题：基准中的问题在待交付版本中依然存在（或基准本无问题）。',
      persistent: '没有仍存在的问题：两个版本未在相同页码/文档级上同时命中同一问题。',
    }[activeDiffGroup]
    : '';

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = `issue ${entry.severity} diff-${activeDiffGroup}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const typeBadge = document.createElement('span');
    typeBadge.className = `diff-tag ${activeDiffGroup}`;
    typeBadge.textContent = DIFF_GROUP_LABELS[activeDiffGroup];
    const severityBadge = document.createElement('span');
    severityBadge.className = `severity-badge ${entry.severity}`;
    severityBadge.textContent = SEVERITY_LABELS[entry.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = entry.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = entry.documentLevel
      ? '整篇文档'
      : `${formatDiffPageList(entry.pages)}（${entry.pages.length} 页）`;
    head.append(typeBadge, severityBadge, title, range);
    li.appendChild(head);

    const dl = document.createElement('dl');
    dl.className = 'issue-values';
    const appendValue = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      dl.append(dt, dd);
    };
    if (entry.documentLevel) {
      appendValue('基准说明', entry.baselineDetail);
      appendValue('待交付说明', entry.deliveryDetail);
      if (activeDiffGroup === 'persistent' && entry.detailChanged) {
        const note = document.createElement('p');
        note.className = 'diff-detail-changed';
        note.textContent = '问题仍存在，但检测值已发生变化，见上。';
        li.appendChild(note);
      }
    } else {
      const detailText = (items) => items.length
        ? items.map((d) => `第 ${d.page} 页：${d.detail || '存在'}`).join('；')
        : '';
      if (activeDiffGroup === 'added') {
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
      } else if (activeDiffGroup === 'resolved') {
        appendValue('基准检测值', detailText(entry.baselineDetails));
      } else {
        appendValue('基准检测值', detailText(entry.baselineDetails));
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
        if (entry.detailChangedPages.length) {
          const note = document.createElement('p');
          note.className = 'diff-detail-changed';
          note.textContent = `检测值变化：${formatDiffPageList(entry.detailChangedPages)}`;
          li.appendChild(note);
        }
      }
    }
    li.appendChild(dl);

    if (entry.advice) {
      const advice = document.createElement('p');
      advice.className = 'issue-advice';
      advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(entry.advice)}`;
      li.appendChild(advice);
    }

    diffIssueListEl.appendChild(li);
  }
}

function metricCell(record) {
  if (!record) return '—';
  const text = record.textExtractable === null
    ? '无法判定'
    : (record.textExtractable ? '可提取' : '不可提取');
  return `${record.mediaWidth} × ${record.mediaHeight} pt`
    + ` / ${record.rotation}° / ${record.transparent ? '透明' : '不透明'} / ${text}`;
}

function changeMarks(changes) {
  if (!changes) return '';
  const marks = [];
  if (changes.sizeChanged) marks.push('尺寸变化');
  if (changes.rotationChanged) marks.push('旋转变化');
  if (changes.transparencyChanged) marks.push('透明度变化');
  if (changes.textChanged) marks.push('文字可提取性变化');
  return marks.length
    ? `<span class="diff-change-marks">${marks.map(escapeHtml).join('、')}</span>`
    : '';
}

function issueCodeChips(codes, group, codeTitles) {
  if (!codes.length) return '—';
  return codes
    .map((code) => `<span class="diff-code-chip ${group}">${escapeHtml(codeTitles[code] || code)}</span>`)
    .join(' ');
}

function renderDiffPageTable(data) {
  diffPageTableBody.innerHTML = '';
  diffPageCount.textContent = String(data.pages.length);

  // 代码 -> 标题，取自三个分组中的条目（兜底直接显示代码）
  const codeTitles = {};
  for (const group of ['added', 'resolved', 'persistent']) {
    for (const entry of data[group]) codeTitles[entry.code] = entry.title;
  }

  const frag = document.createDocumentFragment();
  for (const row of data.pages) {
    const tr = document.createElement('tr');
    tr.className = `diff-page-${row.status}`;
    const statusText = DIFF_STATUS_LABELS[row.status];
    const metrics = row.status === 'retained'
      ? `${metricCell(row.baseline)} → ${metricCell(row.delivery)}`
      : (row.baseline ? metricCell(row.baseline) : metricCell(row.delivery));
    tr.innerHTML = `<td>第 ${row.page} 页</td>`
      + `<td><span class="diff-page-status ${row.status}">${statusText}</span></td>`
      + `<td>${escapeHtml(metrics)} ${changeMarks(row.changes)}</td>`
      + `<td>${issueCodeChips(row.issues.added, 'added', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.resolved, 'resolved', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.persistent, 'persistent', codeTitles)}</td>`;
    frag.appendChild(tr);
  }
  diffPageTableBody.appendChild(frag);
}

function renderDiffReport(data) {
  renderDiffVerdict(data);
  renderDiffMeta(data);
  renderDiffSummary(data);
  document.getElementById('diff-count-added').textContent = String(data.added.length);
  document.getElementById('diff-count-resolved').textContent = String(data.resolved.length);
  document.getElementById('diff-count-persistent').textContent = String(data.persistent.length);
  renderDiffIssueList(data);
  renderDiffPageTable(data);
  diffReportEl.hidden = false;
}

diffDownloadBtn.addEventListener('click', () => {
  if (!diffReportData) return;
  const json = JSON.stringify(diffReportData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '印前报告差异对比.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 印刷用纸规格维护 ----------

const PAPER_STORAGE_KEY = 'booklet-imposer-papers-v1';
const PAPER_LIMIT = 8;
const DEFAULT_PAPERS = [
  { name: 'A3 铜版纸', widthMm: 420, heightMm: 297, pricePerSheet: 0.8, setupFee: 50 },
  { name: 'A2 胶版纸', widthMm: 424, heightMm: 594, pricePerSheet: 2.2, setupFee: 80 },
  { name: '正度对开 787×1092', widthMm: 546, heightMm: 787, pricePerSheet: 1.6, setupFee: 60 },
];

const paperTableBody = document.getElementById('paper-table-body');
const paperAddBtn = document.getElementById('paper-add-btn');
const paperResetBtn = document.getElementById('paper-reset-btn');
const paperErrorEl = document.getElementById('paper-error');

const quoteBoxEl = document.getElementById('quote-box');
const quoteStatusEl = document.getElementById('quote-status');
const quoteResultEl = document.getElementById('quote-result');
const quoteRefreshBtn = document.getElementById('quote-refresh-btn');
const quoteDownloadBtn = document.getElementById('quote-download-btn');

let paperRows = [];
let lastPlan = null;
let quoteData = null;
let chosenOptionIndex = null;

/**
 * 从 localStorage 读取已保存的纸张规格；损坏/缺失时回退默认值。
 * @returns {Array<object>}
 */
function loadStoredPapers() {
  try {
    const raw = localStorage.getItem(PAPER_STORAGE_KEY);
    if (!raw) return DEFAULT_PAPERS.map((p) => ({ ...p }));
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)
      && parsed.length > 0
      && parsed.every((p) => p && typeof p === 'object')) {
      return parsed.slice(0, PAPER_LIMIT).map((p, i) => ({
        name: typeof p.name === 'string' ? p.name : `纸张 ${i + 1}`,
        widthMm: String(p.widthMm ?? ''),
        heightMm: String(p.heightMm ?? ''),
        pricePerSheet: String(p.pricePerSheet ?? ''),
        setupFee: String(p.setupFee ?? ''),
      }));
    }
  } catch (_) { /* 存储损坏时使用默认 */ }
  return DEFAULT_PAPERS.map((p) => ({ ...p }));
}

function persistPapers() {
  try {
    localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(paperRows));
  } catch (_) { /* 隐私模式等场景下忽略持久化失败 */ }
}

/**
 * 从表格中读取当前全部纸张规格。
 * @returns {{ papers: Array, errors: Array<string> }}
 */
function readPaperInputs() {
  const papers = [];
  const errors = [];
  paperTableBody.querySelectorAll('tr.paper-row').forEach((tr, i) => {
    const inputs = tr.querySelectorAll('input');
    const [nameInput, widthInput, heightInput, priceInput, setupInput] = inputs;
    const name = nameInput.value.trim() || `纸张 ${i + 1}`;
    const widthMm = Number(widthInput.value);
    const heightMm = Number(heightInput.value);
    const pricePerSheet = Number(priceInput.value);
    const setupFee = Number(setupInput.value);

    let bad = false;
    for (const input of [widthInput, heightInput, priceInput, setupInput]) {
      input.classList.toggle('invalid', false);
    }
    if (!(widthMm > 0)) {
      widthInput.classList.add('invalid');
      bad = true;
    }
    if (!(heightMm > 0)) {
      heightInput.classList.add('invalid');
      bad = true;
    }
    if (!(pricePerSheet >= 0)) {
      priceInput.classList.add('invalid');
      bad = true;
    }
    if (!(setupFee >= 0)) {
      setupInput.classList.add('invalid');
      bad = true;
    }
    if (bad) {
      errors.push(`纸张「${name}」的宽/高必须为正数，单价与开机费不能为负`);
      return;
    }
    papers.push({ name, widthMm, heightMm, pricePerSheet, setupFee });
  });
  return { papers, errors };
}

function syncPaperRowsFromDom() {
  paperRows = [];
  paperTableBody.querySelectorAll('tr.paper-row').forEach((tr) => {
    const inputs = tr.querySelectorAll('input');
    paperRows.push({
      name: inputs[0].value,
      widthMm: inputs[1].value,
      heightMm: inputs[2].value,
      pricePerSheet: inputs[3].value,
      setupFee: inputs[4].value,
    });
  });
  persistPapers();
  paperAddBtn.disabled = paperRows.length >= PAPER_LIMIT;
}

function addPaperRow(paper = { name: '', widthMm: '', heightMm: '', pricePerSheet: '', setupFee: '' }) {
  const tr = document.createElement('tr');
  tr.className = 'paper-row';

  const mkCell = (value, { type = 'number', step, min, placeholder } = {}) => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = type;
    input.className = 'paper-input';
    if (type === 'number') {
      input.step = step || 'any';
      if (min !== undefined) input.min = min;
    }
    if (placeholder) input.placeholder = placeholder;
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('input', () => {
      syncPaperRowsFromDom();
      paperErrorEl.textContent = '';
      markQuoteStale();
    });
    td.appendChild(input);
    return td;
  };

  tr.appendChild(mkCell(paper.name, { type: 'text', placeholder: '如 A3 铜版' }));
  tr.appendChild(mkCell(paper.widthMm, { min: 0, placeholder: '宽' }));
  tr.appendChild(mkCell(paper.heightMm, { min: 0, placeholder: '高' }));
  tr.appendChild(mkCell(paper.pricePerSheet, { min: 0, placeholder: '0.00' }));
  tr.appendChild(mkCell(paper.setupFee, { min: 0, placeholder: '0.00' }));

  const opTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'paper-del-btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', () => {
    tr.remove();
    syncPaperRowsFromDom();
    paperErrorEl.textContent = '';
    markQuoteStale();
  });
  opTd.appendChild(delBtn);
  tr.appendChild(opTd);

  paperTableBody.appendChild(tr);
}

function renderPaperRows(rows) {
  paperTableBody.innerHTML = '';
  for (const paper of rows) addPaperRow(paper);
  syncPaperRowsFromDom();
}

paperAddBtn.addEventListener('click', () => {
  if (paperTableBody.querySelectorAll('tr.paper-row').length >= PAPER_LIMIT) return;
  addPaperRow();
  syncPaperRowsFromDom();
});

paperResetBtn.addEventListener('click', () => {
  renderPaperRows(DEFAULT_PAPERS.map((p) => ({
    name: p.name,
    widthMm: String(p.widthMm),
    heightMm: String(p.heightMm),
    pricePerSheet: String(p.pricePerSheet),
    setupFee: String(p.setupFee),
  })));
  paperErrorEl.textContent = '';
  markQuoteStale();
});

renderPaperRows(loadStoredPapers());

// ---------- 用纸报价 ----------

function clearQuote() {
  quoteData = null;
  lastPlan = null;
  chosenOptionIndex = null;
  quoteBoxEl.hidden = true;
  quoteResultEl.hidden = true;
  quoteResultEl.innerHTML = '';
  quoteStatusEl.textContent = '';
  quoteStatusEl.className = 'status';
}

/**
 * 纸张规格编辑后，若已有拼版结果，提示报价可能已过期（不自动请求）。
 */
function markQuoteStale() {
  if (lastPlan && quoteData && !quoteRefreshBtn.dataset.stale) {
    quoteRefreshBtn.dataset.stale = '1';
    quoteRefreshBtn.classList.add('stale');
    quoteStatusEl.textContent = '纸张规格已修改，点击「按当前纸张重新报价」更新。';
    quoteStatusEl.className = 'status info';
  }
  // 裁切模块复用同一套纸张规格，一并标记为需重新计算
  if (typeof markCuttingStale === 'function') markCuttingStale();
}

async function requestQuote(plan) {
  lastPlan = plan;
  quoteRefreshBtn.disabled = true;
  quoteRefreshBtn.dataset.stale = '';
  quoteRefreshBtn.classList.remove('stale');
  quoteBoxEl.hidden = false;
  quoteResultEl.hidden = true;
  quoteStatusEl.textContent = '正在根据拼版方案计算用纸报价…';
  quoteStatusEl.className = 'status info';

  const { papers, errors } = readPaperInputs();
  syncPaperRowsFromDom();
  if (errors.length) {
    paperErrorEl.textContent = errors.join('；');
    quoteRefreshBtn.disabled = false;
    quoteStatusEl.textContent = '纸张规格存在未填或非法项，已暂停报价，请先修正后重新报价。';
    quoteStatusEl.className = 'status error';
    return;
  }
  paperErrorEl.textContent = '';
  if (papers.length === 0) {
    quoteRefreshBtn.disabled = false;
    quoteStatusEl.textContent = '尚未维护任何纸张规格，请先在上方增加至少一种。';
    quoteStatusEl.className = 'status error';
    return;
  }

  try {
    const resp = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, papers }),
    });
    if (!resp.ok) {
      let message = `报价失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 使用默认提示 */ }
      throw new Error(message);
    }
    quoteData = await resp.json();
    chosenOptionIndex = quoteData.selected ? quoteData.selected.index : null;
    renderQuoteResult();
    if (quoteData.feasible) {
      quoteStatusEl.textContent = `已选最低成本方案：${quoteData.selected.name}`
        + `（有效利用率 ${quoteData.selected.utilizationPercent}%，总价 ¥${quoteData.selected.totalCost.toFixed(2)}）。`;
      quoteStatusEl.className = 'status info';
    } else {
      quoteStatusEl.textContent = '维护的纸张均无法容纳版面，见下方原因。';
      quoteStatusEl.className = 'status error';
    }
  } catch (err) {
    quoteData = null;
    quoteResultEl.hidden = true;
    quoteStatusEl.textContent = err.message || '报价失败';
    quoteStatusEl.className = 'status error';
  } finally {
    quoteRefreshBtn.disabled = false;
  }
}

quoteRefreshBtn.addEventListener('click', () => {
  if (lastPlan) requestQuote(lastPlan);
});

const fmtMoney = (v) => `¥${Number(v).toFixed(2)}`;
const fmtMm = (v) => `${Number(v).toFixed(1)} mm`;

/**
 * 渲染报价结果：可行时列出全部纸张并允许切换方案；不可行时给出每种纸张的原因。
 */
function renderQuoteResult() {
  quoteResultEl.innerHTML = '';

  const { layout } = quoteData;
  const layoutLine = document.createElement('p');
  layoutLine.className = 'quote-layout';
  layoutLine.textContent = `单张印张展开尺寸 ${fmtMm(layout.sheet.widthMm)} × ${fmtMm(layout.sheet.heightMm)}`
    + `（统一面板 ${fmtMm(layout.panel.widthMm)} × ${fmtMm(layout.panel.heightMm)}）`
    + `；共 ${layout.sheetCount} 张纸，开机 ${layout.runCount} 次`
    + (layout.signatureMode ? `（${layout.signatureCount} 帖，每帖各 1 次）` : '');
  quoteResultEl.appendChild(layoutLine);

  if (!quoteData.feasible) {
    const banner = document.createElement('div');
    banner.className = 'quote-infeasible';
    banner.textContent = quoteData.reason;
    quoteResultEl.appendChild(banner);
  }

  const list = document.createElement('div');
  list.className = 'quote-options';
  for (const opt of quoteData.options) {
    list.appendChild(renderQuoteOption(opt));
  }
  quoteResultEl.appendChild(list);
  quoteResultEl.hidden = false;
}

function renderQuoteOption(opt) {
  const card = document.createElement('div');
  card.className = 'quote-option';
  if (!opt.fits) card.classList.add('infeasible');
  if (opt.fits && opt.index === chosenOptionIndex) card.classList.add('chosen');

  const head = document.createElement('div');
  head.className = 'quote-option-head';

  const title = document.createElement('div');
  title.className = 'quote-option-title';
  if (opt.fits) {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'quote-paper';
    radio.checked = opt.index === chosenOptionIndex;
    radio.addEventListener('change', () => {
      chosenOptionIndex = opt.index;
      quoteResultEl.querySelectorAll('.quote-option').forEach((el) => {
        el.classList.toggle('chosen', el.dataset.index === String(opt.index));
      });
    });
    title.appendChild(radio);
  }
  const name = document.createElement('strong');
  name.textContent = opt.name;
  title.appendChild(name);
  const spec = document.createElement('span');
  spec.className = 'quote-option-spec';
  spec.textContent = `${opt.paper.widthMm} × ${opt.paper.heightMm} mm`;
  title.appendChild(spec);
  head.appendChild(title);

  const total = document.createElement('div');
  total.className = 'quote-total';
  total.textContent = opt.fits ? fmtMoney(opt.totalCost) : '无法使用';
  head.appendChild(total);
  card.appendChild(head);

  if (opt.fits) {
    const grid = document.createElement('dl');
    grid.className = 'quote-detail';
    const placementText = opt.placement.rotated ? '纸张旋转 90°' : '纸张原向';
    const items = [
      ['摆放方向', `${placementText}（用纸 ${opt.placement.paperWidthUsedMm} × ${opt.placement.paperHeightUsedMm} mm）`],
      ['有效利用率', `${opt.utilizationPercent}%`],
      ['纸张费', `${fmtMoney(opt.paperCost)}（${opt.sheetCount} 张 × ¥${opt.paper.pricePerSheet}）`],
      ['开机费', `${fmtMoney(opt.setupCost)}（${opt.runCount} 次 × ¥${opt.paper.setupFee}）`],
      ['总价', fmtMoney(opt.totalCost)],
    ];
    for (const [label, value] of items) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (label === '总价') dd.className = 'quote-detail-total';
      grid.append(dt, dd);
    }
    card.appendChild(grid);
  } else {
    const reasons = document.createElement('ul');
    reasons.className = 'quote-reasons';
    for (const r of opt.reasons) {
      const li = document.createElement('li');
      li.textContent = r.message;
      reasons.appendChild(li);
    }
    card.appendChild(reasons);
  }

  card.dataset.index = String(opt.index);
  return card;
}

quoteDownloadBtn.addEventListener('click', () => {
  if (!quoteData) return;
  // 下载内容反映用户在页面上切换后选中的纸张方案
  const chosen = quoteData.feasible
    ? quoteData.options.find((o) => o.fits && o.index === chosenOptionIndex) || quoteData.selected
    : null;
  const payload = {
    ...quoteData,
    selected: chosen,
    chosenPaperIndex: chosen ? chosen.index : null,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-用纸报价.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 批量裁切下料 ----------

const CUTTING_MAX = 1000000;

const cuttingBoxEl = document.getElementById('cutting-box');
const cuttingRequiredInput = document.getElementById('cutting-required');
const cuttingCalcBtn = document.getElementById('cutting-calc-btn');
const cuttingStatusEl = document.getElementById('cutting-status');
const cuttingResultEl = document.getElementById('cutting-result');
const cuttingDownloadBtn = document.getElementById('cutting-download-btn');

let cuttingData = null;

function setCuttingStatus(text, kind) {
  cuttingStatusEl.textContent = text || '';
  cuttingStatusEl.className = kind ? `status ${kind}` : 'status';
}

function clearCutting() {
  cuttingData = null;
  cuttingBoxEl.hidden = true;
  cuttingResultEl.hidden = true;
  cuttingResultEl.innerHTML = '';
  cuttingStatusEl.textContent = '';
  cuttingStatusEl.className = 'status';
  cuttingCalcBtn.disabled = false;
  cuttingCalcBtn.dataset.stale = '';
  cuttingCalcBtn.classList.remove('stale');
  // 每次重新选择文件/拼版都回到默认 1 个印张，避免沿用上一份文档的数量
  if (document.activeElement !== cuttingRequiredInput) {
    cuttingRequiredInput.value = '1';
  }
  cuttingRequiredInput.classList.remove('invalid');
}

/**
 * 读取所需印张数：仅接受 1～CUTTING_MAX 的整数。
 * @returns {number|null}
 */
function readRequiredSheets() {
  const raw = cuttingRequiredInput.value;
  if (!/^\s*\d+\s*$/.test(raw)) {
    cuttingRequiredInput.classList.add('invalid');
    setCuttingStatus(`请填写所需印张数（1～${CUTTING_MAX} 的整数）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > CUTTING_MAX) {
    cuttingRequiredInput.classList.add('invalid');
    setCuttingStatus(`所需印张数必须在 1～${CUTTING_MAX} 之间`, 'error');
    return null;
  }
  cuttingRequiredInput.classList.remove('invalid');
  return value;
}

cuttingRequiredInput.addEventListener('input', () => {
  cuttingRequiredInput.classList.remove('invalid');
  markCuttingStale();
});

/**
 * 纸张规格或印张数变化后标记方案过期（不自动请求，与报价交互保持一致）。
 */
function markCuttingStale() {
  if (lastPlan && cuttingData && !cuttingCalcBtn.dataset.stale) {
    cuttingCalcBtn.dataset.stale = '1';
    cuttingCalcBtn.classList.add('stale');
    setCuttingStatus('纸张规格或印张数已修改，点击「计算裁切方案」更新。', 'info');
  }
}

async function requestCutting(plan) {
  cuttingBoxEl.hidden = false;
  cuttingResultEl.hidden = true;
  cuttingResultEl.innerHTML = '';
  cuttingCalcBtn.disabled = true;
  cuttingCalcBtn.dataset.stale = '';
  cuttingCalcBtn.classList.remove('stale');

  const requiredSheets = readRequiredSheets();
  if (requiredSheets === null) {
    cuttingCalcBtn.disabled = false;
    cuttingData = null;
    return;
  }

  const { papers, errors } = readPaperInputs();
  if (errors.length) {
    paperErrorEl.textContent = errors.join('；');
    cuttingCalcBtn.disabled = false;
    cuttingData = null;
    setCuttingStatus('纸张规格存在未填或非法项，已暂停裁切计算，请先修正后重新计算。', 'error');
    return;
  }
  if (papers.length === 0) {
    cuttingCalcBtn.disabled = false;
    cuttingData = null;
    setCuttingStatus('尚未维护任何纸张规格，请先在上方增加至少一种。', 'error');
    return;
  }
  paperErrorEl.textContent = '';
  setCuttingStatus('正在用直线贯通分割搜索计算各原纸的裁切方案…', 'info');

  try {
    const resp = await fetch('/api/cutting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, papers, requiredSheets }),
    });
    if (!resp.ok) {
      let message = `裁切计算失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 使用默认提示 */ }
      throw new Error(message);
    }
    cuttingData = await resp.json();
    renderCuttingResult();
    if (cuttingData.feasible) {
      const rec = cuttingData.options.find((o) => o.index === cuttingData.recommended.index);
      setCuttingStatus(
        `推荐方案：${rec.name}（每张出 ${rec.yieldsPerSheet} 个印张，`
        + `共需原纸 ${rec.sheetsRequired} 张，总废料 ${fmtArea(rec.waste.totalAreaMm2)}）。`,
        'info',
      );
    } else {
      setCuttingStatus('维护的原纸均无法裁出该印张，见下方原因。', 'error');
    }
  } catch (err) {
    cuttingData = null;
    cuttingResultEl.hidden = true;
    setCuttingStatus(err.message || '裁切计算失败', 'error');
  } finally {
    cuttingCalcBtn.disabled = false;
  }
}

cuttingCalcBtn.addEventListener('click', () => {
  if (lastPlan) requestCutting(lastPlan);
});

const fmtArea = (v) => `${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} mm²`;

/**
 * 渲染裁切结果：顶部印张信息 + 可行/不可行方案卡片（按服务端推荐顺序排列）。
 */
function renderCuttingResult() {
  cuttingResultEl.innerHTML = '';

  const { layout, requiredSheets } = cuttingData;
  const info = document.createElement('p');
  info.className = 'cutting-layout';
  info.textContent = `印张实际输出尺寸 ${fmtMm(layout.sheet.widthMm)} × ${fmtMm(layout.sheet.heightMm)}`
    + `；需要 ${requiredSheets} 个印张。下方方案均由可执行的直线贯通裁切树生成`
    + '（非面积估算，印张之间无重叠），按所需原纸张数、废料面积依次推荐。';
  cuttingResultEl.appendChild(info);

  if (!cuttingData.feasible) {
    const banner = document.createElement('div');
    banner.className = 'cutting-infeasible';
    banner.textContent = cuttingData.reason;
    cuttingResultEl.appendChild(banner);
  }

  const list = document.createElement('div');
  list.className = 'cutting-options';
  // 可行方案按服务端推荐顺序（所需原纸张数 → 废料面积）排列，不可行方案置后
  const ordered = cuttingData.options.slice().sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (!a.feasible) return a.index - b.index;
    if (a.sheetsRequired !== b.sheetsRequired) return a.sheetsRequired - b.sheetsRequired;
    if (a.waste.totalAreaMm2 !== b.waste.totalAreaMm2) {
      return a.waste.totalAreaMm2 - b.waste.totalAreaMm2;
    }
    return a.index - b.index;
  });
  ordered.forEach((opt, rank) => {
    list.appendChild(renderCuttingOption(opt, rank));
  });
  cuttingResultEl.appendChild(list);
  cuttingResultEl.hidden = false;
}

function renderCuttingOption(opt, rank) {
  const card = document.createElement('div');
  card.className = 'cutting-option';
  if (!opt.feasible) {
    card.classList.add('infeasible');
  } else if (opt.index === cuttingData.recommended.index) {
    card.classList.add('recommended');
  }

  const head = document.createElement('div');
  head.className = 'cutting-option-head';
  const title = document.createElement('div');
  title.className = 'cutting-option-title';
  if (opt.feasible && opt.index === cuttingData.recommended.index) {
    const badge = document.createElement('span');
    badge.className = 'cutting-badge';
    badge.textContent = '推荐';
    title.appendChild(badge);
  }
  if (opt.feasible) {
    const rankEl = document.createElement('span');
    rankEl.className = 'cutting-rank';
    rankEl.textContent = `方案 ${rank + 1}`;
    title.appendChild(rankEl);
  }
  const name = document.createElement('strong');
  name.textContent = opt.name;
  title.appendChild(name);
  const spec = document.createElement('span');
  spec.className = 'cutting-option-spec';
  spec.textContent = `原纸 ${opt.paper.widthMm} × ${opt.paper.heightMm} mm`;
  title.appendChild(spec);
  head.appendChild(title);
  card.appendChild(head);

  if (!opt.feasible) {
    if (opt.reasons && opt.reasons.length) {
      const reasons = document.createElement('ul');
      reasons.className = 'cutting-reasons';
      for (const r of opt.reasons) {
        const li = document.createElement('li');
        li.textContent = r.message;
        reasons.appendChild(li);
      }
      card.appendChild(reasons);
    } else {
      const p = document.createElement('p');
      p.className = 'cutting-reasons-text';
      p.textContent = opt.reason || '无法裁出该印张';
      card.appendChild(p);
    }
    return card;
  }

  const grid = document.createElement('dl');
  grid.className = 'cutting-detail';
  const placementText = opt.placement.rotated ? '原纸旋转 90°' : '原纸原向';
  const rotationLine = opt.placement.rotatedItemCount > 0
    ? `（其中 ${opt.placement.rotatedItemCount} 个印张旋转 90° 摆放）`
    : '';
  const lastText = opt.lastSheet.isLastSheetPartial
    ? `前 ${opt.lastSheet.fullSheets} 张各出 ${opt.yieldsPerSheet} 个，`
      + `尾张出 ${opt.lastSheet.lastSheetYield} 个（尾张尚余 ${opt.lastSheet.spareCapacity} 个位）`
    : `${opt.sheetsRequired} 张均出满 ${opt.yieldsPerSheet} 个，无尾张余量`;
  const items = [
    ['摆放方向', `${placementText}，版面 ${opt.placement.frameWidthMm} × ${opt.placement.frameHeightMm} mm${rotationLine}`],
    ['单张产出', `${opt.yieldsPerSheet} 个印张（共 ${opt.cutting.cutCount} 刀贯通裁切）`],
    ['所需原纸张数', `${opt.sheetsRequired} 张`],
    ['尾张余量', lastText],
    ['单张废料', `${fmtArea(opt.waste.perSheetAreaMm2)}（印张利用率 ${opt.utilizationPercent}%）`],
    ['总废料面积', fmtArea(opt.waste.totalAreaMm2)],
  ];
  for (const [label, value] of items) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (label === '所需原纸张数') dd.className = 'cutting-detail-key';
    grid.append(dt, dd);
  }
  card.appendChild(grid);

  card.appendChild(buildCuttingDiagram(opt));
  card.appendChild(buildCutOrder(opt));
  return card;
}

/**
 * 按原纸真实比例绘制 SVG 裁切图：原纸边框、贯通裁切线、印张（旋转印张用
 * 浅色区分）、尺寸标注。坐标取自服务端裁切树展平后的绝对 mm 坐标。
 */
function buildCuttingDiagram(opt) {
  const wrap = document.createElement('div');
  wrap.className = 'cutting-diagram-wrap';

  const frameW = opt.placement.frameWidthMm;
  const frameH = opt.placement.frameHeightMm;
  // 图宽固定 320px，等比缩放
  const pxPerMm = 320 / frameW;
  const widthPx = frameW * pxPerMm;
  const heightPx = frameH * pxPerMm;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'cutting-diagram');
  svg.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
  svg.setAttribute('width', widthPx.toFixed(1));
  svg.setAttribute('height', heightPx.toFixed(1));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `${opt.name} 裁切图：${frameW} × ${frameH} mm 原纸，每张裁出 ${opt.yieldsPerSheet} 个印张`);

  // 原纸底色与边框
  const bg = document.createElementNS(svgNS, 'rect');
  bg.setAttribute('x', 0); bg.setAttribute('y', 0);
  bg.setAttribute('width', widthPx); bg.setAttribute('height', heightPx);
  bg.setAttribute('class', 'cut-paper-bg');
  svg.appendChild(bg);

  // 印张位
  opt.cutting.items.forEach((item, i) => {
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', (item.xMm * pxPerMm).toFixed(2));
    rect.setAttribute('y', (item.yMm * pxPerMm).toFixed(2));
    rect.setAttribute('width', (item.widthMm * pxPerMm).toFixed(2));
    rect.setAttribute('height', (item.heightMm * pxPerMm).toFixed(2));
    rect.setAttribute('class', item.rotated ? 'cut-item rotated' : 'cut-item');
    svg.appendChild(rect);

    // 位编号（过小则不标文字，避免重叠成糊块）
    if (item.widthMm * pxPerMm >= 26 && item.heightMm * pxPerMm >= 16) {
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', ((item.xMm + item.widthMm / 2) * pxPerMm).toFixed(2));
      label.setAttribute('y', ((item.yMm + item.heightMm / 2) * pxPerMm).toFixed(2));
      label.setAttribute('class', 'cut-item-label');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.textContent = String(i + 1);
      svg.appendChild(label);
    }
  });

  // 贯通裁切线（执行顺序编号已在下方列表给出）
  opt.cutting.cuts.forEach((cut) => {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', (cut.x1Mm * pxPerMm).toFixed(2));
    line.setAttribute('y1', (cut.y1Mm * pxPerMm).toFixed(2));
    line.setAttribute('x2', (cut.x2Mm * pxPerMm).toFixed(2));
    line.setAttribute('y2', (cut.y2Mm * pxPerMm).toFixed(2));
    line.setAttribute('class', 'cut-line');
    svg.appendChild(line);
  });

  const frame = document.createElementNS(svgNS, 'rect');
  frame.setAttribute('x', 0); frame.setAttribute('y', 0);
  frame.setAttribute('width', widthPx); frame.setAttribute('height', heightPx);
  frame.setAttribute('class', 'cut-paper-frame');
  svg.appendChild(frame);

  wrap.appendChild(svg);

  const caption = document.createElement('p');
  caption.className = 'cutting-diagram-caption';
  caption.textContent = `裁切图（按比例）：${frameW} × ${frameH} mm，`
    + `红虚线为贯通裁切线，深色块为印张（${opt.cutting.item.widthMm} × `
    + `${opt.cutting.item.heightMm} mm），浅色块为旋转 90° 的印张。`;
  wrap.appendChild(caption);
  return wrap;
}

/**
 * 现场裁切顺序列表：cuts 已由服务端按先序（先切当前矩形再切子矩形）给出。
 */
function buildCutOrder(opt) {
  const details = document.createElement('details');
  details.className = 'cut-order-box';
  const summary = document.createElement('summary');
  summary.textContent = `裁切顺序（${opt.cutting.cutCount} 刀，按此顺序每刀均为贯通直线）`;
  details.appendChild(summary);
  if (opt.cutting.cutCount === 0) {
    const p = document.createElement('p');
    p.className = 'cut-order-empty';
    p.textContent = '原纸尺寸与印张一致，无需裁切。';
    details.appendChild(p);
    return details;
  }
  const ol = document.createElement('ol');
  ol.className = 'cut-order-list';
  opt.cutting.cuts.forEach((cut, i) => {
    const li = document.createElement('li');
    let pos;
    if (cut.direction === 'v') {
      // x1 为距原纸左边的绝对位置；该刀贯通当前料件
      pos = `在 ${cut.pieceWidthMm} × ${cut.pieceHeightMm} mm 料件上，`
        + `距料件左边 ${Math.round((cut.x1Mm - cut.pieceXMm) * 100) / 100} mm 处竖切贯通`
        + `（线长 ${cut.pieceHeightMm} mm）`;
    } else {
      const fromBottom = Math.round(
        (cut.pieceYMm + cut.pieceHeightMm - cut.y1Mm) * 100,
      ) / 100;
      pos = `在 ${cut.pieceWidthMm} × ${cut.pieceHeightMm} mm 料件上，`
        + `距料件下边 ${fromBottom} mm 处横切贯通（线长 ${cut.pieceWidthMm} mm）`;
    }
    li.textContent = `第 ${i + 1} 刀：${pos}`;
    ol.appendChild(li);
  });
  details.appendChild(ol);
  return details;
}

cuttingDownloadBtn.addEventListener('click', () => {
  if (!cuttingData) return;
  const json = JSON.stringify(cuttingData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-批量裁切下料.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- 缺页补印 ----------

function setReprintStatus(text, kind) {
  reprintStatusEl.textContent = text || '';
  reprintStatusEl.className = kind ? `status ${kind}` : 'status';
}

/**
 * 清空补印结果（重新拼版/换文件时调用）：回收旧补印 PDF、隐藏命中列表；
 * 保留输入框中的页码，便于修正后重新生成。
 */
function clearReprint() {
  if (reprintBlobUrl) {
    URL.revokeObjectURL(reprintBlobUrl);
    reprintBlobUrl = null;
  }
  reprintData = null;
  lastImposeOptions = null;
  reprintBoxEl.hidden = true;
  reprintResultEl.hidden = true;
  reprintResultEl.innerHTML = '';
  reprintStatusEl.textContent = '';
  reprintStatusEl.className = 'status';
  reprintPagesInput.classList.remove('invalid');
  reprintDownloadBtn.disabled = true;
}

/**
 * 渲染补印命中列表：每张补印纸的帖号（分册模式）、帖内张号与命中页码。
 */
function renderReprintResult(data) {
  reprintResultEl.innerHTML = '';

  const layout = document.createElement('p');
  layout.className = 'reprint-layout';
  const creepText = data.creep && data.creep.enabled
    ? `沿用本次纸厚 ${data.creep.paperThicknessMm} mm 的爬移补偿（与完整拼版对应印张一致），`
    : '';
  layout.textContent = `受损页码：${data.pages.map((p) => `第 ${p} 页`).join('、')}；`
    + `命中 ${data.sheetCount} 张印张（同一印张命中多页只补印一次），`
    + `${creepText}按原印张顺序正背成对输出，补印 PDF 共 ${data.pageCount} 页。`;
  reprintResultEl.appendChild(layout);

  const list = document.createElement('ul');
  list.className = 'reprint-sheet-list';
  for (const sheet of data.sheets) {
    const li = document.createElement('li');
    li.className = 'reprint-sheet-item';

    const title = document.createElement('span');
    title.className = 'reprint-sheet-title';
    const shiftText = sheet.creepShiftMm > 0
      ? ` · 单侧内移 ${formatShiftMm(sheet.creepShiftMm)} mm`
      : '';
    title.textContent = sheet.signature !== null && sheet.signature !== undefined
      ? `第 ${sheet.signature} 帖 · 帖内第 ${sheet.sheet} 张纸 / 共 ${sheet.signatureSheetCount} 张${shiftText}`
      : `第 ${sheet.sheet} 张纸${shiftText}`;

    const hit = document.createElement('span');
    hit.className = 'reprint-sheet-pages';
    hit.textContent = `命中页码：${sheet.hitPages.map((p) => `第 ${p} 页`).join('、')}`;

    li.append(title, hit);
    list.appendChild(li);
  }
  reprintResultEl.appendChild(list);
  reprintResultEl.hidden = false;
}

reprintPagesInput.addEventListener('input', () => {
  reprintPagesInput.classList.remove('invalid');
});

reprintBtn.addEventListener('click', async () => {
  if (!selectedFile || !lastImposeOptions) return;

  const pagesValue = reprintPagesInput.value;
  if (!pagesValue || !pagesValue.trim()) {
    reprintPagesInput.classList.add('invalid');
    setReprintStatus('请输入需要补印的原稿页码或区间（如 2,5-7）', 'error');
    return;
  }
  reprintPagesInput.classList.remove('invalid');

  reprintBtn.disabled = true;
  setReprintStatus('正在按本次拼版方案定位受损页并生成补印 PDF…', 'info');
  // 清空上一次补印结果（保留输入框内容便于修改后重新生成）
  if (reprintBlobUrl) {
    URL.revokeObjectURL(reprintBlobUrl);
    reprintBlobUrl = null;
  }
  reprintData = null;
  reprintResultEl.hidden = true;
  reprintResultEl.innerHTML = '';
  reprintDownloadBtn.disabled = true;

  const form = new FormData();
  form.append('pdf', selectedFile);
  form.append('pages', pagesValue.trim());
  if (lastImposeOptions.signatureMode) {
    form.append('signatureMode', 'on');
    form.append('maxSheetsPerSignature', String(lastImposeOptions.maxSheetsPerSignature));
  }
  if (lastImposeOptions.registrationMarks) {
    form.append('registrationMarks', 'on');
  }
  if (lastImposeOptions.creepCompensation) {
    form.append('creepCompensation', 'on');
    form.append('paperThicknessMm', String(lastImposeOptions.paperThicknessMm));
  }

  try {
    const resp = await fetch('/api/reprint', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `补印失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      if (resp.status === 400) reprintPagesInput.classList.add('invalid');
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Reprint-Plan');
    if (!planHeader) throw new Error('响应缺少补印方案');
    reprintData = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    reprintBlobUrl = URL.createObjectURL(blob);

    renderReprintResult(reprintData);
    reprintDownloadBtn.disabled = false;
    setReprintStatus(
      `补印 PDF 已生成：共 ${reprintData.sheetCount} 张纸（${reprintData.pageCount} 页），可下载。`,
      'info',
    );
  } catch (err) {
    setReprintStatus(err.message || '补印失败', 'error');
  } finally {
    reprintBtn.disabled = false;
  }
});

reprintDownloadBtn.addEventListener('click', () => {
  if (!reprintBlobUrl) return;
  const a = document.createElement('a');
  a.href = reprintBlobUrl;
  a.download = `${resultBaseName}-补印.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ---------- 批量印前校验 ----------

const BATCH_FILE_LIMIT = 10;
const BATCH_POLICY_STORAGE_KEY = 'booklet-imposer-batch-release-policy-v1';

// 问题代码元数据：与服务端 lib/preflight.js 的 ISSUE_META 保持一致，
// 用于在页面上编辑放行策略（具体判定一律以服务端返回为准）。
const BATCH_CODE_META = [
  { code: 'rotated_180', title: '页面带 180° 旋转（上下颠倒）', severity: 'error' },
  { code: 'size_mismatch', title: '页面尺寸不一致', severity: 'warning' },
  { code: 'rotated_90_270', title: '页面带 90°/270° 旋转角', severity: 'warning' },
  { code: 'transparency', title: '页面包含透明效果', severity: 'warning' },
  { code: 'no_extractable_text', title: '未检测到可提取文字', severity: 'info' },
  { code: 'blank_padding', title: '页数不是 4 的倍数，拼版将补空白页', severity: 'info' },
];

// 未配置时代码按检测级别套用的默认处置：错误阻断、警告复核、提示忽略
const BATCH_DEFAULT_ACTION_BY_SEVERITY = { error: 'block', warning: 'warn', info: 'ignore' };

const RELEASE_ACTION_LABELS = { block: '阻断交付', warn: '需复核', ignore: '忽略' };
const RELEASE_DECISION_LABELS = {
  blocked: '阻断交付',
  review: '需复核',
  passed: '放行',
  undetermined: '未判定',
};

const batchFilesInput = document.getElementById('batch-files-input');
const batchPickName = document.getElementById('batch-pick-name');
const batchFileListEl = document.getElementById('batch-file-list');
const batchRunBtn = document.getElementById('batch-run-btn');
const batchClearBtn = document.getElementById('batch-clear-btn');
const batchStatusEl = document.getElementById('batch-status');
const batchReportEl = document.getElementById('batch-report');
const batchVerdictEl = document.getElementById('batch-verdict');
const batchReleaseVerdictEl = document.getElementById('batch-release-verdict');
const batchSummaryEl = document.getElementById('batch-summary');
const batchTableBody = document.getElementById('batch-table-body');
const batchFileCountEl = document.getElementById('batch-file-count');
const batchCodeTableBody = document.getElementById('batch-code-table-body');
const batchCodeCountEl = document.getElementById('batch-code-count');
const batchDownloadBtn = document.getElementById('batch-download-btn');
const batchPolicyBody = document.getElementById('batch-policy-body');
const batchPolicyResetBtn = document.getElementById('batch-policy-reset-btn');
const batchPolicyResultBody = document.getElementById('batch-policy-result-body');

let batchFiles = [];
let batchReportData = null;
// 仅保存显式覆盖项：{ [code]: 'block' | 'warn' | 'ignore' }
let batchPolicyOverrides = {};

const BATCH_STATUS_LABELS = {
  completed_passed: '检测通过',
  completed_failed: '有错误',
  failed: '无法校验',
};

const BATCH_FAILURE_TEXT = {
  not_pdf: '不是 PDF 文件（文件头不是 %PDF-，或文件为空）',
  invalid_pdf: '文件损坏或无法解析，不是有效的 PDF',
  encrypted_pdf: 'PDF 已加密，无法校验',
  empty_document: 'PDF 不包含任何页面',
};

function setBatchStatus(text, kind) {
  batchStatusEl.textContent = text || '';
  batchStatusEl.className = kind ? `status ${kind}` : 'status';
}

function updateBatchButtons() {
  batchRunBtn.disabled = batchFiles.length === 0;
  batchClearBtn.disabled = batchFiles.length === 0;
}

function clearBatchReport() {
  batchReportData = null;
  batchReportEl.hidden = true;
  batchTableBody.innerHTML = '';
  batchCodeTableBody.innerHTML = '';
  batchPolicyResultBody.innerHTML = '';
  batchSummaryEl.innerHTML = '';
  batchVerdictEl.textContent = '';
  batchReleaseVerdictEl.textContent = '';
}

/**
 * 修改放行策略后，已出的结果按旧策略计算、不再可信：仅隐藏结果区（不立即
 * 清空 DOM），下次「开始批量校验」会以新策略重新渲染；清空选择时才彻底清空。
 */
function markBatchReportStale() {
  batchReportData = null;
  batchReportEl.hidden = true;
}

// ---------- 交付放行策略编辑（保存在本机浏览器） ----------

/**
 * 从 localStorage 读取代码级处置覆盖项；内容损坏或非法时回退为空（全默认）。
 */
function loadBatchPolicyOverrides() {
  try {
    const raw = localStorage.getItem(BATCH_POLICY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const valid = {};
    for (const meta of BATCH_CODE_META) {
      if (['block', 'warn', 'ignore'].includes(parsed[meta.code])) {
        valid[meta.code] = parsed[meta.code];
      }
    }
    return valid;
  } catch (_) {
    return {};
  }
}

function persistBatchPolicyOverrides() {
  try {
    localStorage.setItem(BATCH_POLICY_STORAGE_KEY, JSON.stringify(batchPolicyOverrides));
  } catch (_) { /* 隐私模式等场景下忽略持久化失败 */ }
}

function renderBatchPolicyEditor() {
  batchPolicyBody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const meta of BATCH_CODE_META) {
    const defaultAction = BATCH_DEFAULT_ACTION_BY_SEVERITY[meta.severity];
    const tr = document.createElement('tr');

    const codeTd = document.createElement('td');
    const codeEl = document.createElement('code');
    codeEl.textContent = meta.code;
    codeTd.appendChild(codeEl);

    const titleTd = document.createElement('td');
    titleTd.textContent = meta.title;

    const sevTd = document.createElement('td');
    const sevBadge = document.createElement('span');
    sevBadge.className = `severity-badge ${meta.severity}`;
    sevBadge.textContent = SEVERITY_LABELS[meta.severity];
    sevTd.appendChild(sevBadge);

    const defaultTd = document.createElement('td');
    const defaultBadge = document.createElement('span');
    defaultBadge.className = `release-action ${defaultAction}`;
    defaultBadge.textContent = RELEASE_ACTION_LABELS[defaultAction];
    defaultTd.appendChild(defaultBadge);

    const actionTd = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'batch-policy-select';
    select.dataset.code = meta.code;
    for (const option of [
      { value: '', label: `默认（${RELEASE_ACTION_LABELS[defaultAction]}）` },
      { value: 'block', label: RELEASE_ACTION_LABELS.block },
      { value: 'warn', label: RELEASE_ACTION_LABELS.warn },
      { value: 'ignore', label: RELEASE_ACTION_LABELS.ignore },
    ]) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    }
    select.value = batchPolicyOverrides[meta.code] || '';
    select.addEventListener('change', () => {
      if (select.value) batchPolicyOverrides[meta.code] = select.value;
      else delete batchPolicyOverrides[meta.code];
      persistBatchPolicyOverrides();
      markBatchReportStale();
    });
    actionTd.appendChild(select);

    tr.append(codeTd, titleTd, sevTd, defaultTd, actionTd);
    frag.appendChild(tr);
  }
  batchPolicyBody.appendChild(frag);
}

batchPolicyResetBtn.addEventListener('click', () => {
  batchPolicyOverrides = {};
  persistBatchPolicyOverrides();
  renderBatchPolicyEditor();
  markBatchReportStale();
});

renderBatchPolicyEditor();

function renderBatchFileList() {
  batchFileListEl.innerHTML = '';
  if (batchFiles.length === 0) {
    batchFileListEl.hidden = true;
    batchPickName.textContent = '点击选择 1～10 个 PDF 文件';
    return;
  }
  batchFileListEl.hidden = false;
  batchPickName.textContent = `已选择 ${batchFiles.length} 个 PDF（点击可重新选择）`;
  const frag = document.createDocumentFragment();
  batchFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = 'batch-file-item';
    const idx = document.createElement('span');
    idx.className = 'batch-file-idx';
    idx.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'batch-file-name-item';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'batch-file-size';
    size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    li.append(idx, name, size);
    frag.appendChild(li);
  });
  batchFileListEl.appendChild(frag);
}

batchFilesInput.addEventListener('change', () => {
  const picked = Array.from(batchFilesInput.files || []);
  clearBatchReport();
  if (picked.length === 0) {
    batchFiles = [];
    renderBatchFileList();
    updateBatchButtons();
    return;
  }
  if (picked.length > BATCH_FILE_LIMIT) {
    setBatchStatus(`批量校验一次最多选择 ${BATCH_FILE_LIMIT} 个 PDF，当前选了 ${picked.length} 个。`, 'error');
    batchFiles = [];
    batchFilesInput.value = '';
    renderBatchFileList();
    updateBatchButtons();
    return;
  }
  // 前端给出类型提示；即使选错也照常上传，由服务端在该文件结果中标记 not_pdf
  const nonPdf = picked.filter((f) => f.type && f.type !== 'application/pdf'
    && !/\.pdf$/i.test(f.name));
  if (nonPdf.length) {
    setBatchStatus(`所选文件中 ${nonPdf.length} 个不是 .pdf 文件，校验时会分别记录失败原因。`, 'error');
  } else {
    setBatchStatus('', '');
  }
  batchFiles = picked;
  renderBatchFileList();
  updateBatchButtons();
});

batchClearBtn.addEventListener('click', () => {
  batchFiles = [];
  batchFilesInput.value = '';
  clearBatchReport();
  renderBatchFileList();
  updateBatchButtons();
  setBatchStatus('', '');
});

batchRunBtn.addEventListener('click', async () => {
  if (batchFiles.length === 0) return;
  batchRunBtn.disabled = true;
  batchClearBtn.disabled = true;
  setBatchStatus(`正在按顺序校验 ${batchFiles.length} 个 PDF，不生成拼版文件…`, 'info');
  clearBatchReport();

  const form = new FormData();
  batchFiles.forEach((file) => form.append('pdfs', file));
  // 仅提交显式覆盖项；为空时提交 {} 与缺省等价（服务端按级别取默认处置）
  form.append('releasePolicy', JSON.stringify(batchPolicyOverrides));

  try {
    const resp = await fetch('/api/preflight/batch', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `批量校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    batchReportData = await resp.json();
    renderBatchReport(batchReportData);
    const { summary } = batchReportData;
    const release = summary.release;
    if (summary.failed > 0) {
      setBatchStatus(`批量校验完成：${summary.completed} 个成功、${summary.failed} 个文件无法校验；`
        + `成功文件共发现 ${summary.error} 个错误、${summary.warning} 个警告、${summary.info} 个提示。`
        + `交付放行：${release.blocked} 个阻断、${release.review} 个需复核、`
        + `${release.passed} 个放行、${release.undetermined} 个未判定。`, 'error');
    } else if (summary.error > 0) {
      setBatchStatus(`批量校验完成：${summary.passed} / ${summary.total} 个文件检测无错误级问题；`
        + `共 ${summary.error} 个错误、${summary.warning} 个警告、${summary.info} 个提示。`
        + `交付放行：${release.blocked} 个阻断、${release.review} 个需复核、${release.passed} 个放行。`, 'error');
    } else {
      setBatchStatus(`批量校验完成：全部 ${summary.total} 个文件无错误级问题；`
        + `${summary.warning} 个警告、${summary.info} 个提示。`
        + `交付放行：${release.blocked} 个阻断、${release.review} 个需复核、${release.passed} 个放行。`, 'info');
    }
  } catch (err) {
    clearBatchReport();
    setBatchStatus(err.message || '批量校验失败', 'error');
  } finally {
    batchRunBtn.disabled = false;
    batchClearBtn.disabled = false;
  }
});

function renderBatchSummary(summary) {
  batchSummaryEl.innerHTML = '';
  const release = summary.release || { blocked: 0, review: 0, passed: 0, undetermined: 0 };
  const cards = [
    { level: 'pages', label: '文件总数', count: summary.total },
    { level: 'ok', label: '检测通过', count: summary.passed },
    { level: 'error', label: '无法校验', count: summary.failed },
    { level: 'error', label: '错误', count: summary.error },
    { level: 'warning', label: '警告', count: summary.warning },
    { level: 'info', label: '提示', count: summary.info },
    { level: 'error', label: '放行阻断', count: release.blocked },
    { level: 'warning', label: '需复核', count: release.review },
    { level: 'ok', label: '可放行', count: release.passed },
    { level: 'pages', label: '未判定', count: release.undetermined },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    div.innerHTML = `<span class="stat-num">${card.count}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    batchSummaryEl.appendChild(div);
  }
}

/**
 * 在可展开行下方插入整行明细：失败文件显示失败原因；成功文件复用单文件
 * 报告的问题区段渲染逻辑（徽章 + 标题 + 范围 + 说明 + 修复建议），并按本次
 * 放行策略为每个问题标注处置（阻断 / 需复核 / 忽略）。
 */
function buildBatchDetailRow(item) {
  const detailTr = document.createElement('tr');
  detailTr.className = 'batch-detail-row';
  const td = document.createElement('td');
  td.colSpan = 9;
  const inner = document.createElement('div');
  inner.className = 'batch-detail-inner';

  if (item.status === 'failed') {
    const p = document.createElement('p');
    p.className = 'batch-fail-reason';
    p.textContent = `失败原因：${item.error
      || (BATCH_FAILURE_TEXT[item.errorCode] || '未知错误')}`
      + '；该文件交付放行判定为「未判定」，请人工确认文件后再决定能否交付。';
    inner.appendChild(p);
  } else {
    const release = item.release;
    if (release) {
      const p = document.createElement('p');
      p.className = `batch-release-line ${release.decision}`;
      const parts = [];
      if (release.actionCounts.block) parts.push(`${release.actionCounts.block} 种代码阻断交付`);
      if (release.actionCounts.warn) parts.push(`${release.actionCounts.warn} 种代码需复核`);
      if (release.actionCounts.ignore) parts.push(`${release.actionCounts.ignore} 种代码已忽略`);
      const detailText = parts.length ? `（${parts.join('，')}）` : '';
      p.textContent = `交付放行判定：${RELEASE_DECISION_LABELS[release.decision]}${detailText}`
        + (release.decision === 'passed'
          ? '。所有触发的问题代码均未要求阻断或复核，可以交付。'
          : '。阻断优先于警告：只要存在阻断代码即判为阻断。');
      inner.appendChild(p);
    }
    const report = item.report;
    if (!report || !report.issues.length) {
      const p = document.createElement('p');
      p.className = 'batch-clean';
      p.textContent = '未发现印前问题，可以直接拼版与交付。';
      inner.appendChild(p);
    } else {
      const actionByCode = new Map();
      if (release && Array.isArray(release.triggered)) {
        for (const t of release.triggered) actionByCode.set(t.code, t.action);
      }
      const list = document.createElement('ul');
      list.className = 'issue-list';
      for (const issue of report.issues) {
        list.appendChild(buildBatchIssueElement(issue, actionByCode.get(issue.code)));
      }
      inner.appendChild(list);
    }
  }
  td.appendChild(inner);
  detailTr.appendChild(td);
  return detailTr;
}

function buildBatchIssueElement(issue, action) {
  const li = document.createElement('li');
  li.className = `issue ${issue.severity}`;

  const head = document.createElement('div');
  head.className = 'issue-head';
  const badge = document.createElement('span');
  badge.className = `severity-badge ${issue.severity}`;
  badge.textContent = SEVERITY_LABELS[issue.severity];
  const title = document.createElement('span');
  title.className = 'issue-title';
  title.textContent = issue.title;
  if (action) {
    const actionBadge = document.createElement('span');
    actionBadge.className = `release-action ${action}`;
    actionBadge.textContent = `放行：${RELEASE_ACTION_LABELS[action]}`;
    title.append(' ', actionBadge);
  }
  const range = document.createElement('span');
  range.className = 'issue-range';
  range.textContent = formatRange(issue)
    + (issue.pageCount > 1 ? `（连续 ${issue.pageCount} 页）` : '');
  head.append(badge, title, range);
  li.appendChild(head);

  const message = document.createElement('p');
  message.className = 'issue-message';
  message.textContent = issue.message;
  li.appendChild(message);

  if (issue.values && issue.values.length) {
    const dl = document.createElement('dl');
    dl.className = 'issue-values';
    for (const value of issue.values) {
      const dt = document.createElement('dt');
      dt.textContent = value.label;
      const dd = document.createElement('dd');
      dd.textContent = value.value;
      dl.append(dt, dd);
    }
    li.appendChild(dl);
  }

  const advice = document.createElement('p');
  advice.className = 'issue-advice';
  advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(issue.advice)}`;
  li.appendChild(advice);
  return li;
}

function renderBatchTable(files) {
  batchTableBody.innerHTML = '';
  batchFileCountEl.textContent = String(files.length);
  const frag = document.createDocumentFragment();
  files.forEach((item) => {
    const tr = document.createElement('tr');
    const failed = item.status === 'failed';
    tr.className = failed ? 'batch-row failed' : 'batch-row';

    const state = failed
      ? BATCH_STATUS_LABELS.failed
      : (item.passed ? BATCH_STATUS_LABELS.completed_passed : BATCH_STATUS_LABELS.completed_failed);
    const stateClass = failed ? 'failed' : (item.passed ? 'ok' : 'bad');
    const counts = item.counts || { error: 0, warning: 0, info: 0, issuesTotal: 0 };

    // 交付放行判定：blocked / review / passed / undetermined（无法校验）
    const releaseDecision = item.release ? item.release.decision : 'undetermined';
    const releaseLabel = RELEASE_DECISION_LABELS[releaseDecision] || releaseDecision;
    tr.innerHTML = `<td class="batch-idx">${item.index + 1}</td>`
      + `<td><span class="batch-state ${stateClass}">${state}</span></td>`
      + `<td><span class="batch-release ${releaseDecision}">${releaseLabel}</span></td>`
      + `<td class="batch-name">${escapeHtml(item.file && item.file.name ? item.file.name : '未命名文件')}</td>`
      + `<td>${item.pageCount === null ? '—' : `${item.pageCount} 页`}</td>`
      + `<td>${counts.error}</td><td>${counts.warning}</td><td>${counts.info}</td>`
      + `<td>${counts.issuesTotal}${failed ? ` <span class="batch-row-hint">（点击查看原因）</span>` : ''}</td>`;

    // 点击主行切换该文件的明细行展开状态
    const detailTr = buildBatchDetailRow(item);
    detailTr.hidden = true;
    tr.addEventListener('click', () => {
      const willOpen = detailTr.hidden;
      detailTr.hidden = !willOpen;
      tr.classList.toggle('expanded', willOpen);
    });
    frag.appendChild(tr);
    frag.appendChild(detailTr);
  });
  batchTableBody.appendChild(frag);
}

function renderBatchCodeTotals(issueTotals) {
  batchCodeTableBody.innerHTML = '';
  batchCodeCountEl.textContent = String(issueTotals.length);
  if (!issueTotals.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7" class="batch-code-empty">全部文件均未发现印前问题。</td>';
    batchCodeTableBody.appendChild(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of issueTotals) {
    const tr = document.createElement('tr');
    const fileText = item.files
      .map((f) => `${f.index + 1}. ${f.name || '未命名文件'}`)
      .join('；');
    const action = item.action || 'warn';
    const actionSourceText = item.actionSource === 'custom' ? '（自定义）' : '（默认）';
    tr.innerHTML = `<td><code>${escapeHtml(item.code)}</code></td>`
      + `<td><span class="severity-badge ${item.severity}">${SEVERITY_LABELS[item.severity]}</span></td>`
      + `<td><span class="release-action ${action}">${RELEASE_ACTION_LABELS[action]}</span>`
      + `<span class="batch-action-source">${actionSourceText}</span></td>`
      + `<td>${escapeHtml(item.title)}</td>`
      + `<td>${item.count}</td>`
      + `<td>${item.fileCount}</td>`
      + `<td class="batch-code-files">${escapeHtml(fileText)}</td>`;
    frag.appendChild(tr);
  }
  batchCodeTableBody.appendChild(frag);
}

/**
 * 渲染当次实际生效的放行策略（服务端快照，默认/自定义均可追溯）。
 */
function renderBatchPolicySnapshot(releasePolicy) {
  batchPolicyResultBody.innerHTML = '';
  if (!releasePolicy || !Array.isArray(releasePolicy.rules)) return;
  const frag = document.createDocumentFragment();
  for (const rule of releasePolicy.rules) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><code>${escapeHtml(rule.code)}</code></td>`
      + `<td><span class="severity-badge ${rule.severity}">${SEVERITY_LABELS[rule.severity]}</span></td>`
      + `<td>${escapeHtml(rule.title)}</td>`
      + `<td><span class="release-action ${rule.action}">${RELEASE_ACTION_LABELS[rule.action]}</span></td>`
      + `<td>${rule.source === 'custom' ? '自定义覆盖' : '按级别默认'}</td>`;
    frag.appendChild(tr);
  }
  batchPolicyResultBody.appendChild(frag);
}

/**
 * 交付放行结论文案：阻断优先；无阻断但有无法校验文件时整批不能直接放行；
 * 其次需复核；全部通过且可放行才提示可以交付。
 */
function renderBatchReleaseVerdict(summary) {
  const release = summary.release || { blocked: 0, review: 0, passed: 0, undetermined: 0 };
  const decision = release.decision || 'passed';
  batchReleaseVerdictEl.className = `report-verdict release-verdict ${decision}`;
  if (decision === 'blocked') {
    batchReleaseVerdictEl.textContent = `交付放行：不予放行 —— ${release.blocked} 个文件命中阻断代码`
      + `（另有 ${release.review} 个需复核、${release.undetermined} 个未判定、`
      + `${release.passed} 个可放行）。请先处理阻断项后重新校验。`;
  } else if (decision === 'undetermined') {
    batchReleaseVerdictEl.textContent = `交付放行：暂不能放行 —— ${release.undetermined} 个文件无法校验（未判定）`
      + `；其余 ${release.passed} 个可放行、${release.review} 个需复核。`
      + '请补传可正常解析的 PDF 或人工确认后再交付。';
  } else if (decision === 'review') {
    batchReleaseVerdictEl.textContent = `交付放行：需复核 —— ${release.review} 个文件命中需复核代码，`
      + `其余 ${release.passed} 个可放行；人工确认警告项可接受后即可交付，没有阻断项。`;
  } else {
    batchReleaseVerdictEl.textContent = `交付放行：可以交付 —— 全部 ${release.passed} 个文件均已完成校验，`
      + '没有阻断或需复核的问题代码（提示级问题已按策略忽略或未出现）。';
  }
}

function renderBatchReport(data) {
  batchReportEl.hidden = false;
  const { summary } = data;
  batchVerdictEl.className = `report-verdict ${summary.allPassed ? 'ok' : 'bad'}`;
  if (summary.failed > 0) {
    batchVerdictEl.textContent = `检测结论：共 ${summary.total} 个文件，${summary.completed} 个完成校验`
      + `（其中 ${summary.passed} 个无错误级问题），${summary.failed} 个文件无法校验（缺失/非 PDF/损坏/加密），`
      + '请展开对应行查看失败原因。';
  } else if (summary.allPassed) {
    batchVerdictEl.textContent = `检测结论：全部 ${summary.total} 个文件均无错误级问题，警告/提示可选择性处理。`;
  } else {
    batchVerdictEl.textContent = `检测结论：${summary.total} 个文件全部完成校验，其中 ${summary.passed} 个无错误级问题；`
      + `共 ${summary.error} 个错误级问题，建议修复后再印刷。`;
  }
  renderBatchReleaseVerdict(summary);
  renderBatchSummary(summary);
  renderBatchTable(data.files);
  renderBatchCodeTotals(data.issueTotals);
  renderBatchPolicySnapshot(data.releasePolicy);
}

batchDownloadBtn.addEventListener('click', () => {
  if (!batchReportData) return;
  const json = JSON.stringify(batchReportData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '批量印前校验报告.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
