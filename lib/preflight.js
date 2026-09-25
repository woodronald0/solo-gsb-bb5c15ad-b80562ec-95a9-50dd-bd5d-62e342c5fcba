'use strict';

/**
 * PDF 印前校验（preflight）。
 *
 * 独立于拼版流程：仅读取并逐页检查，不生成任何拼版文件。检查项：
 *   1. 页面尺寸：以多数页（主尺寸）为准，标出尺寸不一致的页面；
 *   2. 旋转角：/Rotate 90/270 为警告，180（上下颠倒）为错误；
 *   3. 透明度：透明图层组、非不透明 Alpha、软蒙版、非普通混合模式等；
 *   4. 可提取文字：页面是否含文本绘制操作，且所用字体具备 ToUnicode
 *      （或为标准 14 种基础字体）。
 * 另含文档级提示：页数不是 4 的倍数时，拼版需在末尾补空白页。
 *
 * 同一问题代码（code）且页码相邻的页面会合并为区段（segment），
 * 区段给出页码范围、逐页检测值、去重后的检测值摘要与修复建议。
 */

const zlib = require('zlib');
const {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
} = require('pdf-lib');
const { normalizeRotation, effectivePageSize } = require('./impose');

/** 尺寸一致判定容差（pt，约 0.35mm） */
const SIZE_TOLERANCE_PT = 1;
/** Form XObject 递归深度上限，防止异常 PDF 深层嵌套拖垮服务 */
const MAX_XOBJECT_DEPTH = 4;

const SEVERITY_LABELS = { error: '错误', warning: '警告', info: '提示' };
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * 问题代码元数据：严重级别 / 标题 / 修复建议。
 * 严重级别一旦发布即随 JSON 报告固定，前端按级别筛选与着色。
 */
const ISSUE_META = {
  size_mismatch: {
    severity: 'warning',
    title: '页面尺寸不一致',
    advice: '印刷前建议在源文档中把相关页统一到主尺寸（Acrobat：印刷制作 → '
      + '设置页面框；或重新排版导出），并核对出血与裁切位置。若有意保留混合尺寸，'
      + '请确认拼版后 1:1 居中留白的效果可接受。',
  },
  rotated_90_270: {
    severity: 'warning',
    title: '页面带 90°/270° 旋转角',
    advice: '如非有意横版，请在源文档中固化/移除页面旋转（Acrobat：组织页面 → '
      + '旋转摆正后重新导出，或印刷制作 → 设置页面框 → 移除旋转），避免印刷方向与预期不符。',
  },
  rotated_180: {
    severity: 'error',
    title: '页面带 180° 旋转（上下颠倒）',
    advice: '请在源文档中移除该页 /Rotate 并把内容摆正后重新导出 PDF（Acrobat：'
      + '组织页面 → 旋转，或印刷制作工具移除旋转），再重新校验。',
  },
  transparency: {
    severity: 'warning',
    title: '页面包含透明效果',
    advice: '部分印刷 RIP 不能正确处理 PDF 原生透明度，建议交付前拼合透明度'
      + '（Acrobat：印刷制作 → 拼合器预览），或导出 PDF/X-1a / PDF/X-4 后经 RIP 打样验证。',
  },
  no_extractable_text: {
    severity: 'info',
    title: '未检测到可提取文字',
    advice: '该页可能整页为扫描图片，或文字已转曲（ outlines ）。需要检索/校对文字时可做 '
      + 'OCR（Acrobat「识别文本」或 Tesseract）生成文字层；若已确认转曲用于印刷，可忽略。',
  },
  blank_padding: {
    severity: 'info',
    title: '页数不是 4 的倍数，拼版将补空白页',
    advice: '骑马钉每张纸固定容纳 4 页。若不希望拼版文件末尾出现空白页，'
      + '可调整内容页数至 4 的倍数，或在源文档末尾自行安排空白页/版权页。',
  },
};

// 标准 14 种基础字体（含常见前缀变体），无 ToUnicode 也可按标准编码提取
const STANDARD_FONT_PREFIXES = [
  'ArialMT', 'Helvetica', 'Times', 'Courier', 'Symbol', 'ZapfDingbats',
];

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const WHITESPACE_CHARS = new Set(['\x00', '\t', '\n', '\f', '\r', ' ']);
const DELIMITER_CHARS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

