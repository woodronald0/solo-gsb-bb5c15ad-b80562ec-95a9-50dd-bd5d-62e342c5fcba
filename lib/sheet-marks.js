'use strict';

const { rgb } = require('pdf-lib');

/**
 * 印张定位标记（trim / registration marks）。
 *
 * 启用后输出印张在版心（原拼版版面：2 × 面板宽 × 面板高）四周各增加
 * MARK_MARGIN_MM（8mm）空白，并在每张纸的正、背两面绘制：
 *   - 版心四角的裁切线：水平/垂直线段仅位于版心之外的空白区内，
 *     从版心边缘画到纸张边缘；
 *   - 中央折线（左右面板分界）上下端的定位线：仅位于上下空白区内。
 * 源页仍按原尺寸与页序放置（整体随版心偏移一个边距），所有标记线
 * 均不进入版心区域。
 */

/** 版心四周的空白边距（mm） */
const MARK_MARGIN_MM = 8;
/** 1 mm 对应的 pt 数（1 inch = 25.4 mm = 72 pt） */
const PT_PER_MM = 72 / 25.4;
/** 版心四周的空白边距（pt） */
const MARK_MARGIN_PT = MARK_MARGIN_MM * PT_PER_MM;
/** 标记线宽（pt） */
const MARK_LINE_WIDTH_PT = 0.5;

/**
 * 计算输出印张尺寸。
 *
 * @param {{ width: number, height: number }} panel 统一面板尺寸（pt）
 * @param {boolean} marksEnabled 是否启用定位标记
 * @returns {{ width: number, height: number, marginPt: number }}
 *          未启用时 marginPt 为 0，印张 = 2 × 面板宽 × 面板高；
 *          启用后版心四周各加 8mm，marginPt 即版心左下角在纸面上的偏移量。
 */
function computeSheetSize(panel, marksEnabled) {
  const marginPt = marksEnabled ? MARK_MARGIN_PT : 0;
  return {
    width: panel.width * 2 + marginPt * 2,
    height: panel.height + marginPt * 2,
    marginPt,
  };
}

/**
 * 在输出页（正面或背面）上绘制印张定位标记。
 * 所有线段均位于版心之外的 8mm 空白区内，不进入版心。
 *
 * @param {PDFPage} page pdf-lib 输出页
 * @param {number} sheetWidth 印张宽（pt，含边距）
 * @param {number} sheetHeight 印张高（pt，含边距）
 * @param {{ width: number, height: number }} panel 统一面板尺寸（pt）
 */
function drawSheetMarks(page, sheetWidth, sheetHeight, panel) {
  const m = MARK_MARGIN_PT;
  const left = m;                    // 版心左缘
  const right = m + panel.width * 2; // 版心右缘
  const bottom = m;                  // 版心下缘
  const top = m + panel.height;      // 版心上缘
  const centerX = m + panel.width;   // 中央折线（左右面板分界）

  const color = rgb(0, 0, 0);
  const line = (x1, y1, x2, y2) => {
    page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness: MARK_LINE_WIDTH_PT,
      color,
    });
  };

  // 四角裁切线：水平段在版心左/右缘之外，垂直段在版心下/上缘之外
  line(0, bottom, left, bottom);            // 左下角：水平
  line(left, 0, left, bottom);              // 左下角：垂直
  line(right, bottom, sheetWidth, bottom);  // 右下角：水平
  line(right, 0, right, bottom);            // 右下角：垂直
  line(0, top, left, top);                  // 左上角：水平
  line(left, top, left, sheetHeight);       // 左上角：垂直
  line(right, top, sheetWidth, top);        // 右上角：水平
  line(right, top, right, sheetHeight);     // 右上角：垂直

  // 中央折线上下端的定位线（仅位于上下空白区内）
  line(centerX, 0, centerX, bottom);
  line(centerX, top, centerX, sheetHeight);
}

module.exports = {
  MARK_MARGIN_MM,
  PT_PER_MM,
  MARK_MARGIN_PT,
  MARK_LINE_WIDTH_PT,
  computeSheetSize,
  drawSheetMarks,
};
