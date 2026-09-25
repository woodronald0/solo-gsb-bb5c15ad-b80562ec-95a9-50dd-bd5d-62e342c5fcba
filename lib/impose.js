'use strict';

const {
  PDFDocument,
  degrees,
  pushGraphicsState,
  rectangle,
  clip,
  endPath,
  popGraphicsState,
} = require('pdf-lib');
const {
  MARK_MARGIN_MM,
  PT_PER_MM,
  computeSheetSize,
  drawSheetMarks,
} = require('./sheet-marks');

/**
 * 分册签帖模式下，每帖纸张数上限（每纸容纳 4 页，即单帖容量上限 = 4 × 20 = 80 页）。
 */
const MAX_SHEETS_PER_SIGNATURE = 20;

/**
 * 骑马钉爬移补偿（creep）：启用后输入纸厚（mm），每帖从外到内按帖内张号
 * 计算单侧内移量 = （张号－1）× 纸厚；同一印张正背两面的左页向右、右页向左
 * 平移该量，槽位裁切在各自半区（越过中央折线的部分被裁掉，空白保持空白）。
 * 分册签帖各帖分别从帖内第 1 张（0 mm）重新起算。
 */
/** 纸厚下限（mm） */
const MIN_PAPER_THICKNESS_MM = 0.05;
/** 纸厚上限（mm） */
const MAX_PAPER_THICKNESS_MM = 0.5;

/**
 * 骑马钉（saddle-stitch）拼版核心逻辑。
 *
 * 每张纸正反两页（两个 output PDF page），每排放两个原始页，即每张纸容纳 4 页：
 *   - 正面（front）：末页(左) | 首页(右)
 *   - 背面（back） ：第 2 页(左) | 倒数第 2 页(右)
 *   其余纸张按同样方式逐层向内递进。
 * 页数不是 4 的倍数时，在文档末尾补空白页。
 *
 * 分册签帖模式：按原页序把文档切成容量为 4 × 每帖纸张数的连续签帖，每帖
 * 独立按上述骑马钉规则排版，仅在各帖自身末尾补白；最后一帖不足上限时按
 * 实际页数所需纸张数收尾。结果按帖号顺序连续输出到同一个 PDF。
 *
 * 混合尺寸适配：各页尺寸或旋转方向不一致时，按每页旋转后的有效宽高取
 * 全部页面宽高的最大值作为统一面板尺寸；每页按其显示方向 1:1 居中放入
 * 对应半区，空余区域保持透明留白。
 *
 * 印张定位标记（options.registrationMarks）：勾选后版心四周各增加 8mm
 * 空白，正背两面的四角绘制仅位于版心之外的裁切线，中央折线上下端在空白
 * 区绘制定位线；源页仍按原尺寸与页序放置（随版心整体偏移一个边距）。
 */

/**
 * 根据原始页数返回需要补的空白页数（0~3）。
 * @param {number} sourceCount
 * @returns {number}
 */
function blanksForCount(sourceCount) {
  return (4 - (sourceCount % 4)) % 4;
}

/**
 * 生成拼版页序方案。
 *
 * 返回的每张纸：
 *   { sheet: 1, front: { left: 页码|null, right: 页码|null },
 *                   back:  { left: 页码|null, right: 页码|null } }
 * 页码从 1 开始；null 表示补齐的空白页（页码标识为 padded: true）。
 *
 * @param {number} sourceCount 原始 PDF 页数
 * @returns {{ sheets: Array, sourceCount: number, paddedCount: number, totalCount: number, blanks: number }}
 */
