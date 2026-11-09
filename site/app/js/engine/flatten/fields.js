// A form's fields, their values, and drawing their appearances again: text fields, drop-down and
// list boxes as PDFBox's AppearanceGeneratorHelper draws them (the app's engine), check boxes and
// radio buttons by setting which of their looks shows, and drawing one when they have none.
import {
  N, get, getDict, getArray, getName, getNum, getText, resolve, rectOf, textOf, textOrStream,
  streamData, latin1, fmt, copyDict, nameOf, num, PDFDict, PDFArray, PDFStream, PDFName,
} from './cos.js';
import { parseDA, markedContent } from './content.js';
import { formFont, acrobatFont, CannotDraw } from './fonts.js';

// Field flags (PDF 32000-1, tables 226, 228, 230).
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_FILE_SELECT = 1 << 20;
const FF_COMB = 1 << 24;
const FF_RADIO = 1 << 15;
const FF_PUSH_BUTTON = 1 << 16;
const FF_COMBO = 1 << 17;

const FONTSCALE = 1000;
const MINIMUM_FONT_SIZE = 4;
const DEFAULT_FONT_SIZE = 12;
const HIGHLIGHT_COLOR = [153 / 255, 193 / 255, 215 / 255];
const MAX_DEPTH = 64;

// Line and paragraph separators, made in code so that no editor turns them into line breaks.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const PARAGRAPHS = new RegExp(`\\r\\n|\\n|\\r|${LS}|${PS}`);
const NEWLINES = new RegExp(`\\r\\n|[\\n\\v\\f\\r\\x85${LS}${PS}]`, 'g');

/**
 * The form's fields as a tree: { all, terminals, ownerOf } where all lists every field (terminal or
 * not, parents before children), terminals those with widgets, and ownerOf maps a widget's
 * dictionary to its field. A field is a node { dict, parent, terminal, children, widgets, type }
 * with type 'text', 'checkbox', 'radio', 'push', 'combo', 'list', 'signature' or '' (unknown).
 */
export function fieldTree(ctx, acroForm) {
  const all = [];
  const terminals = [];
  const ownerOf = new Map();
  const seen = new Set();
  const fields = acroForm ? getArray(ctx, acroForm, 'Fields') : undefined;
  const visit = (item, parent, depth) => {
    const dict = resolve(ctx, item);
    if (!(dict instanceof PDFDict) || seen.has(dict) || depth > MAX_DEPTH) return;
    seen.add(dict);
    const kids = getArray(ctx, dict, 'Kids');
    const kidDicts = [];
    if (kids) for (let i = 0; i < kids.size(); i++) {
      const kid = resolve(ctx, kids.get(i));
      if (kid instanceof PDFDict && kid !== dict) kidDicts.push(kid);
    }
    // As PDFBox reads forms: a field with a kid that has a name (/T) holds fields, otherwise widgets.
    const terminal = !kidDicts.some((kid) => kid.has(N('T')));
    const node = { dict, parent, terminal, children: [], widgets: [], type: '' };
    all.push(node);
    if (parent) parent.children.push(node);
    if (terminal) {
      node.widgets = kids ? kidDicts : [dict];
      node.type = fieldType(ctx, dict, acroForm);
      terminals.push(node);
      for (const widget of node.widgets) if (!ownerOf.has(widget)) ownerOf.set(widget, node);
    } else {
      for (const kid of kidDicts) visit(kid, node, depth + 1);
    }
  };
  if (fields) for (let i = 0; i < fields.size(); i++) visit(fields.get(i), null, 0);
  return { all, terminals, ownerOf };
}

/** An attribute a field inherits from its parents, then from the form (as PDFBox looks it up). */
export function inherited(ctx, dict, key, acroForm) {
  let d = dict;
  for (let depth = 0; d instanceof PDFDict && depth <= MAX_DEPTH; depth++) {
    const raw = d.get(N(key));
    if (raw !== undefined) return resolve(ctx, raw);
    d = resolve(ctx, d.get(N('Parent')));
  }
  return acroForm ? get(ctx, acroForm, key) : undefined;
}

