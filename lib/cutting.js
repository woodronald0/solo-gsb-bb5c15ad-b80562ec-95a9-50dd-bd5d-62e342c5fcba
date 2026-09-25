'use strict';

/**
 * 批量裁切下料（sheet cutting / guillotine packing）。
 *
 * 纯计算模块，不触碰 PDF 字节：输入拼版方案（lib/impose.js 产出的 plan，
 * 沿用 plan.sheet 记录的实际输出印张尺寸，与 lib/quote.js 同一口径）、
 * 用户维护的纸张规格（宽/高 mm）与所需印张数，输出每种原纸的：
 *   - 单张原纸可裁出的印张数（yieldsPerSheet）
 *   - 所需原纸张数（ceil(所需印张数 / 单张产出)）
 *   - 尾张余量（最后一张只需裁出的印张数与尚可再裁的余量）
 *   - 可执行的「直线贯通裁切树」（guillotine cut tree）与废料面积
 *
 * 算法：
 *   - 印张允许旋转 90°；枚举纸张原向与旋转 90° 两个摆放方向；
 *   - solveGuillotine 为递归矩形分割搜索：每一步要么放 1 个印张（叶节点），
 *     要么沿竖直/水平方向做一条贯通直线把当前矩形切成两个子矩形，递归求解；
 *   - 切位只枚举「印张边长整数倍」位置：最优 guillotine 方案的每条贯通线
 *     都可平移到某一印张边缘而不损失产出，故无需在任意位置切分，更不允许
 *     仅凭面积估算或跨线（非贯通）重叠摆放；
 *   - 以 (剩余宽, 剩余高) 记忆化；目标先最大化印张数，再最小化废料面积
 *     （对固定矩形与固定印张，两者等价，废料项用于确定性决胜）。
 */

const {
  PT_PER_MM,
  normalizePaperSpecs,
  readLayout,
} = require('./quote');

/** 所需印张数上限（正整数），防止误输入天文数字 */
const MAX_REQUIRED_SHEETS = 1_000_000;
/** 单张原纸可裁印张数的规模上限：超出视为规格不合理，不再展开搜索 */
const MAX_ITEMS_PER_SHEET = 10_000;
/** 单次搜索记忆化状态数上限（防御异常规格组合导致的状态膨胀） */
const MAX_SEARCH_STATES = 200_000;
/** 几何判定容差（mm，约 0.014pt），吸收 pt↔mm 换算误差 */
const FIT_EPSILON_MM = 0.005;
/** 记忆化键量化精度（mm）：换算误差量级（1e-5）远小于此，不影响命中 */
const KEY_QUANTUM = 1e-4;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function ptToMm(valuePt) {
  return valuePt / PT_PER_MM;
}

/**
 * 校验「所需印张数」：仅接受 1～MAX_REQUIRED_SHEETS 的整数（数字或纯数字字符串）。
 * @param {*} value
 * @returns {number}
 */
function parseRequiredSheets(value) {
  const message = `所需印张数必须是 1～${MAX_REQUIRED_SHEETS} 之间的整数`;
  if (typeof value === 'string') {
    if (!/^\s*\d+\s*$/.test(value)) throw new Error(message);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < 1 || value > MAX_REQUIRED_SHEETS) {
    throw new Error(message);
  }
  return value;
}

function quantize(value) {
  return Math.round((value + Number.EPSILON) / KEY_QUANTUM) * KEY_QUANTUM;
}

/**
 * 递归矩形分割搜索：在 W × H 矩形内裁出尽可能多的 a × b 印张（允许旋转）。
 *
 * 返回 { count, tree }，tree 节点（尺寸均为相对当前矩形左上角的局部值）：
 *   - 叶节点：{ kind:'leaf', used, width, height, rotated?, itemW?, itemH? }
 *       used=false 时整块为废料；used=true 时 width/height 为所在矩形尺寸、
 *       itemW/itemH 为放入的印张尺寸（放在左下角，余料在右/上），rotated 表示
 *       印张是否旋转 90°。所有叶矩形无缝铺满根矩形。
 *   - 贯通裁切：{ kind:'cut', direction:'v'|'h', offset, width, height,
 *                 first, second }
 *       v：竖直贯通线 x=offset，first = 左条（宽 offset）、second = 右条
 *       h：水平贯通线 y=offset，first = 下条（高 offset）、second = 上条
 *
 * @param {number} W 当前矩形宽（mm）
 * @param {number} H 当前矩形高（mm）
 * @param {number} a 印张宽（mm，未旋转）
 * @param {number} b 印张高（mm，未旋转）
 * @param {Map<string,object>} memo 记忆化表
 * @param {{states:number}} stats 搜索状态计数
 * @returns {{count:number, tree:object}}
 */
