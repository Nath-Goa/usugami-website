// Reading a Word document's body, headers and footers into what they're made of: paragraphs with
// their runs, pictures and fields, tables, page and section breaks. A port of the Reader and the
// section reading of the app's DocxConverter.kt; docx-layout.js lays out what is read here.
import { Ns } from './ooxml.js';
import { OfficeColors } from './colors.js';
import { ListNumbering, OfficeRect, OfficeUnits, GroupFrame, SymbolFonts } from './office-formats.js';
import { ImagePicture, StandInPicture } from './office-pdf.js';
import { ParaProps, RunProps, TableProps, Borders, ComplexScript, sameStyle, hexInt } from './docx-styles.js';
import { trim } from './xlsx-numbers-kt.js';

/** Far more columns than Word lets a table have (63): only a crafted file has more. */
export const MAX_COLUMNS = 1000;

const Format = ListNumbering.Format;

// ---------------------------------------------------------------------------------------------
// What the document is made of, as read

/**
 * A paragraph as read: its formatting, its inlines (text, page numbers, pictures), its list label
 * and the label's look, what follows the label ('tab', 'space', 'nothing'), the paragraph mark's
 * look, its floating pictures, and the bookmarks starting in it (for links to them).
 */
export class DocPara {
  constructor(props, inlines, label, labelStyle, labelSuffix, mark, floats, bookmarks = []) {
    this.props = props;
    this.inlines = inlines;
    this.label = label;
    this.labelStyle = labelStyle;
    this.labelSuffix = labelSuffix;
    this.mark = mark;
    this.floats = floats;
    this.bookmarks = bookmarks;
  }
}

export class DocTable {
  constructor(props, grid, rows) {
    this.props = props;
    this.grid = grid;
    this.rows = rows;
  }
}

export class DocRow {
  constructor(cells, height, exact, header, gridBefore) {
    this.cells = cells;
    this.height = height;
    this.exact = exact;
    this.header = header;
    this.gridBefore = gridBefore;
  }
}

export class DocCell {
  constructor(span, vMerge, fill, borders, verticalAlign, margins, content) {
    this.span = span;
    this.vMerge = vMerge;
    this.fill = fill;
    this.borders = borders;
    this.verticalAlign = verticalAlign;
    this.margins = margins;
    this.content = content;
  }
}

/** A page break between paragraphs, and the end of a section. */
export const PAGE_BREAK = Object.freeze({ kind: 'pageBreak' });
export const SECTION_END = Object.freeze({ kind: 'sectionEnd' });

/** Inlines: text in a style (with a link, maybe), the page's number, a picture in the text. */
export const textInline = (text, style, link = null) => ({ kind: 'text', text, style, link });
/** The page's number, in `format` when its field asks for one (such as "PAGE \* roman"), else in its section's. */
export const pageInline = (style, format) => ({ kind: 'page', style, format });
export const pictureInline = (picture, width, height, style) => ({ kind: 'picture', picture, width, height, style });

/** Where a floating picture goes: relative to `from` ("page", "margin", "paragraph"...), by `offset` points or `align`. */
export class Position {
  constructor(from, offset, align) {
    this.from = from;
    this.offset = offset;
    this.align = align;
  }
}

/**
 * A floating picture. `overText` when Word puts it in front of or behind the text, rather than
 * wrapping text around it; `behind` when behind it.
 */
export class Floating {
  constructor(picture, width, height, h, v, overText, behind = false) {
    this.picture = picture;
    this.width = width;
    this.height = height;
    this.h = h;
    this.v = v;
    this.overText = overText;
    this.behind = behind;
  }
}

/** How a picture is turned: by `degrees` clockwise, after being mirrored across (`flipH`) or upside down (`flipV`). */
export class Turn {
  constructor(degrees, flipH, flipV) {
    this.degrees = degrees;
    this.flipH = flipH;
    this.flipV = flipV;
  }

  get isNone() {
    return this.degrees % 360 === 0 && !this.flipH && !this.flipV;
  }

  /** Turned a quarter or three quarters: its box lies on its side. */
  get sideways() {
    const quarters = Math.round(this.degrees / 90);
    return Math.abs(this.degrees - quarters * 90) < 1 && ((quarters % 2) + 2) % 2 === 1;
  }
}
Turn.NONE = Object.freeze(new Turn(0, false, false));

/** Whether `item` has the page's number in it (a PAGE field), in its text or in a table cell's. */
export function hasPageNumber(item) {
  if (item instanceof DocPara) return item.inlines.some((i) => i.kind === 'page');
  if (item instanceof DocTable) return item.rows.some((row) => row.cells.some((cell) => cell.content.some(hasPageNumber)));
  return false;
}

/** Whether `item` puts anything on the page: text, a picture or a table. */
export function shows(item) {
  if (item instanceof DocPara) return item.floats.length > 0 || item.inlines.some((i) => i.kind !== 'text' || /\S/u.test(i.text));
  return item instanceof DocTable;
}

