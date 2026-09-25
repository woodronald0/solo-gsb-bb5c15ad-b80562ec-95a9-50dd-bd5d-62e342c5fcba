'use strict';

const { PDFDocument } = require('pdf-lib');
const { imposePdf } = require('./impose');

/**
 * 缺页补印核心逻辑。
 *
 * 印刷完成后若部分原稿页受损，无需重印整册：输入受损的原稿页码或区间
 * （如 "2,5-7"），服务端按本次拼版选项（整册/分册签帖、定位标记、
 * 骑马钉爬移补偿与纸厚）复用拼版方案，在每张纸的正/背面四个槽位中定位
 * 受损页码所在的印张：
 *   - 同一印张命中多个受损页时只补印一次；
 *   - 分册签帖模式下累计各帖的输出页偏移（每帖占 2 × 帖内张数个输出页），
 *     据此把帖内张号换算为完整拼版输出中的页码；
 *   - 按原印张顺序从完整拼版输出中成对抽取正、背面，组成补印 PDF，
 *     印张尺寸、定位标记与爬移平移/半区裁切与原拼版输出完全一致
 *     （逐页原样复制）。
 */

/**
 * 补印页码输入错误（空输入、格式错误、越界页码），HTTP 层据此返回 400。
 */
class ReprintInputError extends Error {}

/**
 * 解析补印页码表达式的词法部分（不做越界校验）。
 *
 * 接受逗号分隔的单个页码与区间（如 "2,5-7"），允许空白字符；
 * 全角逗号「，」与全角/长破折号「～～–—―」按半角处理。
 * 空输入与任何无法识别的片段都抛出 ReprintInputError。
 *
 * @param {*} input 用户输入（缺失/非字符串按空输入处理）
 * @returns {number[]} 升序去重后的页码数组（未做越界校验）
 */