function solveGuillotine(W, H, a, b, memo, stats) {
  // 连任一方向的一个印张都放不下：整块为废料
  const fitAsIs = W + FIT_EPSILON_MM >= a && H + FIT_EPSILON_MM >= b;
  const fitRotated = W + FIT_EPSILON_MM >= b && H + FIT_EPSILON_MM >= a;
  if (!fitAsIs && !fitRotated) {
    return { count: 0, tree: { kind: 'leaf', used: false, width: W, height: H } };
  }

  const memoKey = `${quantize(W)}x${quantize(H)}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;
  if (stats.states >= MAX_SEARCH_STATES) {
    throw new Error('裁切搜索状态过多，请缩小纸张规格或检查印张尺寸');
  }
  stats.states += 1;

  // 候选 1：当前矩形直接放 1 个印张（放在矩形左下角，其余区域为废料）。
  // 叶节点同时记录「所在矩形」（width/height）与「印张」（itemW/itemH），
  // 使整棵树的叶矩形无缝铺满根矩形，废料即 used=false 及用后余料区域。
  const candidates = [];
  if (fitAsIs) {
    candidates.push({
      count: 1,
      tree: {
        kind: 'leaf', used: true, rotated: false,
        width: W, height: H, itemW: a, itemH: b,
      },
    });
  }
  if (fitRotated) {
    candidates.push({
      count: 1,
      tree: {
        kind: 'leaf', used: true, rotated: true,
        width: W, height: H, itemW: b, itemH: a,
      },
    });
  }

  // 候选 2：竖直 / 水平贯通切分。切位只需枚举印张边长（a、b）的整数倍：
  // 任一最优 guillotine 方案的顶层贯通线都能平移到某一印张边缘而不改变
  // 两侧产出；切在 k·d 与 total-k·d 只是左右（上下）子矩形互换，故只枚举
  // 不超过中线的切位。切线必须严格位于矩形内部（留两侧非空条带）。
  const considerSplit = (direction, offset, firstW, firstH, secondW, secondH) => {
    if (offset <= FIT_EPSILON_MM) return;
    const total = direction === 'v' ? W : H;
    if (offset >= total - FIT_EPSILON_MM) return;
    if (offset > total / 2 + FIT_EPSILON_MM) return;
    const first = solveGuillotine(firstW, firstH, a, b, memo, stats);
    const second = solveGuillotine(secondW, secondH, a, b, memo, stats);
    candidates.push({
      count: first.count + second.count,
      tree: {
        kind: 'cut', direction, offset, width: W, height: H,
        first: first.tree, second: second.tree,
      },
    });
  };

  for (const d of [a, b]) {
    for (let k = 1; ; k += 1) {
      const offset = k * d;
      if (offset > W / 2 + FIT_EPSILON_MM) break;
      considerSplit('v', offset, offset, H, W - offset, H);
    }
    for (let k = 1; ; k += 1) {
      const offset = k * d;
      if (offset > H / 2 + FIT_EPSILON_MM) break;
      considerSplit('h', offset, W, offset, W, H - offset);
    }
  }

  // 决胜：印张数最多优先；同尺寸矩形 + 同印张数时废料面积必然相等，
  // 再以树更浅（裁切刀数更少、工艺更简单）、首个叶节点非旋转决胜
  let best = candidates[0];
  for (const cand of candidates.slice(1)) {
    if (cand.count !== best.count) {
      if (cand.count > best.count) best = cand;
      continue;
    }
    const depthCand = treeDepth(cand.tree);
    const depthBest = treeDepth(best.tree);
    if (depthCand !== depthBest) {
      if (depthCand < depthBest) best = cand;
      continue;
    }
    if (firstLeafRotated(cand.tree) === false && firstLeafRotated(best.tree) === true) {
      best = cand;
    }
  }

  memo.set(memoKey, best);
  return best;
}

function treeDepth(node) {
  if (node.kind !== 'cut') return 1;
  return 1 + Math.max(treeDepth(node.first), treeDepth(node.second));
}

function firstLeafRotated(node) {
  if (node.kind === 'leaf') return node.used ? Boolean(node.rotated) : null;
  return firstLeafRotated(node.first);
}

/**
 * 把相对裁切树映射为原纸坐标系（左上角原点，x 向右、y 向下）上的绝对布局：
 * 印张位置列表与贯通裁切线列表，供前端直接绘制裁切图与 JSON 导出。
 *
 * @param {object} node solveGuillotine 返回的树节点
 * @param {number} x 当前矩形左上角 x（mm）
 * @param {number} y 当前矩形左上角 y（mm）
 * @param {object} out { items:[], cuts:[] }
 * @returns {object} 带绝对坐标的树节点（结构同输入，额外带 x/y）
 */
function positionTree(node, x, y, out) {
  if (node.kind === 'leaf') {
    // 叶矩形 = 所在区域（width/height）；用后余料（右侧条 + 上方条）为废料
    const positioned = {
      kind: 'leaf', used: node.used, x, y,
      widthMm: round2(node.width), heightMm: round2(node.height),
    };
    if (node.used) {
      positioned.rotated = Boolean(node.rotated);
      positioned.itemWidthMm = round2(node.itemW);
      positioned.itemHeightMm = round2(node.itemH);
      out.items.push({
        xMm: round2(x),
        yMm: round2(y),
        widthMm: round2(node.itemW),
        heightMm: round2(node.itemH),
        rotated: Boolean(node.rotated),
      });
    }
    return positioned;
  }

  let first;
  let second;
  let cut;
  // 现场按先序执行：先切当前矩形（料件）的贯通线，再分别切两条子料件；
  // 故先记录当前裁切线，再递归子树，cuts 即可直接照做的裁切顺序。
  // piece* 为该刀所在料件的绝对边界（首刀为整张原纸，其后为子条）。
  if (node.direction === 'v') {
    // 竖直贯通线：从料件顶边到底边
    cut = {
      direction: 'v',
      x1Mm: round2(x + node.offset), y1Mm: round2(y),
      x2Mm: round2(x + node.offset), y2Mm: round2(y + node.height),
      pieceXMm: round2(x), pieceYMm: round2(y),
      pieceWidthMm: round2(node.width), pieceHeightMm: round2(node.height),
    };
    out.cuts.push(cut);
    first = positionTree(node.first, x, y, out);
    second = positionTree(node.second, x + node.offset, y, out);
  } else {
    // 水平贯通线：从料件左边到右边
    cut = {
      direction: 'h',
      x1Mm: round2(x), y1Mm: round2(y + node.offset),
      x2Mm: round2(x + node.width), y2Mm: round2(y + node.offset),
      pieceXMm: round2(x), pieceYMm: round2(y),
      pieceWidthMm: round2(node.width), pieceHeightMm: round2(node.height),
    };
    out.cuts.push(cut);
    first = positionTree(node.first, x, y, out);
    second = positionTree(node.second, x, y + node.offset, out);
  }

  return {
    kind: 'cut',
    direction: node.direction,
    offsetMm: round2(node.offset),
    xMm: round2(x),
    yMm: round2(y),
    widthMm: round2(node.width),
    heightMm: round2(node.height),
    first,
    second,
  };
}

/**
 * 汇总相对裁切树中所有废料叶节点（used=false）的面积。树的叶节点恰好铺满
 * 根矩形（每条贯通线把矩形无损分成两条），故总废料 = 根面积 − 印张面积，
 * 且以实际几何尾数计算，恰好铺满时严格为 0。
 * @param {object} node solveGuillotine 产出的相对树节点（宽高未取整）
 * @returns {number}
 */
function collectWasteArea(node) {
  if (node.kind === 'leaf') {
    if (!node.used) return Math.max(0, node.width) * Math.max(0, node.height);
    // 用后余料：叶矩形面积 − 已放印张面积（右侧条 + 上方条，互不重叠）
    return Math.max(0, node.width * node.height - node.itemW * node.itemH);
  }
  return collectWasteArea(node.first) + collectWasteArea(node.second);
}

/**
 * 统计相对裁切树中印张叶节点数量，可只统计旋转 90° 的叶节点。
 */
function countItems(node, rotatedOnly) {
  if (node.kind === 'leaf') {
    if (!node.used) return 0;
    return !rotatedOnly || node.rotated ? 1 : 0;
  }
  return countItems(node.first, rotatedOnly) + countItems(node.second, rotatedOnly);
}

/**
 * 评估纸张的一个摆放方向：在 frameW × frameH 内执行 guillotine 搜索。
 *
 * @returns {{feasible:boolean, rotated:boolean, frameW:number, frameH:number,
 *            count:number, tree:object|null, items:Array, cuts:Array,
 *            reasonCode?:string}}
 */
function solveOrientation(frameW, frameH, itemW, itemH, rotated) {
  // 印张至少有一个方向（原向或旋转 90°）能完全落入当前矩形才进入搜索
  const fitsAsIs = frameW + FIT_EPSILON_MM >= itemW && frameH + FIT_EPSILON_MM >= itemH;
  const fitsRotated = frameW + FIT_EPSILON_MM >= itemH && frameH + FIT_EPSILON_MM >= itemW;
  if (!fitsAsIs && !fitsRotated) {
    return { feasible: false, rotated, frameW, frameH, count: 0, tree: null, items: [], cuts: [] };
  }

  // 面积上界超过规模上限：该规格组合不合理（例如把极小印张排进巨型原纸）
  const areaBound = Math.floor((frameW * frameH) / (itemW * itemH));
  if (areaBound > MAX_ITEMS_PER_SHEET) {
    return {
      feasible: false, rotated, frameW, frameH, count: 0, tree: null,
      items: [], cuts: [], reasonCode: 'too_many_items',
      reason: `单张原纸可裁数量的面积估算已超过 ${MAX_ITEMS_PER_SHEET}，请检查纸张与印张尺寸`,
    };
  }

  try {
    const memo = new Map();
    const stats = { states: 0 };
    const { count, tree } = solveGuillotine(frameW, frameH, itemW, itemH, memo, stats);
    if (count === 0) {
      return { feasible: false, rotated, frameW, frameH, count: 0, tree: null, items: [], cuts: [] };
    }
    const out = { items: [], cuts: [] };
    const positionedTree = positionTree(tree, 0, 0, out);
    // 单张废料面积按裁切树中的废料叶节点（未使用矩形）求和：以实际几何
    // （含 pt↔mm 换算的微小尾数）为准，恰好铺满时废料严格为 0，不会出现负值
    const wasteArea = collectWasteArea(tree);
    const rotatedItemCount = countItems(tree, true);
    return {
      feasible: true, rotated, frameW, frameH, count, wasteArea, rotatedItemCount,
      tree: positionedTree, items: out.items, cuts: out.cuts,
    };
  } catch (err) {
    return {
      feasible: false, rotated, frameW, frameH, count: 0, tree: null,
      items: [], cuts: [], reasonCode: 'search_failed',
      reason: err && err.message ? err.message : '裁切搜索失败',
    };
  }
}

/**
 * 不可行方向的结构化原因：只列出真正不足（正值）的维度。
 */
function buildInfeasibleReason(frameW, frameH, itemW, itemH, rotated) {
  const shortageWidthMm = Math.max(0, itemW - frameW);
  const shortageHeightMm = Math.max(0, itemH - frameH);
  const parts = [];
  if (shortageWidthMm > FIT_EPSILON_MM) parts.push(`宽度不足 ${round2(shortageWidthMm)} mm`);
  if (shortageHeightMm > FIT_EPSILON_MM) parts.push(`高度不足 ${round2(shortageHeightMm)} mm`);
  const prefix = rotated ? '纸张旋转 90° 后' : '纸张原向';
  return {
    orientation: rotated ? 'rotated_90' : 'as_is',
    fits: false,
    frameWidthMm: round2(frameW),
    frameHeightMm: round2(frameH),
    shortageWidthMm: round2(shortageWidthMm),
    shortageHeightMm: round2(shortageHeightMm),
    message: parts.length ? `${prefix}${parts.join('、')}` : `${prefix}可容纳`,
  };
}

/**
 * 评估一种原纸：枚举原向与旋转 90°，选单张产出最多的方向（产出相同时
 * 废料一致，优先原向）；产出为 0 时按不可行处理并给出两个方向的不足量。
 */
function evaluatePaper(spec, itemWMm, itemHMm, requiredSheets) {
  const paperInfo = {
    name: spec.name,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    widthPt: round4(spec.widthMm * PT_PER_MM),
    heightPt: round4(spec.heightMm * PT_PER_MM),
    pricePerSheet: spec.pricePerSheet,
    setupFee: spec.setupFee,
  };

  const asIs = solveOrientation(spec.widthMm, spec.heightMm, itemWMm, itemHMm, false);
  const squarePaper = Math.abs(spec.widthMm - spec.heightMm) <= FIT_EPSILON_MM;
  // 正方形原纸旋转后完全等价，直接复用，避免重复搜索
  const rotated = squarePaper
    ? asIs
    : solveOrientation(spec.heightMm, spec.widthMm, itemWMm, itemHMm, true);

  const infeasibleBase = {
    index: spec.index,
    name: spec.name,
    paper: paperInfo,
    feasible: false,
  };

  // 两个方向都因规模上限/搜索失败而无法给出方案：原样上报原因
  const abnormal = [asIs, rotated].find((o) => o.reasonCode);
  if (abnormal && !asIs.feasible && !rotated.feasible) {
    return {
      ...infeasibleBase,
      reasonCode: abnormal.reasonCode,
      reason: abnormal.reason,
      reasons: [],
    };
  }

  if (!asIs.feasible && !rotated.feasible) {
    const reasons = [
      buildInfeasibleReason(spec.widthMm, spec.heightMm, itemWMm, itemHMm, false),
      buildInfeasibleReason(spec.heightMm, spec.widthMm, itemWMm, itemHMm, true),
    ];
    return {
      ...infeasibleBase,
      reasons,
      reason: `纸张「${spec.name}」（${spec.widthMm} × ${spec.heightMm} mm）无法裁出`
        + `${round2(itemWMm)} × ${round2(itemHMm)} mm 的印张（已枚举原向与旋转 90°）：`
        + `${reasons[0].message}；${reasons[1].message}`,
    };
  }

  // 可行方向中选产出最多者；产出相同时优先原向
  const chosen = [asIs, rotated]
    .filter((o) => o.feasible)
    .sort((x, y) => (y.count - x.count) || (x.rotated ? 1 : 0) - (y.rotated ? 1 : 0))[0];

  const paperAreaMm2 = spec.widthMm * spec.heightMm;
  const yieldsPerSheet = chosen.count;
  const sheetsRequired = Math.ceil(requiredSheets / yieldsPerSheet);
  // 尾张：投用原纸的最后一张只需裁出余数张印张；整除时没有尾张
  const remainder = requiredSheets % yieldsPerSheet;
  const hasLastSheet = remainder !== 0;
  const fullSheets = hasLastSheet ? sheetsRequired - 1 : sheetsRequired;
  const lastSheetYield = hasLastSheet ? remainder : 0;
  const lastSheetSpare = hasLastSheet ? yieldsPerSheet - remainder : 0;
  // 单张废料取自裁切树的废料叶节点（实际几何，恰好铺满时为 0）
  const perSheetWasteMm2 = chosen.wasteArea;
  // 尾张废料 = 其未裁出的印张位面积 + 单张常规废料（尾张只放余数张，
  // 按同一张裁切图取前 remainder 个位即可，其余位与常规废料合计为尾张废料）
  const usedAreaPerItem = (paperAreaMm2 - perSheetWasteMm2) / yieldsPerSheet;
  const lastSheetWasteMm2 = hasLastSheet
    ? paperAreaMm2 - remainder * usedAreaPerItem
    : 0;
  // 总废料 = 全部投用原纸面积 − 全部裁出印张的占用面积（含尾张未用区域）
  const totalWasteMm2 = fullSheets * perSheetWasteMm2
    + (hasLastSheet ? lastSheetWasteMm2 : 0);
  const utilization = (usedAreaPerItem * yieldsPerSheet) / paperAreaMm2;

  return {
    index: spec.index,
    name: spec.name,
    paper: paperInfo,
    feasible: true,
    yieldsPerSheet,
    sheetsRequired,
    lastSheet: {
      isLastSheetPartial: hasLastSheet,
      fullSheets,
      lastSheetYield,
      spareCapacity: lastSheetSpare,
      exact: !hasLastSheet,
    },
    placement: {
      rotated: chosen.rotated,
      orientation: chosen.rotated ? 'rotated_90' : 'as_is',
      frameWidthMm: round2(chosen.frameW),
      frameHeightMm: round2(chosen.frameH),
      rotatedItemCount: chosen.rotatedItemCount,
      asIsItemCount: yieldsPerSheet - chosen.rotatedItemCount,
    },
    utilization: round4(utilization),
    utilizationPercent: round2(utilization * 100),
    waste: {
      perSheetAreaMm2: round2(perSheetWasteMm2),
      lastSheetAreaMm2: round2(lastSheetWasteMm2),
      totalAreaMm2: round2(totalWasteMm2),
    },
    cutting: {
      frame: { widthMm: round2(chosen.frameW), heightMm: round2(chosen.frameH) },
      item: { widthMm: round2(itemWMm), heightMm: round2(itemHMm) },
      cutCount: chosen.cuts.length,
      items: chosen.items,
      cuts: chosen.cuts,
      tree: chosen.tree,
    },
  };
}

/**
 * 计算批量裁切下料方案。
 *
 * @param {object} plan 拼版方案（X-Imposition-Plan 解码后的对象）
 * @param {Array} rawPaperSpecs 用户维护的纸张规格（1～8 种，字段同 /api/quote）
 * @param {*} rawRequired 所需印张数（1～MAX_REQUIRED_SHEETS 的整数）
 * @returns {object} 裁切方案（feasible=false 时 recommended=null 并给出原因）
 */
function buildCuttingPlan(plan, rawPaperSpecs, rawRequired) {
  const layout = readLayout(plan);
  const specs = normalizePaperSpecs(rawPaperSpecs);
  const requiredSheets = parseRequiredSheets(rawRequired);

  const itemWMm = ptToMm(layout.sheetWidthPt);
  const itemHMm = ptToMm(layout.sheetHeightPt);

  const options = specs.map((spec) => evaluatePaper(spec, itemWMm, itemHMm, requiredSheets));
  const feasibleOptions = options
    .filter((o) => o.feasible)
    .sort((a, b) => {
      // 推荐顺序：所需原纸张数升序 → 总废料面积升序 → 单张产出降序 → 维护顺序
      if (a.sheetsRequired !== b.sheetsRequired) return a.sheetsRequired - b.sheetsRequired;
      if (a.waste.totalAreaMm2 !== b.waste.totalAreaMm2) {
        return a.waste.totalAreaMm2 - b.waste.totalAreaMm2;
      }
      if (a.yieldsPerSheet !== b.yieldsPerSheet) return b.yieldsPerSheet - a.yieldsPerSheet;
      return a.index - b.index;
    });

  const layoutInfo = {
    signatureMode: layout.signatureMode,
    signatureCount: layout.signatureCount,
    sheetCount: layout.sheetCount,
    runCount: layout.runCount,
    panel: {
      widthPt: round4(layout.panelWidthPt),
      heightPt: round4(layout.panelHeightPt),
      widthMm: round2(ptToMm(layout.panelWidthPt)),
      heightMm: round2(ptToMm(layout.panelHeightPt)),
      orientation: layout.orientation,
    },
    sheet: {
      widthPt: round4(layout.sheetWidthPt),
      heightPt: round4(layout.sheetHeightPt),
      widthMm: round2(itemWMm),
      heightMm: round2(itemHMm),
    },
  };

  const result = {
    schemaVersion: 1,
    kind: 'sheet-cutting-plan',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    feasible: feasibleOptions.length > 0,
    requiredSheets,
    layout: layoutInfo,
    options,
    recommended: feasibleOptions.length > 0
      ? { index: feasibleOptions[0].index, name: feasibleOptions[0].name }
      : null,
  };

  if (!result.feasible) {
    const normal = options.filter((o) => !o.feasible && !o.reasonCode);
    const abnormal = options.find((o) => !o.feasible && o.reasonCode);
    // 只要存在按尺寸放不下的原纸，就汇总各原纸的具体不足/异常原因；
    // 全部都是规模超限/搜索失败等异常时，直接采用异常原因
    if (normal.length > 0) {
      result.reasonCode = 'no_fitting_paper';
      result.reason = `印张实际输出尺寸为 ${layoutInfo.sheet.widthMm} × `
        + `${layoutInfo.sheet.heightMm} mm，维护的 ${options.length} 种原纸均无法裁出`
        + '（已枚举原向与旋转 90°）：'
        + options.map((o) => {
          if (o.reasons && o.reasons.length === 2) {
            return `「${o.name}」（${o.paper.widthMm} × ${o.paper.heightMm} mm）`
              + `${o.reasons[0].message}，${o.reasons[1].message}`;
          }
          return `「${o.name}」无法裁切（${o.reason || '尺寸不匹配'}）`;
        }).join('；');
    } else {
      result.reasonCode = abnormal.reasonCode;
      result.reason = abnormal.reason;
    }
  }

  return result;
}

module.exports = {
  PT_PER_MM,
  MAX_REQUIRED_SHEETS,
  MAX_ITEMS_PER_SHEET,
  FIT_EPSILON_MM,
  parseRequiredSheets,
  solveGuillotine,
  positionTree,
  buildCuttingPlan,
};