function buildImpositionPlan(sourceCount) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }

  const blanks = blanksForCount(sourceCount);
  const totalCount = sourceCount + blanks;
  const sheetsPerSheet = totalCount / 4;

  const sheets = [];
  for (let i = 0; i < sheetsPerSheet; i += 1) {
    // 正面：从尾部取左页、从头部取右页
    const frontLeft = totalCount - 2 * i;       // 末页、倒数第 4、倒数第 8 ...
    const frontRight = 2 * i + 1;               // 首页、第 3 页、第 5 页 ...
    // 背面：从头部取左页、从尾部取右页
    const backLeft = 2 * i + 2;                 // 第 2 页、第 6 页、第 10 页 ...
    const backRight = totalCount - 2 * i - 1;   // 倒数第 2、倒数第 6 ...

    sheets.push({
      sheet: i + 1,
      front: {
        left: pageSlot(frontLeft, sourceCount),
        right: pageSlot(frontRight, sourceCount),
      },
      back: {
        left: pageSlot(backLeft, sourceCount),
        right: pageSlot(backRight, sourceCount),
      },
    });
  }

  return {
    sheets,
    sourceCount,
    paddedCount: blanks,
    totalCount,
    blanks,
  };
}

function pageSlot(position, sourceCount) {
  if (position <= sourceCount) {
    return { page: position, blank: false };
  }
  return { page: null, blank: true };
}

/**
 * 解析并校验「每帖最多纸张数」入参（分册签帖模式）。
 * 仅接受 1 ~ MAX_SHEETS_PER_SIGNATURE（20）之间的整数，其余一律拒绝。
 *
 * @param {*} value
 * @returns {number}
 */
function parseMaxSheetsPerSignature(value) {
  const message = `每帖最多纸张数必须是 1～${MAX_SHEETS_PER_SIGNATURE} 之间的整数`;
  if (typeof value === 'string') {
    if (!/^\s*\d+\s*$/.test(value)) throw new Error(message);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < 1 || value > MAX_SHEETS_PER_SIGNATURE) {
    throw new Error(message);
  }
  return value;
}

/**
 * 解析并校验骑马钉爬移补偿的纸厚入参（mm）。
 * 仅接受 0.05～0.50 mm 之间的正数（允许前后空白、无前导 0 的小数），其余一律拒绝。
 *
 * @param {*} value
 * @returns {number} 纸厚（mm）
 */