function fieldType(ctx, dict, acroForm) {
  const ft = nameOf(inherited(ctx, dict, 'FT', acroForm));
  const ff = num(inherited(ctx, dict, 'Ff', acroForm), 0);
  if (ft === 'Tx') return 'text';
  if (ft === 'Btn') return ff & FF_PUSH_BUTTON ? 'push' : ff & FF_RADIO ? 'radio' : 'checkbox';
  if (ft === 'Ch') return ff & FF_COMBO ? 'combo' : 'list';
  if (ft === 'Sig') return 'signature';
  return '';
}

function flags(ctx, node, acroForm) {
  return num(inherited(ctx, node.dict, 'Ff', acroForm), 0);
}

/** A text field's value (empty when it has none). */
export function textValue(ctx, node, acroForm) {
  return textOrStream(ctx, inherited(ctx, node.dict, 'V', acroForm)) ?? '';
}

/** A choice field's values (one for a drop-down list, any number for a list box). */
export function choiceValues(ctx, node, acroForm) {
  const v = inherited(ctx, node.dict, 'V', acroForm);
  if (v instanceof PDFArray) {
    const out = [];
    for (let i = 0; i < v.size(); i++) {
      const t = textOf(resolve(ctx, v.get(i)));
      if (t !== undefined) out.push(t);
    }
    return out;
  }
  const t = textOf(v);
  return t === undefined ? [] : [t];
}

/** Whether a text or choice field has a value, which would be lost if it were drawn blank. */
export function hasValue(ctx, node, acroForm) {
  if (node.type === 'text') return textValue(ctx, node, acroForm) !== '';
  if (node.type === 'combo' || node.type === 'list') return choiceValues(ctx, node, acroForm).length > 0;
  return false;
}

/** A choice field's options: [{ value, text }] (its export value and the text it shows). */
function options(ctx, node, acroForm) {
  const opt = inherited(ctx, node.dict, 'Opt', acroForm);
  const out = [];
  if (!(opt instanceof PDFArray)) return out;
  for (let i = 0; i < opt.size(); i++) {
    const item = resolve(ctx, opt.get(i));
    if (item instanceof PDFArray) {
      const value = textOf(resolve(ctx, item.get(0)));
      const text = item.size() > 1 ? textOf(resolve(ctx, item.get(1))) : undefined;
      out.push({ value, text: text ?? value ?? '', pair: true, hasText: text !== undefined });
    } else {
      const t = textOf(item);
      out.push({ value: t, text: t ?? '', pair: false, hasText: true });
    }
  }
  return out;
}

/**
 * The text a choice field shows for its value `value`: the text its choices pair with it (/Opt),
 * or itself. Each choice is read as a whole (see the app's Flattening.shownChoice).
 */
export function shownChoice(ctx, node, value, acroForm) {
  for (const choice of options(ctx, node, acroForm)) {
    if (!choice.pair) {
      if (choice.value === value) return value;
    } else if (choice.value === value) {
      return choice.hasText ? choice.text : value;
    }
  }
  return value;
}

/** A widget's normal appearance: { stream, raw } (raw as kept in the PDF), or undefined. */
export function normalAppearance(ctx, widget) {
  const ap = getDict(ctx, widget, 'AP');
  if (!ap) return undefined;
  const raw = ap.get(N('N'));
  const n = resolve(ctx, raw);
  if (n instanceof PDFStream) return { stream: n, raw };
  if (n instanceof PDFDict) {
    // A look per state (check boxes): the one /AS names.
    const state = getName(ctx, widget, 'AS');
    if (state === undefined) return undefined;
    const stateRaw = n.get(N(state));
    const s = resolve(ctx, stateRaw);
    if (s instanceof PDFStream) return { stream: s, raw: stateRaw };
  }
  return undefined;
}

/** Whether an appearance has a box with an area, so it can be drawn. */
export function drawable(ctx, appearance) {
  const box = appearance && rectOf(ctx, get(ctx, appearance.stream, 'BBox'));
  return !!box && box[2] - box[0] > 0 && box[3] - box[1] > 0;
}

