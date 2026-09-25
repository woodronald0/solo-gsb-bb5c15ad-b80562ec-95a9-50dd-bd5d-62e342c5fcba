'use strict';

/**
 * 印刷用纸报价（paper quote）。
 *
 * 纯计算模块，不触碰 PDF 字节：输入拼版方案（lib/impose.js 产出的 plan，
 * 含统一面板尺寸 panel、纸张数与分册签帖信息）与用户维护的纸张规格
 * （宽/高 mm、单价 元/张、开机费 元/次），输出每种纸张的容纳判定与成本。
 *
 * 规则：
 *   - 印张尺寸取拼版方案记录的实际输出宽高（plan.sheet，启用印张定位
 *     标记时含四周 8mm 空白）；旧方案无该字段时回退为 2 × 面板宽 × 面板高；
 *   - 对每种纸张枚举「原向」与「旋转 90°」两个方向，任一方向能容纳
 *     版面即为可行，并在可行方向中选取空余最小（slack 之和最小）的方向；
 *   - 纸张费 = 单价 × 纸张数；开机费 = 开机费 × 开机次数（整册 1 次，
 *     分册签帖模式下每帖各 1 次）；总价 = 纸张费 + 开机费；
 *   - 有效利用率 = 印张版面总面积 ÷ 纸张总面积（补白仍占版面，不影响利用率）；
 *   - 在可行纸张中选择总价最低者；总价相同时优先利用率更高、纸张更小、
 *     维护顺序更靠前的规格。
 *   - 没有任何纸张可容纳时 feasible=false，逐种纸张给出两个方向的不足量。
 */

/** 1 mm 对应的 pt 数（1 inch = 25.4 mm = 72 pt） */
const PT_PER_MM = 72 / 25.4;
/** 用户最多维护的纸张规格数量 */
const MAX_PAPER_SPECS = 8;
/** 容纳判定容差（pt，约 0.004mm），吸收 pt↔mm 换算误差 */
const FIT_EPSILON_PT = 0.01;
/** 同上，mm 单位（用于不足量提示的去抖） */
const FIT_EPSILON_MM = FIT_EPSILON_PT / PT_PER_MM;