function parsePaperThicknessMm(value) {
  const message = `纸厚必须是 ${MIN_PAPER_THICKNESS_MM}～${MAX_PAPER_THICKNESS_MM} mm 之间的数值`;
  if (typeof value === 'string') {
    if (!/^\s*(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(value)) throw new Error(message);
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < MIN_PAPER_THICKNESS_MM || value > MAX_PAPER_THICKNESS_MM) {
    throw new Error(message);
  }
  return value;
}

/**
 * 爬移单侧内移量（mm）：帖内第 sheetNumber 张纸（1 基）= （张号－1）× 纸厚。
 * 每帖最外层第 1 张为 0 mm，向内逐张递增；结果保留 4 位小数避免浮点尾数。
 *
 * @param {number} sheetNumber 帖内张号（1 基）
 * @param {number} paperThicknessMm 纸厚（mm）
 * @returns {number} 单侧内移量（mm）
 */
function creepShiftMm(sheetNumber, paperThicknessMm) {
  const value = (sheetNumber - 1) * paperThicknessMm;
  return Math.round(value * 10000) / 10000;
}

/**
 * 为方案中的每张纸标注爬移补偿量。整册模式张号即全册张号；分册签帖模式
 * 各帖帖内张号分别从 1 起算（每帖第 1 张均为 0 mm）。
 *
 * @param {object} plan buildImpositionPlan / buildSignaturePlan 生成的方案
 * @param {number} paperThicknessMm 纸厚（mm）
 * @returns {object} 标注后的同一 plan 对象
 */
function annotateCreep(plan, paperThicknessMm) {
  if (plan.signatureMode) {
    for (const signature of plan.signatures) {
      for (const sheet of signature.sheets) {
        sheet.creep = { shiftMm: creepShiftMm(sheet.sheet, paperThicknessMm) };
      }
    }
  } else {
    for (const sheet of plan.sheets) {
      sheet.creep = { shiftMm: creepShiftMm(sheet.sheet, paperThicknessMm) };
    }
  }
  return plan;
}

/**
 * 分册签帖模式下的单个槽位：页码使用全局（整篇文档）1 基页号。
 *
 * @param {number} position 帖内位置（1 基，含补白位置）
 * @param {number} sigSourceCount 该帖实际原始页数
 * @param {number} startPage 该帖首页的全局页号
 * @returns {{ page: number|null, blank: boolean }}
 */
function signatureSlot(position, sigSourceCount, startPage) {
  if (position <= sigSourceCount) {
    return { page: startPage + position - 1, blank: false };
  }
  return { page: null, blank: true };
}

/**
 * 生成分册签帖的拼版页序方案。
 *
 * 按原页序把 sourceCount 页切成容量 4 × maxSheetsPerSignature 的连续签帖：
 *   - 前序各帖装满 4 × max 页；最后一帖按实际页数收尾；
 *   - 仅在各帖自身末尾补白至 4 的倍数（blanks 0~3）；
 *   - 各帖独立按骑马钉规则生成纸张，帖内纸张编号 1 起；
 *   - 槽位页码为全局（整篇文档）1 基页号，便于后续统一绘制。
 *
 * @param {number} sourceCount 原始 PDF 总页数
 * @param {number} maxSheetsPerSignature 每帖最多纸张数（1～20）
 * @returns {{
 *   signatureMode: true,
 *   signatures: Array<{
 *     signature: number,
 *     startPage: number, endPage: number, sourceCount: number,
 *     blanks: number, totalCount: number,
 *     sheets: Array
 *   }>,
 *   sourceCount: number,
 *   paddedCount: number,
 *   sheetCount: number,
 *   signatureCount: number,
 *   maxSheetsPerSignature: number
 * }}
 */
function buildSignaturePlan(sourceCount, maxSheetsPerSignature) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }
  const maxSheets = parseMaxSheetsPerSignature(maxSheetsPerSignature);
  const capacity = maxSheets * 4;

  const signatures = [];
  let paddedCount = 0;
  let sheetCount = 0;
  for (let start = 1; start <= sourceCount; start += capacity) {
    const sigSourceCount = Math.min(capacity, sourceCount - start + 1);
    const blanks = blanksForCount(sigSourceCount);
    const totalCount = sigSourceCount + blanks;
    const sheetsPerSignature = totalCount / 4;

    const sheets = [];
    for (let i = 0; i < sheetsPerSignature; i += 1) {
      // 同整册规则：正面尾|首，背面首+1|尾-1，逐张向内递进
      const frontLeft = totalCount - 2 * i;
      const frontRight = 2 * i + 1;
      const backLeft = 2 * i + 2;
      const backRight = totalCount - 2 * i - 1;

      sheets.push({
        sheet: i + 1,
        front: {
          left: signatureSlot(frontLeft, sigSourceCount, start),
          right: signatureSlot(frontRight, sigSourceCount, start),
        },
        back: {
          left: signatureSlot(backLeft, sigSourceCount, start),
          right: signatureSlot(backRight, sigSourceCount, start),
        },
      });
    }

    signatures.push({
      signature: signatures.length + 1,
      startPage: start,
      endPage: start + sigSourceCount - 1,
      sourceCount: sigSourceCount,
      blanks,
      totalCount,
      sheets,
    });
    paddedCount += blanks;
    sheetCount += sheets.length;
  }

  return {
    signatureMode: true,
    signatures,
    sourceCount,
    paddedCount,
    sheetCount,
    signatureCount: signatures.length,
    maxSheetsPerSignature: maxSheets,
  };
}

/**
 * 把 PDF 的 /Rotate 角度规范化为 0 / 90 / 180 / 270。
 * 负角、超圈角（如 -90、450）都会折算到标准直角；非 90 倍数按最近直角取整。
 * @param {number} angle
 * @returns {number}
 */
function normalizeRotation(angle) {
  const quarterTurns = Math.round((Number(angle) || 0) / 90);
  return (((quarterTurns % 4) + 4) % 4) * 90;
}

/**
 * 页面旋转后的有效宽高（即阅读器实际展示的宽高）。
 * 旋转 90°/270° 时宽高互换。
 *
 * @param {PDFPage} page pdf-lib 页面对象
 * @returns {{ rotation: number, width: number, height: number }}
 */