/** Whether an annotation is seen: not hidden and not meant for printing only (flags 2 and 32). */
export function shown(ctx, annotation) {
  const f = getNum(ctx, annotation, 'F', 0);
  return (f & 2) === 0 && (f & 32) === 0;
}

// --- Drawing ---------------------------------------------------------------------------------

function pdfName(name) {
  return '/' + name.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function colorOps(ctx, array, stroking) {
  const c = resolve(ctx, array);
  if (!(c instanceof PDFArray)) return null;
  const v = [];
  for (let i = 0; i < c.size(); i++) v.push(num(resolve(ctx, c.get(i)), 0));
  if (v.length === 1) return `${fmt(v[0])} ${stroking ? 'G' : 'g'}`;
  if (v.length === 3) return `${v.map(fmt).join(' ')} ${stroking ? 'RG' : 'rg'}`;
  if (v.length === 4) return `${v.map(fmt).join(' ')} ${stroking ? 'K' : 'k'}`;
  return null;
}

function pad(box, by) {
  return [box[0] + by, box[1] + by, box[2] - by, box[3] - by];
}

const width = (box) => box[2] - box[0];
const height = (box) => box[3] - box[1];
const re = (box) => `${fmt(box[0])} ${fmt(box[1])} ${fmt(width(box))} ${fmt(height(box))} re`;

/** The width of a widget's border: its /BS /W (1 when /BS has none), or 0 without /BS. */
function borderWidth(ctx, widget) {
  const bs = getDict(ctx, widget, 'BS');
  if (!bs) return 0;
  return getNum(ctx, bs, 'W', 1);
}

/** Background and border from the widget's /MK, as PDFBox's initializeAppearanceContent draws them. */
function backgroundAndBorder(ctx, widget, mk, bbox) {
  const ops = [];
  if (!mk) return ops;
  const bg = colorOps(ctx, get(ctx, mk, 'BG'), false);
  if (bg) ops.push(bg, `${re(bbox)} f`);
  const bc = colorOps(ctx, get(ctx, mk, 'BC'), true);
  let lineWidth = bc ? 1 : 0;
  const bs = borderWidth(ctx, widget);
  if (getDict(ctx, widget, 'BS') && bs > 0) lineWidth = bs;
  if (lineWidth > 0 && bc) {
    ops.push(bc);
    if (lineWidth !== 1) ops.push(`${fmt(lineWidth)} w`);
    ops.push(`${re(pad(bbox, Math.max(0.5, lineWidth / 2)))} s`);
  }
  return ops;
}

/** How far /MK /R turns the widget's content: 0, 90, 180 or 270. */
function rotationOf(ctx, mk) {
  if (!mk) return 0;
  const r = ((Math.round(getNum(ctx, mk, 'R', 0) / 90) * 90) % 360 + 360) % 360;
  return r;
}

/** The box and matrix of a new appearance for a widget `w` by `h` turned `rotation` degrees. */
function newBox(rect, rotation) {
  const w = width(rect);
  const h = height(rect);
  const turned = rotation === 90 || rotation === 270;
  const bbox = [0, 0, turned ? h : w, turned ? w : h];
  const matrix = {
    0: null,
    90: [0, 1, -1, 0, bbox[3], 0],
    180: [-1, 0, 0, -1, bbox[2], bbox[3]],
    270: [0, -1, 1, 0, 0, bbox[2]],
  }[rotation];
  return { bbox, matrix };
}

/** Where a field's font is: the form's resources, the widget's own look, or a standard font. */
function fontResource(env, name, widget) {
  const { ctx } = env;
  const fromDr = env.drFonts?.get(N(name));
  if (fromDr !== undefined && resolve(ctx, fromDr) instanceof PDFDict) return { raw: fromDr, dict: resolve(ctx, fromDr) };
  // As Acrobat (and PDFBox) do, a font the widget's appearance has counts as the form's.
  const ap = getDict(ctx, widget, 'AP');
  const n = ap && get(ctx, ap, 'N');
  const looks = n instanceof PDFStream ? [n] : n instanceof PDFDict ? [...n.entries()].map(([, v]) => resolve(ctx, v)) : [];
  for (const look of looks) {
    if (!(look instanceof PDFStream)) continue;
    const fonts = getDict(ctx, getDict(ctx, look, 'Resources'), 'Font');
    const raw = fonts?.get(N(name));
    if (raw !== undefined && resolve(ctx, raw) instanceof PDFDict) return { raw, dict: resolve(ctx, raw) };
  }
  // Acrobat's names for the standard fonts (/Helv, /ZaDb) work without being defined.
  const standard = acrobatFont(name);
  if (standard) {
    const raw = env.standardFont(standard);
    return { raw, dict: resolve(ctx, raw) };
  }
  throw new CannotDraw(`Could not find font: /${name}`);
}

/** Lines of `paragraph` that fit `maxWidth` at `size`, as PDFBox's PlainText breaks them. */
function wrap(font, paragraph, size, maxWidth) {
  const scale = size / FONTSCALE;
  const measure = (s) => font.encode(s).width * scale;
  const segments = paragraph.match(/\S+\s*|\s+/g) ?? [''];
  const lines = [];
  let line = [];
  let lineWidth = 0;
  const lineText = () => line.join('');
  const push = () => {
    lines.push(lineText());
    line = [];
    lineWidth = 0;
  };
  for (let segment of segments) {
    let w = measure(segment);
    // A word wider than the field is broken where it has to be.
    const bare = segment.replace(/\s+$/, '');
    if (bare && measure(bare) > maxWidth) {
      if (line.length) push();
      let part = '';
      for (const ch of bare) {
        if (part && measure(part + ch) > maxWidth) {
          lines.push(part);
          part = '';
        }
        part += ch;
      }
      segment = part + segment.slice(bare.length);
      w = measure(segment);
    }
    lineWidth += w;
    if (lineWidth >= maxWidth && /\s$/.test(segment)) lineWidth -= measure(segment.slice(-1));
    if (lineWidth >= maxWidth && line.length) {
      push();
      lineWidth = w;
    }
    line.push(segment);
  }
  lines.push(lineText());
  return lines;
}

/** The width of a line as PDFBox counts it: without the space it ends with. */
function lineWidthOf(font, text, size) {
  return font.encode(text.replace(/\s$/, '')).width * size / FONTSCALE;
}

/**
 * The content that draws a text or choice field's value (PDFBox's insertGeneratedAppearance).
 * `f` = { kind, value, font, fontRes, da, bbox, widget, multiline, comb, maxLen, q, list }
 */
function generatedContent(env, f) {
  const { ctx } = env;
  const { font, da, bbox, widget } = f;
  const bw = borderWidth(ctx, widget);
  const clipRect = pad(bbox, Math.max(1, bw));
  const contentRect = pad(clipRect, Math.max(1, bw));
  const m = font.metrics;
  let size = da.size;
  if (size === 0) size = autoFontSize(f, contentRect);
  const ops = ['q', `${re(clipRect)} W n`];
  if (f.list) ops.push(...listHighlights(f, size));
  ops.push('BT', `${pdfName(da.font)} ${fmt(size)} Tf`);
  if (da.color) ops.push(`${da.color.args.map(fmt).join(' ')} ${da.color.op}`);
  const scaleY = size / FONTSCALE;
  const leading = m.bboxHeight * scaleY;
  const cap = m.capHeight * scaleY;
  const descent = m.descent * scaleY;
  let y;
  if (f.multiline) {
    y = contentRect[3] - leading;
  } else if (cap > height(clipRect)) {
    // Text taller than the field shows from its bottom, as Acrobat does.
    y = clipRect[1] - descent;
  } else {
    y = clipRect[1] + (height(clipRect) - cap) / 2;
    if (y - clipRect[1] < -descent) {
      const descentBased = -descent + contentRect[1];
      const capBased = height(contentRect) - contentRect[1] - cap;
      y = Math.min(descentBased, Math.max(y, capBased));
    }
  }
  const x = contentRect[0];
  const show = (tx, ty, text) => {
    if (!text) return;
    const encoded = font.encode(text);
    ops.push(`1 0 0 1 ${fmt(tx)} ${fmt(ty)} Tm`, encoded.draw ? encoded.draw(size) : `<${encoded.hex}> Tj`);
  };
  if (f.comb) {
    // One character per cell, each in the middle of its cell.
    const chars = [...f.value].slice(0, f.maxLen);
    const cell = width(bbox) / f.maxLen;
    const baseline = pad(bbox, 1)[1] + (height(bbox) - m.ascent / FONTSCALE * size) / 2;
    chars.forEach((ch, i) => {
      const w = font.encode(ch).width * size / FONTSCALE;
      show(bbox[0] + cell * i + (cell - w) / 2, baseline, ch);
    });
  } else if (f.list) {
    const opts = f.list.options;
    let ty = contentRect[3];
    for (let i = f.list.top; i < opts.length; i++) {
      ty -= (i === f.list.top ? m.ascent : m.bboxHeight) / FONTSCALE * size;
      let tx = contentRect[0];
      const text = opts[i].text;
      if (f.q === 1 || f.q === 2) {
        const adjust = width(bbox) - font.encode(text).width / FONTSCALE * size - 4;
        tx += f.q === 1 ? adjust / 2 : adjust;
      }
      show(tx, ty, text);
      if (ty < bbox[1] - leading) break;
    }
  } else {
    const paragraphs = f.value.replace(/\t/g, ' ').split(PARAGRAPHS);
    const lines = f.multiline
      ? paragraphs.flatMap((p) => wrap(font, p, size, width(contentRect)))
      : [paragraphs.join(' ')];
    lines.forEach((line, i) => {
      const w = f.multiline ? lineWidthOf(font, line, size) : font.encode(line).width * size / FONTSCALE;
      let offset = 0;
      if (w < width(contentRect) || f.multiline) {
        if (f.q === 1) offset = (width(contentRect) - w) / 2;
        else if (f.q === 2) offset = width(contentRect) - w;
      }
      show(x + offset, y - leading * i, line);
    });
  }
  ops.push('ET', 'Q');
  return ops.join('\n') + '\n';
}

/** PDFBox's calculateFontSize, for a field whose /DA asks for "as big as fits" (size 0). */
function autoFontSize(f, contentRect) {
  const { font } = f;
  const m = font.metrics;
  if (f.list) return DEFAULT_FONT_SIZE;
  if (f.multiline) {
    const paragraphs = f.value.replace(/\t/g, ' ').split(PARAGRAPHS);
    const room = width(contentRect) - contentRect[0];
    for (let fs = MINIMUM_FONT_SIZE; fs <= DEFAULT_FONT_SIZE; fs++) {
      const lines = paragraphs.reduce((n, p) => n + wrap(font, p, fs, room).length, 0);
      if (m.bboxHeight * fs / FONTSCALE * lines > height(contentRect)) return Math.max(fs - 1, MINIMUM_FONT_SIZE);
    }
    return DEFAULT_FONT_SIZE;
  }
  const textWidth = font.encode(f.value).width / FONTSCALE;
  const widthBased = textWidth > 0 ? width(contentRect) / textWidth : Infinity;
  let textHeight = (m.capHeight - m.descent) / FONTSCALE;
  if (textHeight <= 0) textHeight = m.bboxHeight / FONTSCALE;
  const heightBased = height(contentRect) / textHeight;
  const size = Math.min(widthBased, heightBased);
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE;
}

function listHighlights(f, size) {
  const { list, font } = f;
  const ops = [];
  const boxHeight = font.metrics.bboxHeight * size / FONTSCALE;
  const edge = pad(f.bbox, 1);
  for (const index of list.selected) {
    if (index < list.top) continue;
    ops.push(`${HIGHLIGHT_COLOR.map(fmt).join(' ')} rg`,
      `${fmt(edge[0])} ${fmt(edge[3] - boxHeight * (index - list.top + 1) + 2)} ${fmt(width(edge))} ${fmt(boxHeight)} re f`);
  }
  if (ops.length) ops.push('0 g');
  return ops;
}

/** Resources for a new appearance: those it had, with the field's font added. */
function resourcesWith(env, existing, fontName, fontRaw) {
  const { ctx } = env;
  const resources = copyDict(ctx, existing);
  const fonts = copyDict(ctx, getDict(ctx, resources, 'Font'));
  if (!fonts.has(N(fontName))) fonts.set(N(fontName), fontRaw);
  resources.set(N('Font'), fonts);
  return resources;
}

/** A new appearance stream: { raw } registered in the document, ready to set as /AP /N. */
function makeStream(env, content, entries) {
  const { ctx } = env;
  const dict = { Type: 'XObject', Subtype: 'Form', FormType: 1, ...entries };
  for (const k of Object.keys(dict)) if (dict[k] === undefined || dict[k] === null) delete dict[k];
  const stream = ctx.flateStream(content, dict);
  return ctx.register(stream);
}

/**
 * The new look of one widget of a text or choice field: { widget, ap } to set (ap null: remove
 * the widget's /AP, as PDFBox does for a widget with no rectangle), or null to leave it. Throws
 * CannotDraw when the value can't be drawn.
 */
function variableTextLook(env, node, widget, value) {
  const { ctx, acroForm } = env;
  if (widget.has(N('PMD'))) return null;
  const rect = rectOf(ctx, widget.get(N('Rect')));
  if (!rect) return { widget, ap: null };
  const daText = getText(ctx, widget, 'DA') ?? textOf(inherited(ctx, node.dict, 'DA', acroForm));
  const da = parseDA(daText);
  if (!da.font) throw new CannotDraw('font is null, check whether /DA entry is incomplete or incorrect');
  const fontRes = fontResource(env, da.font, widget);
  const font = formFont(ctx, fontRes.dict, env.fontCache);
  const ff = flags(ctx, node, acroForm);
  const multiline = node.type === 'text' && (ff & FF_MULTILINE) !== 0;
  const maxLen = num(inherited(ctx, node.dict, 'MaxLen', acroForm), -1);
  const comb = node.type === 'text' && (ff & FF_COMB) !== 0 && maxLen > 0
    && !(ff & (FF_MULTILINE | FF_PASSWORD | FF_FILE_SELECT));
  const q = num(resolve(ctx, widget.get(N('Q'))), num(inherited(ctx, node.dict, 'Q', acroForm), 0));
  const mk = getDict(ctx, widget, 'MK');

  // The stream drawn on: the widget's own when it has a usable one, otherwise a new one.
  const ap = getDict(ctx, widget, 'AP');
  const n = ap && get(ctx, ap, 'N');
  const existing = n instanceof PDFStream && (() => {
    const box = rectOf(ctx, get(ctx, n, 'BBox'));
    return box && Math.abs(width(box)) > 0 && Math.abs(height(box)) > 0;
  })() ? n : null;
  let bbox;
  let matrix;
  let base;
  let resources;
  const entries = {};
  if (existing) {
    bbox = rectOf(ctx, get(ctx, existing, 'BBox'));
    for (const [k, v] of existing.dict.entries()) {
      const key = k.decodeText();
      if (!['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms'].includes(key)) entries[key] = v;
    }
    const data = streamData(existing);
    if (!data) throw new CannotDraw('Unreadable appearance');
    base = mk || data.length === 0 ? null : latin1(data);
    resources = getDict(ctx, existing, 'Resources');
  } else {
    const box = newBox(rect, rotationOf(ctx, mk));
    bbox = box.bbox;
    matrix = box.matrix;
  }
  if (base === null || base === undefined) base = backgroundAndBorder(ctx, widget, mk, bbox).map((op) => op + '\n').join('');

  let list = null;
  let shownValue = value;
  if (node.type === 'list') {
    const opts = options(ctx, node, acroForm);
    const values = choiceValues(ctx, node, acroForm);
    const chosen = getArray(ctx, node.dict, 'I');
    let selected = [];
    if (chosen) for (let i = 0; i < chosen.size(); i++) selected.push(num(resolve(ctx, chosen.get(i)), -1));
    if (!selected.length && values.length && opts.length) selected = values.map((v) => opts.findIndex((o) => o.value === v));
    list = { options: opts, selected: selected.filter((i) => i >= 0), top: Math.max(0, Math.trunc(getNum(ctx, node.dict, 'TI', 0))) };
    shownValue = '';
  }
  // A password is shown as viewers show it, not in the clear.
  if (node.type === 'text' && ff & FF_PASSWORD) shownValue = '*'.repeat([...shownValue].length);
  if (!multiline && node.type === 'text') shownValue = shownValue.replace(NEWLINES, ' ');

  const generated = generatedContent(env, {
    kind: node.type, value: shownValue, font, da, bbox, widget, multiline, comb, maxLen, q, list,
  });
  const mc = markedContent(base);
  let content;
  if (mc) {
    content = base.slice(0, mc.afterBmc) + '\n' + generated + base.slice(mc.emcStart);
  } else {
    content = base + (base && !/\s$/.test(base) ? '\n' : '') + '/Tx BMC\n' + generated + 'EMC\n';
  }
  const raw = makeStream(env, content, {
    ...entries,
    BBox: bbox,
    ...(matrix ? { Matrix: matrix } : {}),
    Resources: resourcesWith(env, resources, da.font, fontRes.raw),
  });
  const newAp = copyDict(ctx, ap);
  newAp.set(N('N'), raw);
  return { widget, ap: newAp };
}

/**
 * The look of a check box or radio button widget: which state shows (/AS, from the field's
 * value, as PDFBox sets it), and a drawn look when the widget has none for that state.
 */
function buttonLook(env, node, widget, index) {
  const { ctx, acroForm } = env;
  const value = textOf(inherited(ctx, node.dict, 'V', acroForm)) ?? 'Off';
  const exports = options(ctx, node, acroForm).map((o) => o.value);
  const ap = getDict(ctx, widget, 'AP');
  const n = ap && get(ctx, ap, 'N');
  // One look whatever the state: it shows as it is.
  if (n instanceof PDFStream) return { widget };
  const states = n instanceof PDFDict ? [...n.entries()].map(([k]) => k.decodeText()) : [];
  const onState = states.find((s) => s !== 'Off');
  let on;
  if (exports.length) {
    // With /Opt, the value is the index of the option chosen (or its export value).
    const chosen = /^\d+$/.test(value) ? Number(value) : exports.indexOf(value);
    on = chosen === index || (onState !== undefined && onState === value);
  } else if (states.length) {
    on = states.includes(value) && value !== 'Off';
  } else {
    on = node.type === 'checkbox' && value !== 'Off' && value !== '';
  }
  const state = on ? (onState ?? (exports.length ? String(index) : value)) : 'Off';
  const change = { widget, as: states.length || ap ? state : undefined, ap: undefined };
  const existing = n instanceof PDFDict ? resolve(ctx, n.get(N(state))) : undefined;
  if (existing instanceof PDFStream) return change;
  // No look for this state: draw one, so a ticked box isn't lost.
  const rect = rectOf(ctx, widget.get(N('Rect')));
  if (!rect) return change;
  const mk = getDict(ctx, widget, 'MK');
  const { bbox, matrix } = newBox(rect, rotationOf(ctx, mk));
  const ops = backgroundAndBorder(ctx, widget, mk, bbox);
  if (on) ops.push(...buttonSymbol(env, node, widget, mk, bbox));
  const raw = makeStream(env, ops.join('\n') + '\n', { BBox: bbox, ...(matrix ? { Matrix: matrix } : {}), Resources: ctx.obj({}) });
  const newN = n instanceof PDFDict ? copyDict(ctx, n) : ctx.obj({});
  newN.set(N(state), raw);
  const newAp = copyDict(ctx, ap);
  newAp.set(N('N'), newN);
  change.ap = newAp;
  change.as = state;
  return change;
}

/** The tick, dot, cross... of a selected button, drawn in the field's colour (/MK /CA picks it). */
function buttonSymbol(env, node, widget, mk, bbox) {
  const { ctx, acroForm } = env;
  const da = parseDA(getText(ctx, widget, 'DA') ?? textOf(inherited(ctx, node.dict, 'DA', acroForm)));
  const style = (mk && getText(ctx, mk, 'CA')) || (node.type === 'radio' ? 'l' : '4');
  const bw = borderWidth(ctx, widget);
  const inner = pad(bbox, Math.max(1, bw) * 2);
  const room = Math.max(0, Math.min(width(inner), height(inner)));
  const s = da.size > 0 ? Math.min(da.size * 0.8, room) : room * 0.8;
  if (s <= 0) return [];
  const cx = (inner[0] + inner[2]) / 2;
  const cy = (inner[1] + inner[3]) / 2;
  const r = s / 2;
  const p = (x, y) => `${fmt(cx + x * r)} ${fmt(cy + y * r)}`;
  const ops = [da.color ? `${da.color.args.map(fmt).join(' ')} ${da.color.op}` : '0 g'];
  const k = 0.5523;
  switch (style[0]) {
    case 'l': // dot
      ops.push(`${p(1, 0)} m ${p(1, k)} ${p(k, 1)} ${p(0, 1)} c ${p(-k, 1)} ${p(-1, k)} ${p(-1, 0)} c`
        + ` ${p(-1, -k)} ${p(-k, -1)} ${p(0, -1)} c ${p(k, -1)} ${p(1, -k)} ${p(1, 0)} c f`);
      break;
    case '8': // cross
      ops.push(`${p(-1, -0.75)} m ${p(-0.75, -1)} l ${p(0, -0.25)} l ${p(0.75, -1)} l ${p(1, -0.75)} l ${p(0.25, 0)} l`
        + ` ${p(1, 0.75)} l ${p(0.75, 1)} l ${p(0, 0.25)} l ${p(-0.75, 1)} l ${p(-1, 0.75)} l ${p(-0.25, 0)} l h f`);
      break;
    case 'u': // diamond
      ops.push(`${p(0, 1)} m ${p(1, 0)} l ${p(0, -1)} l ${p(-1, 0)} l h f`);
      break;
    case 'n': // square
      ops.push(`${p(-0.8, -0.8)} ${fmt(1.6 * r)} ${fmt(1.6 * r)} re f`);
      break;
    case 'H': { // star
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 ? 0.4 : 1;
        pts.push(p(Math.cos(a) * rr, Math.sin(a) * rr));
      }
      ops.push(`${pts[0]} m ${pts.slice(1).map((q) => `${q} l`).join(' ')} h f`);
      break;
    }
    default: // tick
      ops.push(`${p(-0.95, 0.05)} m ${p(-0.6, 0.35)} l ${p(-0.25, 0)} l ${p(0.65, 0.95)} l ${p(0.95, 0.65)} l ${p(-0.25, -0.6)} l h f`);
  }
  return ops;
}