// ---------- 通用工具 ----------

function round1(value) {
  return Math.round(value * 10) / 10;
}

function ptToMm(pt) {
  return round1((pt * 25.4) / 72);
}

function formatSize(width, height) {
  return `${round1(width)} × ${round1(height)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`;
}

/** [3,4,5,7,8] -> "3～5、8"；单页 [3] -> "3" */
function formatPageList(pages) {
  const ranges = [];
  let start = null;
  let prev = null;
  const flush = () => {
    ranges.push(start === prev ? String(start) : `${start}～${prev}`);
  };
  for (const page of pages) {
    if (start === null) {
      start = page;
      prev = page;
    } else if (page === prev + 1) {
      prev = page;
    } else {
      flush();
      start = page;
      prev = page;
    }
  }
  if (start !== null) flush();
  return ranges.join('、');
}

function rangeLabel(issue) {
  if (issue.pageFrom === null || issue.pageTo === null) return '整篇文档';
  return issue.pageFrom === issue.pageTo
    ? `第 ${issue.pageFrom} 页`
    : `第 ${issue.pageFrom}～${issue.pageTo} 页`;
}

function lookup(context, object) {
  if (!object) return null;
  return object instanceof PDFRef ? context.lookup(object) : object;
}

function refKey(object) {
  if (object instanceof PDFRef) return `r${object.objectNumber}:${object.generationNumber}`;
  return null;
}

function pdfNameOf(object) {
  const value = object && typeof object.encodedName === 'string' ? object.encodedName : '';
  return value ? value.slice(1) : ''; // 去掉前导 '/'
}

function pdfText(value) {
  if (!value) return '';
  if (typeof value.encodedName === 'string') return value.encodedName.slice(1);
  if (typeof value.decodeText === 'function') {
    try { return value.decodeText(); } catch (_) { /* 忽略解码异常 */ }
  }
  return '';
}

// ---------- 内容流读取与词法扫描 ----------

/**
 * 解码 PDF 内容流。支持无过滤与 FlateDecode（含 PNG predictor）；
 * 遇到不支持的过滤器（ASCII85/LZW 等）返回 null，调用方按「无法判定」处理，
 * 避免把无法解析误报为「无文字」。
 *
 * @returns {string|null} latin1 文本；无法解码时为 null
 */
function decodeStream(stream, context) {
  let bytes;
  try {
    bytes = Buffer.from(stream.getContents());
  } catch (_) {
    return null;
  }

  const filterObj = stream.dict ? lookup(context, stream.dict.get(PDFName.of('Filter'))) : null;
  if (!filterObj) return bytes.toString('latin1');
  const filters = typeof filterObj.asArray === 'function' ? filterObj.asArray() : [filterObj];

  const parmsObj = stream.dict ? lookup(context, stream.dict.get(PDFName.of('DecodeParms'))) : null;
  const parmsArr = parmsObj
    ? (typeof parmsObj.asArray === 'function' ? parmsObj.asArray() : [parmsObj])
    : [];

  // 编码时过滤器按数组顺序施加，解码需逆序进行
  let data = bytes;
  for (let i = filters.length - 1; i >= 0; i -= 1) {
    const name = pdfNameOf(lookup(context, filters[i]));
    if (name !== 'FlateDecode' && name !== 'Fl') return null;
    let parms = parmsArr[i] || parmsArr[0] || null;
    parms = parms ? lookup(context, parms) : null;
    try {
      data = zlib.inflateSync(data);
    } catch (_) {
      return null;
    }
    const predictor = parms && parms.get(PDFName.of('Predictor'))
      ? numberValue(context, parms.get(PDFName.of('Predictor')))
      : 1;
    if (predictor >= 10 && predictor <= 15) {
      const columns = parms.get(PDFName.of('Columns'))
        ? numberValue(context, parms.get(PDFName.of('Columns')))
        : 1;
      const colors = parms.get(PDFName.of('Colors'))
        ? numberValue(context, parms.get(PDFName.of('Colors')))
        : 1;
      data = applyPngPredictor(data, columns, colors);
      if (!data) return null;
    }
  }
  return data.toString('latin1');
}