function effectivePageSize(page) {
  const rotation = normalizeRotation(page.getRotation().angle);
  const width = page.getWidth();
  const height = page.getHeight();
  const swapped = rotation === 90 || rotation === 270;
  return {
    rotation,
    width: swapped ? height : width,
    height: swapped ? width : height,
  };
}

/**
 * 混合尺寸适配：以全部页面有效宽、有效高的最大值作为统一面板尺寸，
 * 并据此给出面板方向（portrait 竖版 / landscape 横版 / square 方形）。
 *
 * @param {Array<{ width: number, height: number }>} pageSizes 各页有效宽高
 * @returns {{ width: number, height: number, orientation: string }}
 */
function computePanelSize(pageSizes) {
  if (!pageSizes.length) {
    throw new Error('PDF 不包含任何页面');
  }
  let width = 0;
  let height = 0;
  for (const size of pageSizes) {
    if (size.width > width) width = size.width;
    if (size.height > height) height = size.height;
  }
  let orientation = 'square';
  if (width > height) orientation = 'landscape';
  else if (height > width) orientation = 'portrait';
  return { width, height, orientation };
}

/**
 * 计算源页在半区内的绘制参数：页面按旋转后的显示方向 1:1 居中，不缩放。
 *
 * drawPage 的 rotate 以锚点 (x, y) 为原点**逆时针**旋转，而 PDF /Rotate 为
 * **顺时针**显示旋转，故取相反角度，并把锚点平移到旋转后内容包围盒对应的
 * 角上，使旋转后的内容恰好落在半区居中位置。
 *
 * @param {number} srcWidth 源页介质宽（未旋转）
 * @param {number} srcHeight 源页介质高（未旋转）
 * @param {number} rotation 规范化后的旋转角（0/90/180/270）
 * @param {number} originX 半区左边缘在纸面上的 x 坐标
 * @param {number} panelWidth 统一面板宽
 * @param {number} panelHeight 统一面板高
 * @returns {{ x: number, y: number, rotate: number }}
 */
function slotPlacement(srcWidth, srcHeight, rotation, originX, panelWidth, panelHeight) {
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? srcHeight : srcWidth;
  const dispH = swapped ? srcWidth : srcHeight;
  const x = originX + (panelWidth - dispW) / 2;
  const y = (panelHeight - dispH) / 2;
  switch (rotation) {
    case 90:
      return { x, y: y + dispH, rotate: -90 };
    case 180:
      return { x: x + dispW, y: y + dispH, rotate: 180 };
    case 270:
      return { x: x + dispW, y, rotate: -270 };
    default:
      return { x, y, rotate: 0 };
  }
}

/**
 * 执行拼版并返回新 PDF 的字节数据。
 *
 * 输出每张纸为横向（landscape）尺寸：宽 = 2 × 面板宽，高 = 面板高。
 * 统一面板尺寸取全部页面旋转后有效宽高的最大值；每个原始页按其显示方向
 * 1:1（不缩放）居中绘制到对应半区，空余区域透明留白。补的空白页不绘制任何内容。
 *
 * 分册签帖模式（options.maxSheetsPerSignature 为 1～20 的整数）：先按容量
 * 4 × 每帖纸张数切成连续签帖，各帖独立补白与骑马钉排版，结果按帖号顺序
 * 连续输出到同一个 PDF。
 *
 * 印张定位标记（options.registrationMarks 为 true）：版心四周各加 8mm
 * 空白并绘制裁切线/折线定位线，整册与分册签帖均适用；方案中记录实际输出
 * 印张宽高（plan.sheet）与标记状态（plan.marks），供报价按实际印张判断。
 *
 * 骑马钉爬移补偿（options.creepCompensation 为 true，配合
 * options.paperThicknessMm）：每帖从外到内按帖内张号把单侧内移量
 * （张号－1）×纸厚 写入方案（每张纸 sheet.creep.shiftMm），同一印张
 * 正背两面左页向右、右页向左平移该量并在各自半区内裁切；补白保持空白，
 * 页序、印张尺寸与用纸数量均不改变。未启用时方案与输出完全保持原样。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ maxSheetsPerSignature?: number, registrationMarks?: boolean,
 *           creepCompensation?: boolean, paperThicknessMm?: number|string }} [options]
 *        maxSheetsPerSignature 缺省/为空时保持整册拼版行为；
 *        registrationMarks 缺省/false 时输出尺寸与原行为完全一致；
 *        creepCompensation 缺省/false 时不进行爬移补偿，启用时
 *        paperThicknessMm 必须为 0.05～0.5 mm
 * @returns {Promise<{ pdfBytes: Uint8Array, plan: object }>}
 *          plan 中附带 panel：{ width, height, orientation } 统一面板信息、
 *          sheet：{ width, height } 实际输出印张尺寸（pt）、
 *          marks：{ enabled, marginMm } 定位标记状态、
 *          creep：{ enabled, paperThicknessMm } 爬移补偿状态，
 *          每张纸另有 creep.shiftMm（该帖帖内张号对应的单侧内移量 mm）
 */