/**
 * Draws field `node` again, all its widgets, from its value. Nothing is changed unless every
 * widget could be drawn: otherwise it throws (CannotDraw for text its font can't show) and the
 * field keeps the look it had, as the app puts back what PDFBox had changed.
 */
export function redrawField(env, node) {
  const { ctx, acroForm } = env;
  const changes = [];
  if (node.type === 'text' || node.type === 'combo' || node.type === 'list') {
    let value = '';
    if (node.type === 'text') value = textValue(ctx, node, acroForm);
    else if (node.type === 'combo') {
      // The text a drop-down shows for its value, not the export value it keeps.
      const first = choiceValues(ctx, node, acroForm)[0];
      value = first === undefined ? '' : shownChoice(ctx, node, first, acroForm);
    }
    for (const widget of node.widgets) {
      const change = variableTextLook(env, node, widget, value);
      if (change) changes.push(change);
    }
  } else if (node.type === 'checkbox' || node.type === 'radio') {
    node.widgets.forEach((widget, i) => changes.push(buttonLook(env, node, widget, i)));
  } else {
    // Push buttons and signatures keep the look they have.
    return;
  }
  for (const { widget, ap, as } of changes) {
    if (ap === null) widget.delete(N('AP'));
    else if (ap) widget.set(N('AP'), ap);
    if (as !== undefined) widget.set(N('AS'), PDFName.of(as));
  }
}

export { CannotDraw };