/** Paeth 预测函数（PNG 规范） */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解除 Flate 的 PNG（Tier 10+）行预测。每行首字节为滤波标记 0~4。
 */
function applyPngPredictor(data, columns, colors) {
  const rowLen = Math.max(1, columns * colors);
  const rowCount = Math.floor(data.length / (rowLen + 1));
  if (rowCount === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(rowCount * rowLen);
  let prev = Buffer.alloc(rowLen);
  let pos = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const tag = data[pos];
    pos += 1;
    const cur = data.subarray(pos, pos + rowLen);
    pos += rowLen;
    const recon = Buffer.alloc(rowLen);
    for (let i = 0; i < rowLen; i += 1) {
      const x = cur[i] || 0;
      const left = i >= colors ? recon[i - colors] : 0;
      const up = prev[i];
      const upLeft = i >= colors ? prev[i - colors] : 0;
      let value = x;
      if (tag === 1) value = x + left;
      else if (tag === 2) value = x + up;
      else if (tag === 3) value = x + Math.floor((left + up) / 2);
      else if (tag === 4) value = x + paeth(left, up, upLeft);
      recon[i] = value & 0xff;
    }
    recon.copy(out, row * rowLen);
    prev = recon;
  }
  return out;
}

/**
 * 跳过 (...) 字面字符串（支持嵌套与反斜杠转义），返回结束位置之后的下标。
 */