async function imposePdf(sourceBytes, options = {}) {
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    // 触发一次页树读取，损坏/被截断的文件会在此处暴露异常
    srcDoc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密）');
  }
  const sourceCount = srcDoc.getPageCount();
  if (sourceCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }

  const signatureMode = options.maxSheetsPerSignature !== undefined
    && options.maxSheetsPerSignature !== null
    && options.maxSheetsPerSignature !== '';
  // 骑马钉爬移补偿：启用时纸厚必须为 0.05～0.5 mm（非法值在此直接抛错）
  const creepEnabled = Boolean(options.creepCompensation);
  const paperThicknessMm = creepEnabled
    ? parsePaperThicknessMm(options.paperThicknessMm)
    : 0;
  const plan = signatureMode
    ? buildSignaturePlan(sourceCount, options.maxSheetsPerSignature)
    : buildImpositionPlan(sourceCount);
  if (creepEnabled) {
    annotateCreep(plan, paperThicknessMm);
    plan.creep = { enabled: true, paperThicknessMm };
  } else {
    plan.creep = { enabled: false, paperThicknessMm: 0 };
  }

  // 混合尺寸适配：逐页按旋转后的有效宽高计算，统一面板取全部页面宽高的最大值
  const pageInfos = srcDoc.getPages().map((page) => effectivePageSize(page));
  const panel = computePanelSize(pageInfos);
  plan.panel = panel;

  // 印张定位标记：启用后版心四周各加 8mm 空白；方案记录实际输出印张宽高，
  // 未启用时印张 = 2 × 面板宽 × 面板高，与原行为完全一致
  const marksEnabled = Boolean(options.registrationMarks);
  const sheetSize = computeSheetSize(panel, marksEnabled);
  plan.sheet = { width: sheetSize.width, height: sheetSize.height };
  plan.marks = { enabled: marksEnabled, marginMm: marksEnabled ? MARK_MARGIN_MM : 0 };

  const outDoc = await PDFDocument.create();
  // 将全部源页作为 XObject 嵌入（保留其字体/图片/批注等资源），再逐页绘制到拼版纸上。
  // drawPage 需要 embedPdf 返回的 PDFEmbeddedPage（copyPages 的页面对象不能直接绘制）。
  const indices = Array.from({ length: sourceCount }, (_, i) => i);
  const embeddedPages = await outDoc.embedPdf(srcDoc, indices);

  const sheetWidth = sheetSize.width;
  const sheetHeight = sheetSize.height;
  // 版心（原版面）在纸面上的偏移：未启用标记时为 0，源页放置位置不变
  const layout = {
    offsetX: sheetSize.marginPt,
    offsetY: sheetSize.marginPt,
    marks: marksEnabled,
    creep: creepEnabled,
  };

  if (plan.signatureMode) {
    // 各帖依次输出；帖内纸张编号独立 1 起，页码为全局页号
    for (const signature of plan.signatures) {
      for (const sheet of signature.sheets) {
        renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos, layout);
      }
    }
    outDoc.setTitle(
      `拼版小册子（${sourceCount} 页 / ${plan.signatureCount} 帖 / ${plan.sheetCount} 张纸）`,
    );
  } else {
    for (const sheet of plan.sheets) {
      renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos, layout);
    }
    outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.sheets.length} 张纸）`);
  }
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();
  return { pdfBytes, plan };
}

/**
 * 在输出文档中追加一张纸（正面 + 背面两个输出页），并把槽位绘制到半区。
 * layout.offsetX/offsetY 为版心（原版面）在纸面上的偏移（启用定位标记时
 * 为 8mm 边距，否则为 0）；layout.marks 为 true 时在正背两面绘制定位标记；
 * layout.creep 为 true 时按该帖帖内张号做爬移平移（左页向右、右页向左），
 * 平移量取自 sheet.creep.shiftMm（正背两面相同）。
 */
function renderSheet(outDoc, sheet, sheetWidth, sheetHeight, panel, embeddedPages, pageInfos, layout) {
  // 爬移单侧内移量（pt）：未启用时为 0，左/右页分别取相反方向
  const shiftPt = layout.creep && sheet.creep
    ? sheet.creep.shiftMm * PT_PER_MM
    : 0;

  // 正面：左 | 右
  const front = outDoc.addPage([sheetWidth, sheetHeight]);
  drawSlot(front, sheet.front.left, embeddedPages, pageInfos, layout.offsetX, panel, layout.offsetY, shiftPt);
  drawSlot(front, sheet.front.right, embeddedPages, pageInfos, layout.offsetX + panel.width, panel, layout.offsetY, -shiftPt);
  if (layout.marks) drawSheetMarks(front, sheetWidth, sheetHeight, panel);

  // 背面：左 | 右
  const back = outDoc.addPage([sheetWidth, sheetHeight]);
  drawSlot(back, sheet.back.left, embeddedPages, pageInfos, layout.offsetX, panel, layout.offsetY, shiftPt);
  drawSlot(back, sheet.back.right, embeddedPages, pageInfos, layout.offsetX + panel.width, panel, layout.offsetY, -shiftPt);
  if (layout.marks) drawSheetMarks(back, sheetWidth, sheetHeight, panel);
}

/**
 * 把一个槽位（原始页或空白页）绘制到目标纸面上。
 * 原始页面按其旋转后的显示方向 1:1 居中绘制到自己的半区，不缩放；
 * 半区内未被覆盖的区域保持透明留白。originY 为半区底部在纸面上的偏移
 * （启用定位标记时为 8mm 边距，否则为 0）。
 *
 * shiftX（pt）为爬移补偿的水平平移量：左页传正值（向右）、右页传负值
 * （向左），正背两面相同。平移后内容越过中央折线/半区外沿的部分通过半区
 * 矩形裁剪路径裁掉（槽位裁切在各自半区）；shiftX 为 0 时行为与原样完全一致。
 */
function drawSlot(targetSheet, slot, embeddedPages, pageInfos, originX, panel, originY = 0, shiftX = 0) {
  if (slot.blank) {
    return; // 补的空白页：保持完全空白
  }
  const embedded = embeddedPages[slot.page - 1];
  const info = pageInfos[slot.page - 1];
  const { x, y, rotate } = slotPlacement(
    embedded.width,
    embedded.height,
    info.rotation,
    originX,
    panel.width,
    panel.height,
  );
  if (shiftX !== 0) {
    // 在半区矩形内裁剪后再绘制，保证内移后越出半区（含越过中央折线）的部分不显示
    targetSheet.pushOperators(
      pushGraphicsState(),
      rectangle(originX, originY, panel.width, panel.height),
      clip(),
      endPath(),
    );
  }
  targetSheet.drawPage(embedded, { x: x + shiftX, y: y + originY, rotate: degrees(rotate) });
  if (shiftX !== 0) {
    targetSheet.pushOperators(popGraphicsState());
  }
}

module.exports = {
  MAX_SHEETS_PER_SIGNATURE,
  MIN_PAPER_THICKNESS_MM,
  MAX_PAPER_THICKNESS_MM,
  blanksForCount,
  buildImpositionPlan,
  buildSignaturePlan,
  parseMaxSheetsPerSignature,
  parsePaperThicknessMm,
  creepShiftMm,
  annotateCreep,
  normalizeRotation,
  effectivePageSize,
  computePanelSize,
  slotPlacement,
  imposePdf,
};