function parseReprintPagesSpec(input) {
  const raw = input === undefined || input === null ? '' : String(input);
  if (raw.trim() === '') {
    throw new ReprintInputError('请输入需要补印的原稿页码或区间（如 2,5-7）');
  }
  const normalized = raw.replace(/，/g, ',').replace(/[～~–—―]/g, '-');
  const pages = new Set();
  for (const rawToken of normalized.split(',')) {
    const token = rawToken.trim();
    if (token === '') {
      throw new ReprintInputError('页码格式错误：存在空的页码项（多余的逗号），正确形式如 2,5-7');
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        throw new ReprintInputError(`页码区间「${token}」的起点不能大于终点`);
      }
      for (let page = from; page <= to; page += 1) pages.add(page);
    } else if (/^\d+$/.test(token)) {
      pages.add(Number(token));
    } else {
      throw new ReprintInputError(
        `页码格式错误：无法识别「${token}」（支持单个页码与区间，如 2,5-7）`,
      );
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * 越界校验：页码为 1 基，必须落在 1～sourceCount 内。
 *
 * @param {number[]} pages 升序页码数组
 * @param {number} sourceCount 原稿总页数
 * @returns {number[]} 原样返回 pages
 */
function assertPagesInRange(pages, sourceCount) {
  const outOfRange = pages.filter((page) => page < 1 || page > sourceCount);
  if (outOfRange.length) {
    throw new ReprintInputError(
      `页码 ${outOfRange.join('、')} 超出原稿页码范围（1～${sourceCount}）`,
    );
  }
  return pages;
}

/**
 * 解析并校验补印页码表达式（词法 + 越界）。
 *
 * @param {*} input 用户输入
 * @param {number} sourceCount 原稿总页数
 * @returns {number[]} 升序去重后的合法页码数组
 */
function parseReprintPages(input, sourceCount) {
  return assertPagesInRange(parseReprintPagesSpec(input), sourceCount);
}

/**
 * 在拼版方案中定位受损页码所在的印张。
 *
 * 逐张纸检查正/背面四个槽位：同一印张命中多个受损页时只记录一次；
 * 结果按原印张输出顺序排列。分册签帖模式下累计各帖的输出页偏移
 * （每帖占 2 × 帖内张数个输出页），给出每张命中印张在完整拼版输出
 * 中的 1 基页码区间（正面、背面）。
 *
 * @param {object} plan 拼版方案（整册或分册签帖，与 imposePdf 返回的一致）
 * @param {number[]} pages 受损页码（1 基）
 * @returns {Array<{
 *   signature: number|null, sheet: number, signatureSheetCount: number|null,
 *   hitPages: number[], outputPages: [number, number], creepShiftMm: number
 * }>}
 */
function buildReprintPlan(plan, pages) {
  const wanted = new Set(pages);
  const hits = [];
  let outputOffset = 0; // 当前帖之前已输出的页数（分册模式下逐帖累计）

  const visitSheet = (sheet, signature) => {
    const hitPages = [];
    for (const side of ['front', 'back']) {
      for (const pos of ['left', 'right']) {
        const slot = sheet[side][pos];
        if (!slot.blank && wanted.has(slot.page)) {
          hitPages.push(slot.page);
        }
      }
    }
    if (hitPages.length === 0) return;
    const frontPage = outputOffset + (sheet.sheet - 1) * 2 + 1; // 1 基输出页码（正面）
    hits.push({
      signature: signature ? signature.signature : null,
      sheet: sheet.sheet,
      signatureSheetCount: signature ? signature.sheets.length : null,
      hitPages: hitPages.sort((a, b) => a - b),
      outputPages: [frontPage, frontPage + 1],
      creepShiftMm: sheet.creep ? sheet.creep.shiftMm : 0,
    });
  };

  if (plan.signatureMode) {
    for (const signature of plan.signatures) {
      for (const sheet of signature.sheets) visitSheet(sheet, signature);
      outputOffset += signature.sheets.length * 2;
    }
  } else {
    for (const sheet of plan.sheets) visitSheet(sheet, null);
  }
  return hits;
}

/**
 * 生成缺页补印 PDF。
 *
 * 复用拼版方案：按与 /api/impose 完全相同的选项重建完整拼版
 * （整册/分册签帖、定位标记），在方案中定位受损页码所在印张，
 * 再按原印张顺序从拼版输出中成对抽取正、背面组成补印 PDF。
 * 补印页为拼版输出页的逐页原样复制，印张尺寸与定位标记保持不变。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ maxSheetsPerSignature?: number, registrationMarks?: boolean,
 *           creepCompensation?: boolean, paperThicknessMm?: number|string }} [options]
 *        与 imposePdf 相同的拼版选项
 * @param {*} pagesInput 受损页码表达式（如 "2,5-7"）
 * @returns {Promise<{ pdfBytes: Uint8Array, reprint: object }>}
 *          reprint 为补印方案：pages（升序去重的受损页码）、sheetCount、
 *          pageCount、signatureMode、creep 与每张补印纸的帖号/帖内张号/
 *          命中页码/原输出页码/爬移单侧内移量
 */
async function reprintPdf(sourceBytes, options = {}, pagesInput) {
  // 先做词法校验（空输入/格式错误），避免无效输入仍执行完整拼版
  const specPages = parseReprintPagesSpec(pagesInput);

  // 复用拼版方案：与本次拼版相同的选项重建完整拼版输出
  const { pdfBytes, plan } = await imposePdf(sourceBytes, options);

  // 越界校验需要原稿页数（拼版方案中的 sourceCount）
  const pages = assertPagesInRange(specPages, plan.sourceCount);

  const sheets = buildReprintPlan(plan, pages);

  // 按原印张顺序成对抽取正、背面（输出页 1 基转 0 基索引）
  const imposedDoc = await PDFDocument.load(pdfBytes);
  const indices = [];
  for (const hit of sheets) {
    indices.push(hit.outputPages[0] - 1, hit.outputPages[1] - 1);
  }
  const outDoc = await PDFDocument.create();
  const copied = await outDoc.copyPages(imposedDoc, indices);
  for (const page of copied) outDoc.addPage(page);
  outDoc.setTitle(`缺页补印（${pages.length} 页受损 / ${sheets.length} 张纸）`);
  outDoc.setProducer('booklet-imposer (pdf-lib)');
  const reprintBytes = await outDoc.save();

  return {
    pdfBytes: reprintBytes,
    reprint: {
      schemaVersion: 1,
      kind: 'reprint-plan',
      tool: 'booklet-imposer',
      pages,
      sheetCount: sheets.length,
      pageCount: indices.length,
      signatureMode: Boolean(plan.signatureMode),
      creep: plan.creep || { enabled: false, paperThicknessMm: 0 },
      sheets,
    },
  };
}

module.exports = {
  ReprintInputError,
  parseReprintPagesSpec,
  parseReprintPages,
  buildReprintPlan,
  reprintPdf,
};