/** The pictures `item` draws (for loading them before it is laid out). */
export function picturesOf(item, out = []) {
  if (item instanceof DocPara) {
    for (const i of item.inlines) if (i.kind === 'picture') out.push(i.picture);
    for (const f of item.floats) out.push(f.picture);
  } else if (item instanceof DocTable) {
    for (const row of item.rows) for (const cell of row.cells) for (const c of cell.content) picturesOf(c, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pictures as read (drawn by docx-layout.js)

/**
 * `picture` turned `turn` about its middle. It's drawn in its own box, centred where it goes: the
 * box it's given, or that box on its side when `sideways` (given the turned box).
 */
export class TurnedPicture {
  constructor(picture, turn, sideways) {
    this.picture = picture;
    this.turn = turn;
    this.sideways = sideways;
  }

  load() {
    return this.picture.load?.();
  }

  draw(canvas, rect) {
    const r = rectOf(rect);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const w = this.sideways ? r.height : r.width;
    const h = this.sideways ? r.width : r.height;
    canvas.save();
    canvas.translate(cx, cy);
    if (this.turn.degrees) canvas.rotate((this.turn.degrees * Math.PI) / 180);
    canvas.scale(this.turn.flipH ? -1 : 1, this.turn.flipV ? -1 : 1);
    canvas.translate(-cx, -cy);
    this.picture.draw(canvas, { x: cx - w / 2, y: cy - h / 2, width: w, height: h });
    canvas.restore();
  }
}

/** Pictures where a group or drawing canvas `width` × `height` points big puts them, stretched with it. */
export class GroupPicture {
  constructor(width, height, parts) {
    this.width = width;
    this.height = height;
    this.parts = parts;
  }

  async load() {
    for (const [picture] of this.parts) await picture.load?.();
  }

  draw(canvas, rect) {
    const r = rectOf(rect);
    const sx = r.width / this.width;
    const sy = r.height / this.height;
    for (const [picture, b] of this.parts) {
      picture.draw(canvas, { x: r.x + b.x * sx, y: r.y + b.y * sy, width: b.width * sx, height: b.height * sy });
    }
  }
}

/** `picture` under a white veil `opacity` opaque: lighter, as Word washes out a watermark. */
export class VeiledPicture {
  constructor(picture, opacity) {
    this.picture = picture;
    this.opacity = opacity;
  }

  load() {
    return this.picture.load?.();
  }

  draw(canvas, rect) {
    const r = rectOf(rect);
    this.picture.draw(canvas, r);
    canvas.save();
    canvas.globalAlpha = Math.round(this.opacity * 255) / 255;
    canvas.fillStyle = 0xffffffff;
    canvas.fillRect(r.x, r.y, r.width, r.height);
    canvas.restore();
  }
}

/** A light grey box with a caption, for charts and SmartArt: its fonts are loaded by load(). */
export class CaptionPicture {
  constructor(caption) {
    this.inner = new StandInPicture(caption);
  }

  async load() {
    await this.inner.prepare();
  }

  draw(canvas, rect) {
    this.inner.draw(canvas, rect);
  }
}

function rectOf(r) {
  if (typeof r.left === 'number' && typeof r.right === 'number' && !(r instanceof OfficeRect)) {
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** `picture` turned `turn`; `sideways` when the box it's drawn in is its turned box, not its own. */
function turned(picture, turn, sideways) {
  return turn.isNone ? picture : new TurnedPicture(picture, turn, sideways);
}

// ---------------------------------------------------------------------------------------------
// Sections: read ahead, since a section's page size is written at its end

/** A section's page: size, margins, header and footer distances, how it starts, its headers, footers and page numbers. */
export class Section {
  constructor(width, height, top, bottom, left, right, headerDistance, footerDistance, type, headers, footers, titlePage, pageStart, pageFormat) {
    Object.assign(this, { width, height, top, bottom, left, right, headerDistance, footerDistance, type, headers, footers, titlePage, pageStart, pageFormat });
  }
}

/** US Letter with one-inch margins: Word's own default. */
export const DEFAULT_SECTION = Object.freeze(new Section(612, 792, 72, 72, 72, 72, 36, 36, 'nextPage', new Map(), new Map(), false, null, Format.DECIMAL));

/** The sections of the document whose root element is `root` (main part `main`), in order; at least one. */
export function readSections(pkg, main, root) {
  const found = [];
  if (root) {
    root.descendants((x) => {
      switch (x.name) {
        case 'sectPr':
          found.push(readSection(pkg, main, x, found[found.length - 1] ?? null));
          return false;
        case 'body': case 'p': case 'pPr': case 'sdt': case 'sdtContent': case 'customXml': case 'ins':
          return true;
        default:
          return false;
      }
    });
  }
  return found.length ? found : [DEFAULT_SECTION];
}

function readSection(pkg, main, x, previous) {
  let width = 612;
  let height = 792;
  const margin = [72, 72, 72, 72, 36, 36]; // top, bottom, left, right, header, footer
  let type = 'nextPage';
  const headers = new Map(previous?.headers ?? []);
  const footers = new Map(previous?.footers ?? []);
  let titlePage = false;
  let pageStart = null;
  let pageFormat = Format.DECIMAL;
  for (const c of x.children()) {
    switch (c.name) {
      case 'pgSz': {
        const w = c.intAttr('w');
        const h = c.intAttr('h');
        if (w != null && w > 0) width = w / 20;
        if (h != null && h > 0) height = h / 20;
        break;
      }
      case 'pgMar':
        ['top', 'bottom', 'left', 'right', 'header', 'footer'].forEach((key, i) => {
          const v = c.intAttr(key);
          if (v != null) margin[i] = Math.abs(v) / 20;
        });
        {
          const gutter = c.intAttr('gutter');
          if (gutter != null) margin[2] += Math.abs(gutter) / 20;
        }
        break;
      case 'type': type = c.attr('val') ?? 'nextPage'; break;
      case 'headerReference': {
        const target = pkg.target(main, c.relId());
        if (target != null) headers.set(c.attr('type') ?? 'default', target);
        break;
      }
      case 'footerReference': {
        const target = pkg.target(main, c.relId());
        if (target != null) footers.set(c.attr('type') ?? 'default', target);
        break;
      }
      case 'titlePg': titlePage = c.flag(); break;
      case 'pgNumType': {
        pageStart = c.intAttr('start');
        const f = ListNumbering.wordFormat(c.attr('fmt'));
        pageFormat = f === Format.BULLET || f === Format.NONE ? Format.DECIMAL : f;
        break;
      }
      default: break;
    }
  }
  width = Math.min(14400, Math.max(72, width));
  height = Math.min(14400, Math.max(72, height));
  // Keep at least an inch for the text, whatever the margins say.
  if (margin[2] + margin[3] > width - 72) margin[2] = margin[3] = 36;
  if (margin[0] + margin[1] > height - 72) margin[0] = margin[1] = 36;
  return new Section(width, height, margin[0], margin[1], margin[2], margin[3], margin[4], margin[5], type, headers, footers, titlePage, pageStart, pageFormat);
}

/** Whether the document's settings give even pages their own headers and footers ("Different Odd & Even Pages"). */
export async function readEvenAndOddHeaders(pkg, main) {
  const path = pkg.targetOfType(main, '/settings');
  if (path == null) return false;
  const x = await pkg.xml(path);
  let found = false;
  if (x) for (const c of x.children()) if (c.name === 'evenAndOddHeaders') found = c.flag();
  return found;
}

/** The names of the bookmarks in a part (`root` its root element), which links in it can go to. */
export function bookmarkNames(root, into = new Set()) {
  if (!root) return into;
  for (const el of root.el.getElementsByTagNameNS('*', 'bookmarkStart')) {
    const name = attrOf(el, 'name');
    if (name) into.add(name);
  }
  return into;
}

function attrOf(el, local) {
  for (const a of el.attributes) if (a.localName === local && a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') return a.value;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading

/** Whether a field instruction is the page's number ("PAGE", "PAGE \* roman"), not PAGEREF or NUMPAGES. */
export function isPageField(instruction) {
  if (instruction == null) return false;
  return (trim(instruction).split(/[ \\]/)[0] ?? '').toUpperCase() === 'PAGE';
}

/**
 * Where a field takes the reader when its result is clicked: a HYPERLINK field to { url } or to
 * { anchor } (a bookmark, with \l), a PAGEREF field with \h (a contents line's page number) to its
 * bookmark; null for other fields.
 */
export function fieldTarget(instruction) {
  const m = /^\s*(HYPERLINK|PAGEREF)\b([\s\S]*)$/i.exec(instruction ?? '');
  if (!m) return null;
  const tokens = [...m[2].matchAll(/"([^"]*)"|(\\[a-zA-Z*#@!])|(\S+)/g)].map((t) => (t[2] ? { s: t[2] } : { v: t[1] ?? t[3] }));
  let first = null;
  let anchor = null;
  let jump = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.s) {
      const value = tokens[i + 1]?.v;
      const s = t.s.toLowerCase();
      if (s === '\\l' && value != null) anchor = value;
      if (s === '\\h') jump = true;
      // The switches that take a value: \l (bookmark), \m, \n, \o (tip), \t (target frame), \* (format).
      if (value != null && /^\\[lmnot*]$/i.test(t.s)) i++;
      continue;
    }
    if (first == null) first = t.v;
  }
  if (m[1].toUpperCase() === 'PAGEREF') return jump && first ? { anchor: first } : null;
  if (first) return { url: anchor && !first.includes('#') ? `${first}#${anchor}` : first };
  if (anchor) return { anchor };
  return null;
}

/** A Field being read: its instruction, whether its result has started, whether it's a page number, and where it links. */
class Field {
  constructor() {
    this.instruction = '';
    this.inResult = false;
    this.isPage = false;
    this.link = null;
  }
}

/** What a paragraph is built of while it's read: inlines in segments (page breaks between them), floats, text boxes' items. */
class ParaBuilder {
  constructor(base) {
    this.base = base;
    this.segments = [[]];
    this.floats = [];
    this.boxes = [];
    this.bookmarks = [];
    this.links = [];
  }

  add(inline) {
    this.segments[this.segments.length - 1].push(inline);
  }
}

/**
 * Reads block content from part `part` (the document, or a header or footer), whose relationships
 * its pictures and links use. `ctx`: { pkg, theme, styles, numbering, images, bookmarks (names that
 * links can go to) }.
 */
export class Reader {
  constructor(ctx, part) {
    this.ctx = ctx;
    this.part = part;
    /** Fields being read, outermost first. */
    this.fields = [];
    /** How many times content kept in another format (w:altChunk) was met: it isn't read. */
    this.altChunks = 0;
    /** Bookmarks between paragraphs, for the next one. */
    this.pendingBookmarks = [];
  }

  blocks(x, tableStyle, emit) {
    for (const c of x.children()) this.block(c, tableStyle, emit);
  }

  block(x, tableStyle, emit) {
    switch (x.name) {
      case 'p': if (x.ns === Ns.WORD) this.paragraph(x, tableStyle, emit); break;
      case 'tbl': if (x.ns === Ns.WORD) emit(this.table(x)); break;
      case 'sdt': for (const c of x.children()) if (c.name === 'sdtContent') this.blocks(c, tableStyle, emit); break;
      case 'customXml': case 'ins': case 'moveTo': this.blocks(x, tableStyle, emit); break;
      case 'AlternateContent': for (const c of x.children()) if (c.name === 'Choice') this.blocks(c, tableStyle, emit); break;
      case 'altChunk': this.altChunks++; break;
      case 'bookmarkStart': if (x.ns === Ns.WORD) this.bookmark(x, this.pendingBookmarks); break;
      default: break;
    }
  }

  bookmark(x, into) {
    const name = x.attr('name');
    if (name && this.ctx.bookmarks?.has(name)) into.push(name);
  }

  paragraph(x, tableStyle, emit) {
    const { styles, theme, numbering } = this.ctx;
    let direct = new ParaProps();
    let endsSection = false;
    let out = null;
    const builder = () => (out ??= new ParaBuilder(styles.paragraphRun(direct.style, tableStyle)));
    for (const c of x.children()) {
      if (c.name === 'pPr' && c.ns === Ns.WORD) direct = ParaProps.read(c, theme, () => { endsSection = true; });
      else this.content(c, builder());
    }
    const built = builder();
    // Formatting: direct, then the list level's indents, then the style's.
    const styled = styles.resolvePara(new ParaProps({ style: direct.style }), tableStyle);
    const listed = direct.over(styled);
    const numId = listed.numId != null && listed.numId > 0 ? listed.numId : null;
    const level = listed.level ?? 0;
    const listLevel = numId != null ? numbering.level(numId, level) : null;
    const props = direct.over(listLevel?.para).over(styled);
    const markRun = (direct.mark ?? new RunProps()).over(built.base);
    const visible = built.segments.some((s) => s.length) || built.floats.length > 0 || markRun.hidden !== true;
    const bookmarks = [...this.pendingBookmarks, ...built.bookmarks];
    this.pendingBookmarks = [];
    if (visible) {
      const label = numId != null ? numbering.next(numId, level) : null;
      const labelStyle = (listLevel?.run ?? new RunProps()).over(markRun).copy({ underline: false, background: null }).toStyle(theme);
      const mark = markRun.toStyle(theme);
      let emitted = false;
      built.segments.forEach((inlines, i) => {
        if (i > 0) emit(PAGE_BREAK);
        // The text before a page break; the paragraph mark always goes after it.
        if (i === 0 && !inlines.length && built.segments.length > 1 && !built.floats.length) return;
        // A paragraph starting with a page break keeps its number and space before on the next page.
        const first = !emitted;
        emitted = true;
        emit(new DocPara(
          first ? props : props.copy({ before: 0, pageBreakBefore: false }),
          inlines,
          first ? label : null,
          labelStyle,
          listLevel?.suffix ?? 'tab',
          mark,
          first ? built.floats : [],
          first ? bookmarks : [],
        ));
      });
    } else if (bookmarks.length) {
      this.pendingBookmarks = bookmarks;
    }
    for (const box of built.boxes) emit(box);
    if (endsSection) emit(SECTION_END);
  }

  /** Paragraph content: runs, and what can hold runs. */
  content(x, out) {
    switch (x.name) {
      case 'r': this.run(x, out); break;
      case 'hyperlink': {
        const link = this.hyperlink(x);
        out.links.push(link);
        for (const c of x.children()) this.content(c, out);
        out.links.pop();
        break;
      }
      case 'ins': case 'moveTo': case 'smartTag': case 'customXml': case 'dir': case 'bdo': case 'sdtContent':
        for (const c of x.children()) this.content(c, out);
        break;
      case 'sdt':
        for (const c of x.children()) if (c.name === 'sdtContent') for (const d of c.children()) this.content(d, out);
        break;
      case 'AlternateContent':
        for (const c of x.children()) if (c.name === 'Choice') for (const d of c.children()) this.content(d, out);
        break;
      case 'fldSimple': {
        const instr = x.attr('instr');
        if (isPageField(instr)) {
          out.add(pageInline(out.base.toStyle(this.ctx.theme), ListNumbering.fieldFormat(instr ?? '')));
        } else {
          const link = this.fieldLink(fieldTarget(instr));
          out.links.push(link);
          for (const c of x.children()) this.content(c, out);
          out.links.pop();
        }
        break;
      }
      case 'oMathPara': case 'oMath': {
        const text = allText(x);
        if (text) out.add(textInline(text, out.base.toStyle(this.ctx.theme)));
        break;
      }
      case 'bookmarkStart': if (x.ns === Ns.WORD) this.bookmark(x, out.bookmarks); break;
      default: break;
    }
  }

  /** Where a w:hyperlink goes: { url } (an outside address) or { dest } (a bookmark), or null. */
  hyperlink(x) {
    const anchor = x.attr('anchor');
    const id = x.relId('id');
    if (id != null) {
      const rel = this.ctx.pkg.relationships(this.part).get(id);
      if (rel?.external && rel.target) {
        const url = trim(rel.target);
        return { url: anchor && !url.includes('#') ? `${url}#${anchor}` : url };
      }
    }
    return anchor && this.ctx.bookmarks?.has(anchor) ? { dest: anchor } : null;
  }

  fieldLink(found) {
    if (!found) return null;
    if (found.url) return { url: found.url };
    return this.ctx.bookmarks?.has(found.anchor) ? { dest: found.anchor } : null;
  }

  /** The link text read now goes to: the innermost field's in its result, else the hyperlink it's in. */
  currentLink(out) {
    for (let i = this.fields.length - 1; i >= 0; i--) if (this.fields[i].inResult && this.fields[i].link) return this.fields[i].link;
    for (let i = out.links.length - 1; i >= 0; i--) if (out.links[i]) return out.links[i];
    return null;
  }

  run(x, out) {
    const { styles, theme } = this.ctx;
    let props = out.base;
    let cached = null;
    let cachedComplex = null;
    const style = () => (cached ??= props.toStyle(theme));
    const complexStyle = () => (cachedComplex ??= props.toComplexStyle(theme));
    const shown = () => props.hidden !== true && !this.fields.some((f) => !f.inResult || f.isPage);
    // Whether the run's text so far ended in complex-script letters (null: none yet).
    let complexBefore = null;
    const text = (s) => {
      if (!s || !shown()) return;
      const link = this.currentLink(out);
      const complex = complexStyle();
      if (sameStyle(complex, style())) out.add(textInline(s, style(), link));
      else if (props.allComplex) out.add(textInline(s, complex, link));
      else {
        complexBefore = ComplexScript.split(s, complexBefore, (part, isComplex) => out.add(textInline(part, isComplex ? complex : style(), link)));
      }
    };
    const child = (c) => {
      switch (c.name) {
        case 'rPr': {
          const d = RunProps.read(c, theme);
          props = d.over(styles.run(d.style)).over(out.base);
          cached = null;
          cachedComplex = null;
          break;
        }
        case 't': text(c.text().replace(/[\n\r]/g, ' ')); break;
        case 'tab': case 'ptab': text('\t'); break;
        case 'br':
          if (c.attr('type') === 'page') {
            if (props.hidden !== true) out.segments.push([]);
          } else {
            text('\n');
          }
          break;
        case 'cr': text('\n'); break;
        case 'noBreakHyphen': text('\u2011'); break;
        case 'softHyphen': text('\u00AD'); break;
        case 'sym': {
          const code = hexInt(c.attr('char'));
          if (code != null && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
            text(SymbolFonts.character(c.attr('font'), String.fromCodePoint(code)));
          }
          break;
        }
        // Text with a phonetic guide (furigana): the text itself, without its guide.
        case 'ruby':
          for (const r of c.children()) if (r.name === 'rubyBase') for (const d of r.children()) this.content(d, out);
          break;
        case 'drawing': if (shown()) this.drawing(c, out, style()); break;
        case 'pict': case 'object': if (shown()) this.vml(c, out, style()); break;
        case 'fldChar':
          switch (c.attr('fldCharType')) {
            case 'begin': this.fields.push(new Field()); break;
            case 'separate': {
              const field = this.fields[this.fields.length - 1];
              if (field) {
                field.inResult = true;
                field.link = this.fieldLink(fieldTarget(field.instruction));
                if (isPageField(field.instruction) && !this.fields.some((f) => !f.inResult || f.isPage)) {
                  out.add(pageInline(style(), ListNumbering.fieldFormat(field.instruction)));
                  field.isPage = true;
                }
              }
              break;
            }
            case 'end': {
              const field = this.fields.pop();
              if (field && !field.inResult && isPageField(field.instruction)) out.add(pageInline(style(), ListNumbering.fieldFormat(field.instruction)));
              break;
            }
            default: break;
          }
          break;
        case 'instrText': {
          const field = this.fields[this.fields.length - 1];
          if (field) field.instruction += c.text();
          break;
        }
        case 'AlternateContent':
          for (const a of c.children()) if (a.name === 'Choice') for (const d of a.children()) child(d);
          break;
        default: break;
      }
    };
    for (const c of x.children()) child(c);
  }

  /**
   * A DrawingML picture or shape (w:drawing), in the text or floating: a picture, the pictures of a
   * group or drawing canvas where the group puts them, and text boxes' text. One hidden in Word
   * (with the Selection Pane) is left out, as Word neither shows nor prints it.
   */
  drawing(x, out, style) {
    const { pkg, images } = this.ctx;
    const part = this.part;
    for (const d of x.children()) {
      const inline = d.name === 'inline';
      if (!inline && d.name !== 'anchor') continue;
      const behind = d.flag('behindDoc', false);
      let width = 0;
      let height = 0;
      let caption = null;
      let hidden = false;
      let standIn = false;
      let wrapNone = false;
      let h = new Position('column', 0, null);
      let v = new Position('paragraph', 0, null);
      const found = [];

      // A picture (pic:pic) or shape (wps:wsp): its picture, or picture fill, and its text box's text.
      // In a group, `place` takes its box to the drawing's.
      const shape = (s, place) => {
        let shapeHidden = false;
        let path = null;
        let crop = null;
        let frame = null;
        const scan = (e) => {
          for (const c of e.children()) {
            if (shapeHidden) return;
            switch (c.name) {
              case 'cNvPr': shapeHidden = c.flag('hidden', false); break;
              case 'blip': if (path == null) path = pkg.target(part, c.relId('embed')); break;
              case 'srcRect':
                if (crop == null) crop = ['l', 't', 'r', 'b'].map((k) => Math.fround((c.percentAttr(k) ?? 0) / 100000));
                break;
              case 'xfrm': if (frame == null) frame = shapeFrame(c); break;
              case 'txbxContent': this.blocks(c, null, (it) => out.boxes.push(it)); break;
              default: scan(c); break;
            }
          }
        };
        scan(s);
        if (path == null || shapeHidden) return;
        let placed = null;
        if (place) {
          if (!frame) return;
          placed = place(frame[0]);
        }
        found.push({ path, crop, box: placed, turn: frame?.[1] ?? Turn.NONE });
      };

      // What's inside the current element, in a group placed by `place` (null outside groups).
      const contents = (e, place) => {
        let inner = place;
        let groupHidden = false;
        for (const c of e.children()) {
          if (groupHidden) return;
          switch (c.name) {
            // A group hidden as a whole.
            case 'cNvPr': groupHidden = c.flag('hidden', false); break;
            case 'grpSpPr':
              for (const g of c.children()) if (g.name === 'xfrm') inner = groupFrame(g, place ?? ((r) => r));
              break;
            case 'pic': case 'wsp': shape(c, inner); break;
            // A group (wgp, grpSp) or drawing canvas (wpc): their shapes are placed in their box.
            case 'wgp': case 'grpSp': case 'wpc': contents(c, inner ?? ((r) => r)); break;
            case 'txbxContent': this.blocks(c, null, (it) => out.boxes.push(it)); break;
            default: contents(c, inner); break;
          }
        }
      };

      for (const c of d.children()) {
        switch (c.name) {
          case 'extent':
            width = OfficeUnits.emu(c.longAttr('cx') ?? 0);
            height = OfficeUnits.emu(c.longAttr('cy') ?? 0);
            break;
          case 'docPr': {
            const descr = c.attr('descr');
            const title = c.attr('title');
            caption = descr && /\S/u.test(descr) ? descr : title && /\S/u.test(title) ? title : null;
            hidden = c.flag('hidden', false);
            break;
          }
          case 'wrapNone': wrapNone = true; break;
          case 'positionH': case 'positionV': {
            const horizontal = c.name === 'positionH';
            const from = c.attr('relativeFrom') ?? (horizontal ? 'column' : 'paragraph');
            let offset = 0;
            let align = null;
            for (const p of c.children()) {
              if (p.name === 'posOffset') offset = OfficeUnits.emu(longOrZero(p.text()));
              else if (p.name === 'align') align = trim(p.text());
            }
            if (horizontal) h = new Position(from, offset, align);
            else v = new Position(from, offset, align);
            break;
          }
          // The graphic comes after docPr, so a hidden drawing's text boxes aren't read either.
          case 'graphic':
            if (!hidden) {
              for (const g of c.children()) {
                if (g.name !== 'graphicData') continue;
                const uri = g.attr('uri') ?? '';
                if (uri.includes('chart') || uri.includes('diagram')) standIn = true;
                contents(g, null);
              }
            }
            break;
          default: break;
        }
      }
      if (hidden || !(width > 0) || !(height > 0)) continue;
      const lone = found.find((f) => f.box == null);
      // A picture turned a quarter takes the room of its turned box, as in Word.
      const sideways = lone?.turn?.sideways === true;
      let picture;
      if (lone) picture = turned(new ImagePicture(images, lone.path, width, height, lone.crop), lone.turn, sideways);
      else if (found.length) {
        picture = new GroupPicture(width, height, found.filter((f) => f.box).map((f) => [
          turned(new ImagePicture(images, f.path, f.box.width, f.box.height, f.crop), f.turn, false), f.box,
        ]));
      } else if (standIn) picture = new CaptionPicture(caption);
      else continue;
      const [w, ht] = sideways ? [height, width] : [width, height];
      if (inline) out.add(pictureInline(picture, w, ht, style));
      else out.floats.push(new Floating(picture, w, ht, h, v, wrapNone, behind));
    }
  }

  /**
   * An older VML picture or text box (w:pict, w:object). A picture positioned absolutely floats, as
   * Word's picture watermarks do, lightened when Word washes it out; a hidden shape is left out. Its
   * size and place are those of the outermost shape holding it: a shape in a group (a Word 2003
   * drawing canvas) is placed in the group's own coordinates, so it goes where the group goes.
   */
  vml(x, out, style) {
    const { pkg, images } = this.ctx;
    let path = null;
    let css = Object.create(null);
    let veil = 0;
    let wrap = null;
    const scan = (e, owner, outermost) => {
      for (const c of e.children()) {
        let own = owner;
        let frame = outermost;
        if (c.ns === Ns.VML && c.name !== 'imagedata') {
          const shapeCss = OfficeUnits.cssStyle(c.attr('style'));
          if (Object.keys(shapeCss).length) own = shapeCss;
          if (frame == null && ('width' in shapeCss || 'height' in shapeCss)) frame = shapeCss;
        }
        if (own.visibility === 'hidden') continue;
        switch (c.name) {
          case 'imagedata':
            if (path == null) {
              path = pkg.target(this.part, c.relId() ?? c.attr('relid'));
              css = frame ?? Object.create(null);
              veil = washout(c);
            }
            break;
          case 'wrap': if (wrap == null) wrap = c.attr('type') ?? 'none'; break;
          case 'txbxContent': this.blocks(c, null, (it) => out.boxes.push(it)); break;
          default: scan(c, own, frame); break;
        }
      }
    };
    scan(x, Object.create(null), null);
    if (path == null) return;
    const width = css.width != null ? OfficeUnits.cssLength(css.width) ?? 0 : 0;
    const height = css.height != null ? OfficeUnits.cssLength(css.height) ?? 0 : 0;
    if (!(width > 0) || !(height > 0)) return;
    const image = new ImagePicture(images, path, width, height, null);
    const picture = veil > 0 ? new VeiledPicture(image, veil) : image;
    if (css.position === 'absolute') {
      // In front of or behind the text unless text wraps around it; behind when below the text's layer.
      const z = /^[+-]?\d+$/.test(css['z-index'] ?? '') ? Number(css['z-index']) : 0;
      out.floats.push(new Floating(picture, width, height, vmlPosition(css, true), vmlPosition(css, false), wrap == null || wrap === 'none', z < 0));
    } else {
      out.add(pictureInline(picture, width, height, style));
    }
  }

  table(x) {
    const { styles } = this.ctx;
    let props = new TableProps();
    const grid = [];
    const rows = [];
    const tableStyle = () => props.style ?? styles.defaultTableStyle;
    const rowsIn = (e) => {
      for (const c of e.children()) {
        if (c.name === 'tr') rows.push(this.row(c, tableStyle()));
        else if (c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'customXml') rowsIn(c);
      }
    };
    for (const c of x.children()) {
      switch (c.name) {
        case 'tblPr': props = TableProps.read(c); break;
        case 'tblGrid':
          for (const g of c.children()) if (g.name === 'gridCol' && grid.length < MAX_COLUMNS) grid.push((g.intAttr('w') ?? 0) / 20);
          break;
        case 'tr': rows.push(this.row(c, tableStyle())); break;
        case 'sdt': case 'customXml': rowsIn(c); break;
        default: break;
      }
    }
    return new DocTable(props, grid, rows);
  }

  row(x, tableStyle) {
    let height = null;
    let exact = false;
    let header = false;
    let gridBefore = 0;
    const cells = [];
    const cellsIn = (e) => {
      for (const c of e.children()) {
        if (c.name === 'tc') cells.push(this.cell(c, tableStyle));
        else if (c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'customXml') cellsIn(c);
      }
    };
    for (const c of x.children()) {
      switch (c.name) {
        case 'trPr': case 'tblPrEx':
          for (const p of c.children()) {
            if (p.name === 'trHeight') {
              const v = p.intAttr('val');
              height = v != null ? v / 20 : null;
              exact = p.attr('hRule') === 'exact';
            } else if (p.name === 'tblHeader') header = p.flag();
            else if (p.name === 'gridBefore') gridBefore = Math.min(MAX_COLUMNS, Math.max(0, p.intAttr('val') ?? 0));
          }
          break;
        case 'tc': cells.push(this.cell(c, tableStyle)); break;
        case 'sdt': case 'customXml': cellsIn(c); break;
        default: break;
      }
    }
    return new DocRow(cells, height, exact, header, gridBefore);
  }

  cell(x, tableStyle) {
    let span = 1;
    let vMerge = null;
    let fill = null;
    let borders = null;
    let verticalAlign = 0;
    let margins = null;
    const content = [];
    for (const c of x.children()) {
      if (c.name === 'tcPr') {
        for (const p of c.children()) {
          switch (p.name) {
            case 'gridSpan': span = Math.min(MAX_COLUMNS, Math.max(1, p.intAttr('val') ?? 1)); break;
            case 'vMerge': vMerge = p.attr('val') ?? 'continue'; break;
            case 'shd': fill = OfficeColors.hex(p.attr('fill')); break;
            case 'tcBorders': borders = Borders.read(p); break;
            case 'vAlign': { const v = p.attr('val'); verticalAlign = v === 'center' ? 1 : v === 'bottom' ? 2 : 0; break; }
            case 'tcMar': margins = TableProps.readMargins(p); break;
            default: break;
          }
        }
      } else {
        this.block(c, tableStyle, (it) => content.push(it));
      }
    }
    return new DocCell(span, vMerge, fill, borders, verticalAlign, margins, content);
  }
}

function allText(x) {
  let out = '';
  for (const c of x.children()) out += c.name === 't' ? c.text() : allText(c);
  return out;
}

function longOrZero(text) {
  const t = trim(text);
  if (!/^[+-]?\d+$/.test(t)) return 0;
  const n = Number(t);
  return Math.abs(n) > 9223372036854775807 ? 0 : n;
}

/** A shape's a:xfrm: its box in points, and how it's turned. */
function shapeFrame(x) {
  const turn = new Turn(Math.fround((x.longAttr('rot') ?? 0) / 60000), x.flag('flipH', false), x.flag('flipV', false));
  let box = new OfficeRect(0, 0, 0, 0);
  for (const c of x.children()) {
    if (c.name === 'off') box = box.copy({ x: OfficeUnits.emu(c.longAttr('x') ?? 0), y: OfficeUnits.emu(c.longAttr('y') ?? 0) });
    else if (c.name === 'ext') box = box.copy({ width: OfficeUnits.emu(c.longAttr('cx') ?? 0), height: OfficeUnits.emu(c.longAttr('cy') ?? 0) });
  }
  return [box, turn];
}

/** A group's a:xfrm, as a step from its children's coordinates to `outer`'s, in points. */
function groupFrame(x, outer) {
  let box = new OfficeRect(0, 0, 0, 0);
  let childOffset = [0, 0];
  let childExtent = [0, 0];
  for (const c of x.children()) {
    const length = (name) => OfficeUnits.emu(c.longAttr(name) ?? 0);
    switch (c.name) {
      case 'off': box = box.copy({ x: length('x'), y: length('y') }); break;
      case 'ext': box = box.copy({ width: length('cx'), height: length('cy') }); break;
      case 'chOff': childOffset = [length('x'), length('y')]; break;
      case 'chExt': childExtent = [length('cx'), length('cy')]; break;
      default: break;
    }
  }
  const frame = new GroupFrame(box, childOffset, childExtent);
  return (r) => outer(frame.place(r));
}

/** Where a VML shape positioned absolutely goes, from its `css`: across when `horizontal`, else down. */
function vmlPosition(css, horizontal) {
  const axis = horizontal ? 'horizontal' : 'vertical';
  let from;
  switch (css[`mso-position-${axis}-relative`]) {
    case 'page': from = 'page'; break;
    case 'margin': from = 'margin'; break;
    case 'left-margin-area': case 'inner-margin-area': from = horizontal ? 'leftMargin' : 'topMargin'; break;
    case 'right-margin-area': case 'outer-margin-area': from = horizontal ? 'rightMargin' : 'bottomMargin'; break;
    case 'top-margin-area': from = 'topMargin'; break;
    case 'bottom-margin-area': from = 'bottomMargin'; break;
    default: from = horizontal ? 'column' : 'paragraph'; break;
  }
  const given = css[horizontal ? 'margin-left' : 'margin-top'] ?? css[horizontal ? 'left' : 'top'];
  const offset = given != null ? OfficeUnits.cssLength(given) ?? 0 : 0;
  const align = css[`mso-position-${axis}`];
  return new Position(from, offset, align != null && align !== 'absolute' ? align : null);
}

/**
 * How much lighter a VML picture is drawn, 0 to 0.9: Word's "Washout" (as for watermarks) lowers the
 * contrast ("gain") and raises the brightness ("blacklevel"), much as a white veil would.
 */
function washout(x) {
  const fraction = (name) => {
    const v = x.attr(name);
    if (v == null) return null;
    const t = trim(v);
    const number = (s) => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Math.fround(Number(s)) : null);
    if (t.endsWith('f')) {
      const n = number(t.slice(0, -1));
      return n == null ? null : Math.fround(n / 65536);
    }
    return number(t);
  };
  const gain = fraction('gain');
  if (gain == null) return 0;
  const black = fraction('blacklevel');
  if (black == null) return 0;
  return gain < 1 && black > 0 ? Math.min(0.9, Math.max(0, 1 - gain)) : 0;
}