function mmToPt(mm) {
  return mm * PT_PER_MM;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * 把入参转成有限数字：接受 number 与纯数字字符串，其余返回 null。
 * @param {*} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * 校验并规范化单条纸张规格。
 *
 * @param {*} raw 原始入参：{ name?, widthMm, heightMm, pricePerSheet, setupFee }
 *                （兼容 width/height/price 等前端字段名）
 * @param {number} index 规格序号（0 基，用于错误提示）
 * @returns {{ index:number, name:string, widthMm:number, heightMm:number,
 *             pricePerSheet:number, setupFee:number }}
 */
function normalizePaperSpec(raw, index) {
  const where = `第 ${index + 1} 条纸张规格`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}必须是对象`);
  }
  let name = raw.name;
  if (name === undefined || name === null) name = '';
  if (typeof name !== 'string') {
    throw new Error(`${where}的名称必须是文本`);
  }
  name = name.trim();
  if (name.length > 40) {
    throw new Error(`${where}的名称不能超过 40 个字符`);
  }
  if (!name) name = `纸张 ${index + 1}`;

  const widthMm = toFiniteNumber(raw.widthMm !== undefined ? raw.widthMm : raw.width);
  if (widthMm === null || widthMm <= 0) {
    throw new Error(`纸张「${name}」的宽必须是大于 0 的数字（单位 mm）`);
  }
  const heightMm = toFiniteNumber(raw.heightMm !== undefined ? raw.heightMm : raw.height);
  if (heightMm === null || heightMm <= 0) {
    throw new Error(`纸张「${name}」的高必须是大于 0 的数字（单位 mm）`);
  }
  const pricePerSheet = toFiniteNumber(
    raw.pricePerSheet !== undefined ? raw.pricePerSheet : raw.price,
  );
  if (pricePerSheet === null || pricePerSheet < 0) {
    throw new Error(`纸张「${name}」的单价必须是不小于 0 的数字（元/张）`);
  }
  const setupFee = toFiniteNumber(raw.setupFee !== undefined ? raw.setupFee : raw.setup);
  if (setupFee === null || setupFee < 0) {
    throw new Error(`纸张「${name}」的开机费必须是不小于 0 的数字（元/次）`);
  }

  return { index, name, widthMm, heightMm, pricePerSheet, setupFee };
}

/**
 * 校验纸张规格列表：至少 1 种、至多 MAX_PAPER_SPECS 种。
 * @param {*} rawList
 * @returns {Array<ReturnType<normalizePaperSpec>>}
 */
function normalizePaperSpecs(rawList) {
  if (!Array.isArray(rawList)) {
    throw new Error('papers 必须是纸张规格数组');
  }
  if (rawList.length === 0) {
    throw new Error('请至少维护一种纸张规格');
  }
  if (rawList.length > MAX_PAPER_SPECS) {
    throw new Error(`最多维护 ${MAX_PAPER_SPECS} 种纸张规格`);
  }
  return rawList.map((spec, i) => normalizePaperSpec(spec, i));
}

/**
 * 从拼版方案中提取报价所需的版面信息：统一面板、纸张数、开机次数。
 *
 * @param {*} plan /api/impose 的 X-Imposition-Plan 方案（整册或签帖模式均可）
 * @returns {{
 *   panelWidthPt:number, panelHeightPt:number,
 *   sheetWidthPt:number, sheetHeightPt:number, orientation:string|null,
 *   sheetCount:number, runCount:number,
 *   signatureMode:boolean, signatureCount:number|null
 * }}
 */
function readLayout(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('缺少拼版方案 plan 对象');
  }
  const panel = plan.panel;
  if (!panel || typeof panel !== 'object') {
    throw new Error('拼版方案缺少统一面板尺寸 panel');
  }
  const panelWidthPt = toFiniteNumber(panel.width);
  const panelHeightPt = toFiniteNumber(panel.height);
  if (panelWidthPt === null || panelWidthPt <= 0
    || panelHeightPt === null || panelHeightPt <= 0) {
    throw new Error('拼版方案的统一面板尺寸无效');
  }

  // 实际输出印张尺寸：优先采用方案记录的 sheet（启用定位标记后含四周空白），
  // 旧方案无该字段或数值非法时回退为 2 × 面板宽 × 面板高，结果与之前一致
  let sheetWidthPt = panelWidthPt * 2;
  let sheetHeightPt = panelHeightPt;
  if (plan.sheet && typeof plan.sheet === 'object' && !Array.isArray(plan.sheet)) {
    const w = toFiniteNumber(plan.sheet.width);
    const h = toFiniteNumber(plan.sheet.height);
    if (w !== null && w > 0 && h !== null && h > 0) {
      sheetWidthPt = w;
      sheetHeightPt = h;
    }
  }

  let sheetCount;
  let runCount;
  let signatureMode = false;
  let signatureCount = null;

  if (plan.signatureMode === true) {
    signatureMode = true;
    if (!Array.isArray(plan.signatures) || plan.signatures.length === 0) {
      throw new Error('分册签帖方案缺少 signatures 签帖列表');
    }
    runCount = plan.signatures.length;
    sheetCount = 0;
    plan.signatures.forEach((sig, i) => {
      if (!sig || !Array.isArray(sig.sheets)) {
        throw new Error(`第 ${i + 1} 帖缺少 sheets 纸张列表`);
      }
      sheetCount += sig.sheets.length;
    });
    if (sheetCount <= 0) {
      throw new Error('拼版方案不包含任何纸张');
    }
    signatureCount = runCount;
  } else {
    if (!Array.isArray(plan.sheets) || plan.sheets.length === 0) {
      throw new Error('拼版方案缺少 sheets 纸张列表');
    }
    sheetCount = plan.sheets.length;
    runCount = 1;
  }

  return {
    panelWidthPt,
    panelHeightPt,
    sheetWidthPt,
    sheetHeightPt,
    orientation: typeof panel.orientation === 'string' ? panel.orientation : null,
    sheetCount,
    runCount,
    signatureMode,
    signatureCount,
  };
}

/**
 * 计算某一摆放方向下纸张相对版面的空余尺寸（pt，负值表示不足）。
 *
 * @param {boolean} rotated 纸张是否旋转 90°
 */
function orientationFit(paperWPt, paperHPt, sheetWPt, sheetHPt, rotated) {
  // 旋转 90° 后纸张可用宽高互换
  const availW = rotated ? paperHPt : paperWPt;
  const availH = rotated ? paperWPt : paperHPt;
  const slackW = availW - sheetWPt;
  const slackH = availH - sheetHPt;
  return {
    rotated,
    fits: slackW + FIT_EPSILON_PT >= 0 && slackH + FIT_EPSILON_PT >= 0,
    slackWPt: slackW,
    slackHPt: slackH,
  };
}

function ptToMmText(valuePt) {
  return round2(valuePt / PT_PER_MM);
}

/**
 * 评估一种纸张：枚举两个旋转方向，返回可行方向（含成本）或两个方向的不足量。
 *
 * @returns {object} 报价选项（feasible / infeasible 结构不同）
 */
function evaluatePaper(spec, layout) {
  const paperWPt = mmToPt(spec.widthMm);
  const paperHPt = mmToPt(spec.heightMm);
  const sheetWPt = layout.sheetWidthPt;
  const sheetHPt = layout.sheetHeightPt;

  const asIs = orientationFit(paperWPt, paperHPt, sheetWPt, sheetHPt, false);
  const rotated = orientationFit(paperWPt, paperHPt, sheetWPt, sheetHPt, true);
  const feasible = [asIs, rotated].filter((o) => o.fits);

  const paperInfo = {
    name: spec.name,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    widthPt: round4(paperWPt),
    heightPt: round4(paperHPt),
    pricePerSheet: spec.pricePerSheet,
    setupFee: spec.setupFee,
  };

  if (feasible.length === 0) {
    return {
      index: spec.index,
      name: spec.name,
      paper: paperInfo,
      fits: false,
      reasons: [asIs, rotated].map((o) => buildInfeasibleReason(o)),
      reason: buildInfeasibleSummary(spec, asIs, rotated, sheetWPt, sheetHPt),
    };
  }

  // 可行方向中选空余最小者；空余相同时优先原向
  feasible.sort((a, b) => {
    const sa = a.slackWPt + a.slackHPt;
    const sb = b.slackWPt + b.slackHPt;
    if (sa !== sb) return sa - sb;
    return (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0);
  });
  const chosen = feasible[0];

  const sheetAreaPt = sheetWPt * sheetHPt;
  const paperAreaPt = paperWPt * paperHPt;
  const utilization = sheetAreaPt / paperAreaPt;
  const paperCost = round2(spec.pricePerSheet * layout.sheetCount);
  const setupCost = round2(spec.setupFee * layout.runCount);
  const totalCost = round2(paperCost + setupCost);

  return {
    index: spec.index,
    name: spec.name,
    paper: paperInfo,
    fits: true,
    placement: {
      rotated: chosen.rotated,
      orientation: chosen.rotated ? 'rotated_90' : 'as_is',
      // 实际摆放时占用的纸张宽/高（mm）：旋转时互换
      paperWidthUsedMm: chosen.rotated ? spec.heightMm : spec.widthMm,
      paperHeightUsedMm: chosen.rotated ? spec.widthMm : spec.heightMm,
      slackWidthMm: ptToMmText(chosen.slackWPt),
      slackHeightMm: ptToMmText(chosen.slackHPt),
    },
    utilization: round4(utilization),
    utilizationPercent: round2(utilization * 100),
    sheetCount: layout.sheetCount,
    runCount: layout.runCount,
    paperCost,
    setupCost,
    totalCost,
  };
}

/**
 * 不可行方向的结构化原因：只列出真正不足（正值）的维度。
 */
function buildInfeasibleReason(orientation) {
  const shortageWidthMm = Math.max(0, -orientation.slackWPt / PT_PER_MM);
  const shortageHeightMm = Math.max(0, -orientation.slackHPt / PT_PER_MM);
  const parts = [];
  if (shortageWidthMm > FIT_EPSILON_MM) parts.push(`宽度不足 ${round2(shortageWidthMm)} mm`);
  if (shortageHeightMm > FIT_EPSILON_MM) parts.push(`高度不足 ${round2(shortageHeightMm)} mm`);
  return {
    orientation: orientation.rotated ? 'rotated_90' : 'as_is',
    fits: false,
    shortageWidthMm: round2(shortageWidthMm),
    shortageHeightMm: round2(shortageHeightMm),
    message: parts.length
      ? `${orientation.rotated ? '纸张旋转 90° 后' : '纸张原向'}${parts.join('、')}`
      : `${orientation.rotated ? '纸张旋转 90° 后' : '纸张原向'}可容纳`,
  };
}

function buildInfeasibleSummary(spec, asIs, rotated, sheetWPt, sheetHPt) {
  const layoutText = `版面展开 ${ptToMmText(sheetWPt)} × ${ptToMmText(sheetHPt)} mm`;
  const sideText = (o) => {
    const r = buildInfeasibleReason(o);
    const prefix = o.rotated ? '旋转 90°' : '原向';
    const dims = [];
    if (r.shortageWidthMm > 0) dims.push(`宽差 ${r.shortageWidthMm} mm`);
    if (r.shortageHeightMm > 0) dims.push(`高差 ${r.shortageHeightMm} mm`);
    return dims.length ? `${prefix}${dims.join('、')}` : `${prefix}可容纳`;
  };
  return `纸张「${spec.name}」（${spec.widthMm} × ${spec.heightMm} mm）无法容纳`
    + `${layoutText}：${sideText(asIs)}；${sideText(rotated)}`;
}

/**
 * 计算用纸报价。
 *
 * @param {object} plan 拼版方案（X-Imposition-Plan 解码后的对象）
 * @param {Array} rawPaperSpecs 用户维护的纸张规格（1～8 种）
 * @returns {object} 报价结果（feasible 为 false 时 selected 为 null，
 *                   并在 reason 中给出所有纸张不能容纳的明确原因）
 */
function buildPaperQuote(plan, rawPaperSpecs) {
  const layout = readLayout(plan);
  const specs = normalizePaperSpecs(rawPaperSpecs);

  const options = specs.map((spec) => evaluatePaper(spec, layout));
  const feasibleOptions = options
    .filter((o) => o.fits)
    .sort((a, b) => {
      if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
      if (b.utilization !== a.utilization) return b.utilization - a.utilization;
      const areaA = a.paper.widthMm * a.paper.heightMm;
      const areaB = b.paper.widthMm * b.paper.heightMm;
      if (areaA !== areaB) return areaA - areaB;
      return a.index - b.index;
    });

  const sheetWPt = layout.sheetWidthPt;
  const sheetHPt = layout.sheetHeightPt;
  const layoutInfo = {
    signatureMode: layout.signatureMode,
    signatureCount: layout.signatureCount,
    sheetCount: layout.sheetCount,
    runCount: layout.runCount,
    panel: {
      widthPt: round4(layout.panelWidthPt),
      heightPt: round4(layout.panelHeightPt),
      widthMm: ptToMmText(layout.panelWidthPt),
      heightMm: ptToMmText(layout.panelHeightPt),
      orientation: layout.orientation,
    },
    sheet: {
      widthPt: round4(sheetWPt),
      heightPt: round4(sheetHPt),
      widthMm: ptToMmText(sheetWPt),
      heightMm: ptToMmText(sheetHPt),
    },
  };

  const result = {
    schemaVersion: 1,
    kind: 'paper-quote',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    feasible: feasibleOptions.length > 0,
    layout: layoutInfo,
    options,
    selected: feasibleOptions.length > 0 ? feasibleOptions[0] : null,
  };

  if (!result.feasible) {
    result.reasonCode = 'no_fitting_paper';
    result.reason = `展开后的单张印张尺寸为 ${layoutInfo.sheet.widthMm} × `
      + `${layoutInfo.sheet.heightMm} mm，维护的 ${options.length} 种纸张均无法容纳`
      + '（已枚举原向与旋转 90°）：'
      + options
        .filter((o) => !o.fits)
        .map((o) => {
          const asIs = o.reasons.find((r) => r.orientation === 'as_is');
          const rotated = o.reasons.find((r) => r.orientation === 'rotated_90');
          const shortText = (r) => {
            const dims = [];
            if (r.shortageWidthMm > 0) dims.push(`宽度不足 ${r.shortageWidthMm} mm`);
            if (r.shortageHeightMm > 0) dims.push(`高度不足 ${r.shortageHeightMm} mm`);
            return dims.length ? dims.join('、') : '可容纳';
          };
          return `「${o.name}」（${o.paper.widthMm} × ${o.paper.heightMm} mm）原向${shortText(asIs)}`
            + `，旋转 90° 后${shortText(rotated)}`;
        })
        .join('；');
  }

  return result;
}

module.exports = {
  PT_PER_MM,
  MAX_PAPER_SPECS,
  mmToPt,
  normalizePaperSpec,
  normalizePaperSpecs,
  readLayout,
  orientationFit,
  buildPaperQuote,
};