function skipLiteralString(content, start) {
  let depth = 0;
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') {
      i += 2; // 转义字符（含行连接）整体跳过
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return i + 1;
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * 扫描 PDF 内容流词法，收集：
 *   - textShowCount：BT/ET 文本对象内 Tj/TJ/'/" 的出现次数；
 *   - usedFonts：Tf 引用的字体资源名；
 *   - gsNames：gs 引用的 ExtGState 资源名；
 *   - doNames：Do 引用的 XObject 资源名。
 * 字符串与注释内的「伪操作符」不会被计入。
 */
function tokenizeContent(content) {
  const result = { textShowCount: 0, usedFonts: new Set(), gsNames: new Set(), doNames: new Set() };
  const n = content.length;
  let i = 0;
  let inText = false;
  // 记录最近遇到的名称对象；名称与其操作符之间可能隔着数值操作数（如 /F1 12 Tf），
  // 故操作数不能清空它，只有操作符消费后才清空。
  let pendingName = null;

  while (i < n) {
    const ch = content[i];

    if (WHITESPACE_CHARS.has(ch)) { i += 1; continue; }
    if (ch === '%') {
      while (i < n && content[i] !== '\n' && content[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      i = skipLiteralString(content, i);
      continue;
    }
    if (ch === '<') {
      if (content[i + 1] === '<') { i += 2; continue; }
      i += 1; // 十六进制字符串 <...>
      while (i < n && content[i] !== '>') i += 1;
      if (i < n) i += 1;
      continue;
    }
    if (ch === '>') { i += content[i + 1] === '>' ? 2 : 1; continue; }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { i += 1; continue; }
    if (ch === '/') {
      const start = i + 1;
      i = start;
      while (i < n && !WHITESPACE_CHARS.has(content[i]) && !DELIMITER_CHARS.has(content[i])) i += 1;
      // PDFName 使用 #xx 十六进制转义
      pendingName = content.slice(start, i).replace(/#([0-9a-fA-F]{2})/g,
        (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      continue;
    }

    const start = i;
    while (i < n && !WHITESPACE_CHARS.has(content[i]) && !DELIMITER_CHARS.has(content[i])) i += 1;
    const token = content.slice(start, i);

    if (token === 'BT') inText = true;
    else if (token === 'ET') inText = false;
    else if (token === 'Tf') {
      if (pendingName) result.usedFonts.add(pendingName);
      pendingName = null;
    } else if (token === 'gs') {
      if (pendingName) result.gsNames.add(pendingName);
      pendingName = null;
    } else if (token === 'Do') {
      if (pendingName) result.doNames.add(pendingName);
      pendingName = null;
    } else if (!WHITESPACE_CHARS.has(ch) && !isNumericToken(token)) {
      // 遇到其它操作符即结束待决名称；数值操作数不影响 pendingName
      pendingName = null;
    }
    if (inText && TEXT_SHOW_OPS.has(token)) result.textShowCount += 1;
  }
  return result;
}

function isNumericToken(token) {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(token);
}

/** 读取页面 Contents（可能为单流或流数组），拼接全部已解码内容；任一无法解码则返回 null */
function readPageContent(page, context) {
  const raw = page.node.get(PDFName.of('Contents'));
  if (!raw) return '';
  const container = lookup(context, raw);
  const refs = typeof container.asArray === 'function' ? container.asArray() : [raw];
  const parts = [];
  for (const ref of refs) {
    const stream = lookup(context, ref);
    if (!stream || typeof stream.getContents !== 'function') continue;
    const decoded = decodeStream(stream, context);
    if (decoded === null) return null;
    parts.push(decoded);
  }
  return parts.join('\n');
}

/** 沿页树向上继承 Resources */
function getInheritedResources(pageNode, context) {
  let node = pageNode;
  for (let hops = 0; hops < 100 && node; hops += 1) {
    const resources = node.get(PDFName.of('Resources'));
    const resolved = resources ? lookup(context, resources) : null;
    if (resolved) return resolved;
    const parent = node.get(PDFName.of('Parent'));
    node = parent ? lookup(context, parent) : null;
  }
  return null;
}

function getSubDict(container, context, key) {
  if (!container) return null;
  const value = container.get(PDFName.of(key));
  return value ? lookup(context, value) : null;
}

// ---------- 字体 / 可提取文字 ----------

function isStandardFont(baseFont) {
  return STANDARD_FONT_PREFIXES.some((prefix) => baseFont === prefix
    || baseFont.startsWith(`${prefix},`) || baseFont.startsWith(`${prefix}+`)
    || baseFont.startsWith(`${prefix}-`));
}

/**
 * 判断单个字体对象是否支持文本提取：有 ToUnicode 即为可提取；
 * 无 ToUnicode 时标准 14 基础字体按标准编码可提取；其余（嵌入但无 ToUnicode
 * 的子集字体等）视为不可提取。无法解析字体对象时返回 null（未知，不计问题）。
 */
function fontIsExtractable(fontRef, context) {
  const font = lookup(context, fontRef);
  if (!font || typeof font.get !== 'function') return null;
  if (font.get(PDFName.of('ToUnicode'))) return true;
  const baseFont = pdfText(lookup(context, font.get(PDFName.of('BaseFont'))));
  if (baseFont && isStandardFont(baseFont)) return true;

  // Type0 复合字体：检查 DescendantFonts 上是否带 ToUnicode
  const descendants = font.get(PDFName.of('DescendantFonts'));
  if (descendants) {
    const arr = lookup(context, descendants);
    const list = typeof arr.asArray === 'function' ? arr.asArray() : [];
    for (const descendantRef of list) {
      const descendant = lookup(context, descendantRef);
      if (descendant && descendant.get(PDFName.of('ToUnicode'))) return true;
      const descBase = pdfText(lookup(context, descendant.get(PDFName.of('BaseFont'))));
      if (descBase && isStandardFont(descBase)) return true;
    }
  }
  return false;
}

/**
 * @returns {true|false|null} true=可提取；false=不可提取；null=内容流无法判定
 */
function analyzeText(page, resources, content, context) {
  if (content === null) return null;
  const tokens = tokenizeContent(content);
  if (tokens.textShowCount === 0) return false;

  const fontDict = getSubDict(resources, context, 'Font');
  let extractable = 0;
  let unknown = 0;
  for (const fontName of tokens.usedFonts) {
    if (!fontDict) { unknown += 1; continue; }
    const fontRef = fontDict.get(PDFName.of(fontName));
    if (!fontRef) { unknown += 1; continue; }
    const status = fontIsExtractable(fontRef, context);
    if (status === true) extractable += 1;
    else if (status === null) unknown += 1;
  }
  if (extractable > 0) return true;
  if (unknown > 0 && tokens.usedFonts.size === extractable + unknown) return null;
  return false;
}

// ---------- 透明度 ----------

function numberValue(context, value) {
  const resolved = lookup(context, value);
  if (!resolved) return null;
  // 不同 pdf-lib 版本里 PDFNumber 的取值方式：优先 asNumber()，其次 value()
  if (typeof resolved.asNumber === 'function') {
    const num = resolved.asNumber();
    if (typeof num === 'number') return num;
  }
  if (resolved instanceof PDFNumber && typeof resolved.value === 'function') {
    const num = resolved.value();
    if (typeof num === 'number') return num;
  }
  if (typeof resolved.numberValue === 'number') return resolved.numberValue;
  return null;
}

/**
 * ExtGState 是否引入印刷不透明：非 1 的描边/填充 Alpha、软蒙版、
 * 非 Normal（且非仅 Compatible 兼容标记）的混合模式。
 */
function extGStateIsTransparent(gsRef, context) {
  const gs = lookup(context, gsRef);
  if (!gs || typeof gs.get !== 'function') return { transparent: false, sources: [] };
  const sources = [];

  for (const key of ['ca', 'CA']) {
    const alpha = numberValue(context, gs.get(PDFName.of(key)));
    if (alpha !== null && alpha < 1) {
      sources.push(`${key === 'ca' ? '填充' : '描边'}透明度 ${round1(alpha)}`);
    }
  }
  const sMask = gs.get(PDFName.of('SMask'));
  if (sMask && pdfNameOf(lookup(context, sMask)) !== 'None') {
    sources.push('SMask 软蒙版');
  }
  const bm = gs.get(PDFName.of('BM'));
  if (bm) {
    const bmObj = lookup(context, bm);
    const bmNames = typeof bmObj.asArray === 'function'
      ? bmObj.asArray().map((v) => pdfNameOf(lookup(context, v)))
      : [pdfNameOf(bmObj)];
    const effective = bmNames.filter((name) => name && name !== 'Compatible');
    if (effective.some((name) => name !== 'Normal')) {
      sources.push(`混合模式 ${effective.join('/')}`);
    }
  }
  return { transparent: sources.length > 0, sources };
}

/**
 * 递归判断一个内容流（页面或 Form XObject）是否使用透明度。
 * 只统计内容流中实际 gs / Do 引用到的资源，未使用的资源不误报。
 */
function streamUsesTransparency(content, resources, context, visited, depth) {
  const sources = [];
  if (!content || depth > MAX_XOBJECT_DEPTH) return sources;
  const tokens = tokenizeContent(content);

  const extDict = getSubDict(resources, context, 'ExtGState');
  if (extDict) {
    for (const gsName of tokens.gsNames) {
      const gsRef = extDict.get(PDFName.of(gsName));
      if (!gsRef) continue;
      const key = refKey(gsRef) || `gs:${gsName}:${depth}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const result = extGStateIsTransparent(gsRef, context);
      if (result.transparent) sources.push(...result.sources);
    }
  }

  const xobjDict = getSubDict(resources, context, 'XObject');
  if (xobjDict) {
    for (const xobjName of tokens.doNames) {
      const xobjRef = xobjDict.get(PDFName.of(xobjName));
      if (!xobjRef) continue;
      const key = refKey(xobjRef);
      if (key && visited.has(key)) continue;
      if (key) visited.add(key);
      const xobj = lookup(context, xobjRef);
      if (!xobj || typeof xobj.get !== 'function') continue;
      const subtype = pdfNameOf(lookup(context, xobj.get(PDFName.of('Subtype'))));

      if (xobj.get(PDFName.of('SMask'))) {
        sources.push('带软蒙版的图片');
      }
      if (subtype === 'Form') {
        const group = lookup(context, xobj.get(PDFName.of('Group')));
        if (group && pdfNameOf(lookup(context, group.get(PDFName.of('S')))) === 'Transparency') {
          sources.push('透明图层组（Form XObject）');
        }
        const formContent = decodeStream(xobj, context);
        const formResources = getSubDict(xobj, context, 'Resources') || resources;
        if (formContent) {
          sources.push(...streamUsesTransparency(
            formContent, formResources, context, visited, depth + 1,
          ));
        }
      }
    }
  }
  return sources;
}

function analyzeTransparency(page, resources, content, context) {
  // 页面级 /Group S /Transparency
  const group = lookup(context, page.node.get(PDFName.of('Group')));
  const sources = [];
  if (group && pdfNameOf(lookup(context, group.get(PDFName.of('S')))) === 'Transparency') {
    sources.push('页面透明图层组');
  }
  if (content) {
    sources.push(...streamUsesTransparency(
      content, resources, context, new Set(), 0,
    ));
  }
  return { transparent: sources.length > 0, sources: [...new Set(sources)] };
}

// ---------- 尺寸聚类 ----------

/**
 * 以有效（旋转后）宽高做容差聚类，成员最多的簇为主尺寸；
 * 同票时取首页所属簇，保证结果稳定可预期。
 */
function findReferenceSize(pageSizes) {
  const clusters = []; // { width, height, count, firstPage }
  for (const size of pageSizes) {
    // 以物理介质（MediaBox）宽高聚类：同尺寸纸张即使 /Rotate 方向不同也归为一簇
    const cluster = clusters.find(
      (c) => Math.abs(c.width - size.mediaWidth) <= SIZE_TOLERANCE_PT
        && Math.abs(c.height - size.mediaHeight) <= SIZE_TOLERANCE_PT,
    );
    if (cluster) {
      cluster.count += 1;
      // 簇中心以首个成员尺寸为准，保持稳定
    } else {
      clusters.push({
        width: size.mediaWidth,
        height: size.mediaHeight,
        count: 1,
        firstPage: size.page,
      });
    }
  }
  clusters.sort((a, b) => (b.count - a.count) || a.firstPage - b.firstPage);
  return clusters[0];
}

// ---------- 区段合并 ----------

/**
 * 把逐页问题实例按 code 分组，相邻页（页码差 1）合并为区段。
 * instances: Array<{ page:number, detail:string, extra?:object }>
 */
function mergeSegments(instancesByCode) {
  const segments = [];
  for (const code of Object.keys(instancesByCode)) {
    const list = instancesByCode[code].slice().sort((a, b) => a.page - b.page);
    let current = null;
    for (const instance of list) {
      if (current && instance.page === current.pageTo + 1) {
        current.pageTo = instance.page;
        current.pageCount += 1;
        current.pages.push(instance.page);
        current.detected.push(instance);
      } else {
        if (current) segments.push(current);
        current = {
          code,
          pageFrom: instance.page,
          pageTo: instance.page,
          pageCount: 1,
          pages: [instance.page],
          detected: [instance],
        };
      }
    }
    if (current) segments.push(current);
  }
  return segments;
}

/** 逐页 detail 去重汇总："300 × 400 pt（第 3、5 页）" */
function summarizeDetected(detected) {
  const groups = new Map();
  for (const item of detected) {
    if (!groups.has(item.detail)) groups.set(item.detail, []);
    groups.get(item.detail).push(item.page);
  }
  return [...groups.entries()]
    .map(([detail, pages]) => `${detail}（第 ${formatPageList(pages)} 页）`)
    .join('；');
}

// ---------- 主入口 ----------

/**
 * 对 PDF 字节执行印前校验，返回结构化报告（不生成拼版文件）。
 *
 * @param {Buffer|Uint8Array} sourceBytes
 * @param {{ fileName?: string }} [meta]
 * @returns {Promise<object>} 报告对象（可直接 JSON 序列化下载）
 */
async function preflightPdf(sourceBytes, meta = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    doc.getPageCount();
  } catch (err) {
    // pdf-lib 对加密文档抛出的错误信息含 "encrypted"；统一包装并附加
    // errCode，便于调用方（如批量校验）区分加密与损坏。
    const encrypted = err && /encrypt/i.test(err.message || '');
    const wrapped = new Error('文件不是有效的 PDF（可能已损坏或被加密），无法进行印前校验');
    wrapped.errCode = encrypted ? 'encrypted_pdf' : 'invalid_pdf';
    throw wrapped;
  }

  const pdfPages = doc.getPages();
  const pageCount = pdfPages.length;
  if (pageCount === 0) {
    const err = new Error('PDF 不包含任何页面，无法进行印前校验');
    err.errCode = 'empty_document';
    throw err;
  }
  const context = doc.context;

  // 逐页采集原始指标
  const pageRecords = [];
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdfPages[index];
    const pageNo = index + 1;
    const rotation = normalizeRotation(page.getRotation().angle);
    const mediaWidth = page.getWidth();
    const mediaHeight = page.getHeight();
    const effective = effectivePageSize(page);
    const resources = getInheritedResources(page.node, context);
    const content = readPageContent(page, context);

    const textExtractable = analyzeText(page, resources, content, context);
    const transparency = analyzeTransparency(page, resources, content, context);

    pageRecords.push({
      page: pageNo,
      mediaWidth: round1(mediaWidth),
      mediaHeight: round1(mediaHeight),
      effectiveWidth: round1(effective.width),
      effectiveHeight: round1(effective.height),
      widthMm: ptToMm(mediaWidth),
      heightMm: ptToMm(mediaHeight),
      rotation,
      textExtractable, // true / false / null(无法判定)
      transparent: transparency.transparent,
      transparencySources: transparency.sources,
    });
  }

  const reference = findReferenceSize(pageRecords);
  const instances = {};
  const pushInstance = (code, instance) => {
    if (!instances[code]) instances[code] = [];
    instances[code].push(instance);
  };

  for (const record of pageRecords) {
    // 1. 尺寸：按物理介质（MediaBox）与主尺寸比较；旋转方向不同不算尺寸不一致
    //    （90° 旋转的 A4 仍是 A4），方向问题由旋转检查单独报告。
    const sizeMismatch = Math.abs(record.mediaWidth - reference.width) > SIZE_TOLERANCE_PT
      || Math.abs(record.mediaHeight - reference.height) > SIZE_TOLERANCE_PT;
    if (sizeMismatch) {
      pushInstance('size_mismatch', {
        page: record.page,
        detail: formatSize(record.mediaWidth, record.mediaHeight),
      });
    }

    // 2. 旋转角（180 为错误；90/270 为警告）
    if (record.rotation === 180) {
      pushInstance('rotated_180', { page: record.page, detail: `${record.rotation}°` });
    } else if (record.rotation === 90 || record.rotation === 270) {
      pushInstance('rotated_90_270', { page: record.page, detail: `${record.rotation}°` });
    }

    // 3. 透明度
    if (record.transparent) {
      pushInstance('transparency', {
        page: record.page,
        detail: record.transparencySources.join('、'),
      });
    }

    // 4. 可提取文字（无法判定的页面跳过，避免误报）
    if (record.textExtractable === false) {
      pushInstance('no_extractable_text', { page: record.page, detail: '文本绘制操作 0 次' });
    }
  }

  const segments = mergeSegments(instances);

  const issues = segments.map((segment) => buildIssue(segment, reference, pageCount));

  // 文档级提示：骑马钉以 4 页为单位，末尾需补白
  const blanks = (4 - (pageCount % 4)) % 4;
  if (blanks > 0) {
    const code = 'blank_padding';
    const metaInfo = ISSUE_META[code];
    issues.push({
      code,
      severity: metaInfo.severity,
      title: metaInfo.title,
      pageFrom: null,
      pageTo: null,
      pageCount: null,
      pages: [],
      message: `文档共 ${pageCount} 页，不是 4 的倍数；骑马钉拼版时将在末尾补 ${blanks} 个空白页`
        + `（补至 ${pageCount + blanks} 页）。`,
      values: [
        { label: '原始页数', value: `${pageCount} 页` },
        { label: '末尾补白', value: `${blanks} 页（补至 ${pageCount + blanks} 页）` },
      ],
      detected: [],
      advice: metaInfo.advice,
    });
  }

  issues.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) return rankDiff;
    const ap = a.pageFrom === null ? Number.POSITIVE_INFINITY : a.pageFrom;
    const bp = b.pageFrom === null ? Number.POSITIVE_INFINITY : b.pageFrom;
    if (ap !== bp) return ap - bp;
    return a.code.localeCompare(b.code);
  });

  const summary = {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    issuesTotal: issues.length,
    pagesWithIssues: new Set(issues.flatMap((i) => i.pages)).size,
    passed: !issues.some((i) => i.severity === 'error'),
  };

  return {
    schemaVersion: 1,
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    file: {
      name: meta.fileName || null,
      sizeBytes: meta.sizeBytes || null,
    },
    pageCount,
    referenceSize: {
      width: round1(reference.width),
      height: round1(reference.height),
      widthMm: ptToMm(reference.width),
      heightMm: ptToMm(reference.height),
      pageCount: reference.count,
    },
    summary,
    issues,
    pages: pageRecords.map((record) => ({
      page: record.page,
      mediaWidth: record.mediaWidth,
      mediaHeight: record.mediaHeight,
      effectiveWidth: record.effectiveWidth,
      effectiveHeight: record.effectiveHeight,
      widthMm: record.widthMm,
      heightMm: record.heightMm,
      rotation: record.rotation,
      transparent: record.transparent,
      textExtractable: record.textExtractable,
      issues: issues
        .filter((issue) => issue.pages.includes(record.page))
        .map((issue) => ({ code: issue.code, severity: issue.severity, title: issue.title })),
    })),
  };
}

/**
 * 根据区段构造完整问题对象：消息文案、检测值摘要、修复建议。
 */
function buildIssue(segment, reference, pageCount) {
  const meta = ISSUE_META[segment.code];
  const range = rangeLabel(segment);
  const issue = {
    code: segment.code,
    severity: meta.severity,
    title: meta.title,
    pageFrom: segment.pageFrom,
    pageTo: segment.pageTo,
    pageCount: segment.pageCount,
    pages: segment.pages,
    values: [],
    // 逐页检测值（page 为页码，detail 为该页检测到的可读值），JSON 可直接阅读
    detected: segment.detected.map((d) => ({ ...d })),
    advice: meta.advice,
    message: '',
  };

  switch (segment.code) {
    case 'size_mismatch': {
      const mainSize = formatSize(reference.width, reference.height);
      issue.message = `${range}共 ${segment.pageCount} 页与文档主尺寸（${mainSize}，`
        + `${reference.count}/${pageCount} 页使用）不一致；拼版会按主面板 1:1 居中并在周围留白。`;
      issue.values = [
        { label: '主尺寸', value: `${mainSize}（${reference.count} 页）` },
        { label: '检测到的异常尺寸', value: summarizeDetected(segment.detected) },
      ];
      break;
    }
    case 'rotated_90_270':
      issue.message = `${range}带 /Rotate 页面旋转（共 ${segment.pageCount} 页），`
        + '阅读器中呈横向显示；拼版将按旋转后的显示方向放入面板。';
      issue.values = [{ label: '旋转角', value: summarizeDetected(segment.detected) }];
      break;
    case 'rotated_180':
      issue.message = `${range}带 180° 旋转（共 ${segment.pageCount} 页），内容上下颠倒，拼版后仍为颠倒状态。`;
      issue.values = [{ label: '旋转角', value: summarizeDetected(segment.detected) }];
      break;
    case 'transparency':
      issue.message = `${range}包含 PDF 原生透明/混合效果（共 ${segment.pageCount} 页），`
        + '部分印刷 RIP 可能拼合出非预期结果。';
      issue.values = [{ label: '透明来源', value: summarizeDetected(segment.detected) }];
      break;
    case 'no_extractable_text':
      issue.message = `${range}未检测到可提取的文本（共 ${segment.pageCount} 页），`
        + '可能是扫描图片页或文字已转曲。';
      issue.values = [
        { label: '文本绘制操作', value: '0 次' },
        { label: '检测到的页面情况', value: summarizeDetected(segment.detected) },
      ];
      break;
    default:
      issue.message = `${range}存在 ${meta.title} 问题（${segment.pageCount} 页）。`;
  }
  return issue;
}

module.exports = {
  ISSUE_META,
  SEVERITY_LABELS,
  SIZE_TOLERANCE_PT,
  preflightPdf,
  // 导出纯函数以便单测
  normalizeRotation,
  tokenizeContent,
  decodeStream,
  applyPngPredictor,
  findReferenceSize,
  mergeSegments,
  formatPageList,
  formatSize,
  ptToMm,
  skipLiteralString,
};
