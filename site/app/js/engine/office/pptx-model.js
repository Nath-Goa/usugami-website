// What PowerPoint slides are made of, read from their XML: the reading half of the app's
// PptxConverter.kt (shapes, pictures, groups, graphic frames, tables, text bodies, list styles and
// table styles). Drawing is in pptx.js, text layout in pptx-text.js, tables in pptx-table.js.
//
// Lengths are points; colours ARGB numbers; a "look" is a set of properties where null means "not
// set here" (inherited from the next look in a chain), as Kotlin's nullable fields.
import { readColor, readFill, readOutline, readXfrm, readGuide, readCustom, Fill } from './drawingml.js';
import { OfficeUnits } from './office-formats.js';
import { LineSpacing } from '../text/index.js';

const f = Math.fround;

/** Far more columns and rows than PowerPoint lets a table have (75 each): only a crafted file has more. */
export const MAX_COLUMNS = 1000;
export const MAX_ROWS = 1000;

/** A text body's `vertical` for vert="eaVert", and for PowerPoint's stacked letters. */
export const EAST_ASIAN = 2;
export const STACKED = 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------------------------
// Colour maps and colours

/** The colour map keys a master's p:clrMap (or a p:clrMapOvr) maps. */
const MAP_KEYS = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** A colour map (a Map) as a string, equal for maps with the same entries (Kotlin's Map equality). */
export function mapKey(map) {
  if (map == null) return 'null';
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * The colour map of a part's root element `x`: a master's p:clrMap, or a layout's or slide's
 * override of its master's (p:clrMapOvr/a:overrideClrMapping); null when there's none.
 */
export function readColorMap(x) {
  if (!x) return null;
  let map = null;
  const read = (el) => {
    const m = new Map();
    for (const key of MAP_KEYS) {
      const v = el.attr(key);
      if (v != null) m.set(key, v);
    }
    return m;
  };
  for (const c of x.children()) {
    if (c.name === 'clrMap') map = read(c);
    else if (c.name === 'clrMapOvr') for (const o of c.children()) if (o.name === 'overrideClrMapping') map = read(o);
  }
  return map;
}

/** Colours by scheme name, for the master a part belongs to (the app's Ctx). */
export class Ctx {
  constructor(pkg, part, theme, colorMap = new Map()) {
    this.pkg = pkg;
    this.part = part;
    this.theme = theme;
    this.colorMap = colorMap;
    this.scheme = (name) => {
      let mapped = this.colorMap.get(name);
      if (mapped == null) {
        switch (name) {
          case 'bg1': mapped = 'lt1'; break;
          case 'tx1': mapped = 'dk1'; break;
          case 'bg2': mapped = 'lt2'; break;
          case 'tx2': mapped = 'dk2'; break;
          default: mapped = name;
        }
      }
      return this.theme.colors.get(mapped) ?? null;
    };
  }

  color(x) {
    return readColor(x, this.scheme);
  }

  fill(x) {
    return readFill(x, this.pkg, this.part, this.scheme);
  }

  outline(x) {
    return readOutline(x, this.scheme);
  }

  /** The same colours for shapes of another part (a SmartArt drawing's, a table style's). */
  forPart(part) {
    return new Ctx(this.pkg, part, this.theme, this.colorMap);
  }
}

// ---------------------------------------------------------------------------------------------
// Looks, and how they inherit

/** A run's look (RunLook): size (points), bold, italic, underline, strike, color, font, baseline (1, -1, 0), caps, highlight, spacing (points), symbol. */
export function runLook(fields = {}) {
  return {
    size: null, bold: null, italic: null, underline: null, strike: null, color: null, font: null,
    baseline: null, caps: null, highlight: null, spacing: null, symbol: null, ...fields,
  };
}

/** `look` over `base`: its own properties, and `base`'s where it has none (RunLook.over). */
export function runOver(look, base) {
  if (base == null) return look;
  const out = {};
  for (const k of Object.keys(look)) out[k] = look[k] ?? base[k];
  return out;
}

/** A paragraph level's look (LevelLook): indents, alignment, spacing, bullet and run defaults. */
export function levelLook(fields = {}) {
  return {
    marL: null, indent: null, align: null, line: null, before: null, after: null, bullet: null,
    bulletColor: null, bulletSize: null, bulletFont: null, run: null, rtl: null, ...fields,
  };
}

/** `look` over `base` (LevelLook.over). */
export function levelOver(look, base) {
  if (base == null) return look;
  return {
    marL: look.marL ?? base.marL,
    indent: look.indent ?? base.indent,
    align: look.align ?? base.align,
    line: look.line ?? base.line,
    before: look.before ?? base.before,
    after: look.after ?? base.after,
    bullet: look.bullet ?? base.bullet,
    bulletColor: look.bulletColor ?? base.bulletColor,
    bulletSize: look.bulletSize ?? base.bulletSize,
    bulletFont: look.bulletFont ?? base.bulletFont,
    run: (look.run ? runOver(look.run, base.run) : null) ?? base.run,
    rtl: look.rtl ?? base.rtl,
  };
}

/**
 * A text body's look (BodyLook): insets [left, top, right, bottom] (points), anchor (0 top,
 * 1 middle, 2 bottom), wrap, autofit (0 none, 1 shrink text on overflow, 2 resize shape),
 * fontScale and lineReduction (shares), vertical (0 across, 1 down, -1 up, EAST_ASIAN, STACKED),
 * firstLastSpacing.
 */
export function bodyLook(fields = {}) {
  return {
    insets: [null, null, null, null], anchor: null, wrap: null, autofit: null, fontScale: null,
    lineReduction: null, vertical: null, firstLastSpacing: null, ...fields,
  };
}

/** `look` over `base` (BodyLook.over). */
export function bodyOver(look, base) {
  if (base == null) return look;
  return {
    insets: [0, 1, 2, 3].map((i) => look.insets[i] ?? base.insets[i]),
    anchor: look.anchor ?? base.anchor,
    wrap: look.wrap ?? base.wrap,
    autofit: look.autofit ?? base.autofit,
    fontScale: look.fontScale ?? base.fontScale,
    lineReduction: look.lineReduction ?? base.lineReduction,
    vertical: look.vertical ?? base.vertical,
    firstLastSpacing: look.firstLastSpacing ?? base.firstLastSpacing,
  };
}

/** spcPts (points) or spcPct (a share of the font size) as points (Gap.points). */
export function gapPoints(gap, fontSize) {
  return gap.points ?? f(f(f((gap.share ?? 0) * fontSize)) * f(1.2));
}

/** Whether a text body has anything to draw: a field, a break, or text that isn't blank. */
export function hasText(body) {
  return body.paragraphs.some((p) => p.pieces.some((piece) => piece.kind !== 'text' || /\S/u.test(piece.text)));
}

// ---------------------------------------------------------------------------------------------
// Text

/** DrawingML's alignments as the text engine's (l and r are left and right; pptx-text flips them for right to left). */
function alignOf(value) {
  switch (value) {
    case 'ctr': return 'center';
    case 'r': return 'end';
    case 'just': case 'dist': case 'justLow': case 'thaiDist': return 'justify';
    case 'l': return 'start';
    default: return null;
  }
}

/** a:defRPr, a:rPr, a:endParaRPr: a run's look. */
export function readRunLook(x, ctx) {
  const pct = x.percentAttr('baseline');
  const sz = x.intAttr('sz');
  const spc = x.intAttr('spc');
  const u = x.attr('u');
  const strike = x.attr('strike');
  const cap = x.attr('cap');
  let look = runLook({
    size: sz != null ? f(sz / 100) : null,
    bold: x.attr('b') != null ? x.flag('b') : null,
    italic: x.attr('i') != null ? x.flag('i') : null,
    underline: u != null ? u !== 'none' : null,
    strike: strike != null ? strike !== 'noStrike' : null,
    baseline: pct != null ? (pct > 0 ? 1 : pct < 0 ? -1 : 0) : null,
    caps: cap != null ? cap === 'all' || cap === 'small' : null,
    spacing: spc != null ? f(spc / 100) : null,
  });
  for (const c of x.children()) {
    switch (c.name) {
      case 'solidFill':
        for (const col of c.children()) {
          const v = ctx.color(col);
          if (v != null) look = { ...look, color: v };
        }
        break;
      case 'gradFill': {
        const main = Fill.mainColor(ctx.fill(c));
        if (main != null) look = { ...look, color: main };
        break;
      }
      case 'highlight':
        for (const col of c.children()) {
          const v = ctx.color(col);
          if (v != null) look = { ...look, highlight: v };
        }
        break;
      case 'latin': {
        const face = c.attr('typeface');
        if (face) look = { ...look, font: face };
        break;
      }
      case 'sym': {
        const face = c.attr('typeface');
        if (face) look = { ...look, symbol: face };
        break;
      }
      case 'hlinkClick': {
        // A link shows in the theme's link colour, underlined, whatever the text's own colour,
        // unless it's set to keep it (ahyp:hlinkClr val="tx", PowerPoint 2019).
        let ownColor = false;
        c.descendants((d) => {
          if (d.name === 'hlinkClr') {
            ownColor = d.attr('val') === 'tx';
            return false;
          }
          return true;
        });
        if (!ownColor) look = { ...look, color: ctx.scheme('hlink') ?? look.color, underline: look.underline ?? true };
        break;
      }
      default: break;
    }
  }
  return look;
}

/** a:pPr, a:lvlNpPr, a:defPPr: a paragraph level's look. */
export function readLevelLook(x, ctx) {
  const marL = x.longAttr('marL');
  const indent = x.longAttr('indent');
  let look = levelLook({
    marL: marL != null ? OfficeUnits.emu(marL) : null,
    indent: indent != null ? OfficeUnits.emu(indent) : null,
    align: alignOf(x.attr('algn')),
    rtl: x.attr('rtl') != null ? x.flag('rtl') : null,
  });
  const gap = (el) => {
    let g = null;
    for (const c of el.children()) {
      if (c.name === 'spcPts') g = { points: f((c.intAttr('val') ?? 0) / 100), share: null };
      else if (c.name === 'spcPct') g = { points: null, share: f((c.percentAttr('val') ?? 0) / 100000) };
    }
    return g;
  };
  for (const c of x.children()) {
    switch (c.name) {
      case 'lnSpc': {
        const g = gap(c);
        if (g) look = { ...look, line: g.points != null ? LineSpacing.exact(g.points) : LineSpacing.multiple(g.share ?? 1) };
        break;
      }
      case 'spcBef': look = { ...look, before: gap(c) }; break;
      case 'spcAft': look = { ...look, after: gap(c) }; break;
      case 'buNone': look = { ...look, bullet: { type: 'none' } }; break;
      case 'buChar': look = { ...look, bullet: { type: 'char', text: c.attr('char') ?? '•' } }; break;
      case 'buAutoNum': look = { ...look, bullet: { type: 'number', scheme: c.attr('type') ?? 'arabicPeriod', start: c.intAttr('startAt') ?? 1 } }; break;
      case 'buBlip': look = { ...look, bullet: { type: 'char', text: '•' } }; break;
      case 'buFont': look = { ...look, bulletFont: c.attr('typeface') }; break;
      case 'buSzPct': look = { ...look, bulletSize: f((c.percentAttr('val') ?? 100000) / 100000) }; break;
      case 'buClr': {
        let color = null;
        for (const col of c.children()) color = ctx.color(col) ?? color;
        look = { ...look, bulletColor: color };
        break;
      }
      case 'defRPr': look = { ...look, run: readRunLook(c, ctx) }; break;
      default: break;
    }
  }
  return look;
}

/**
 * a:lstStyle, p:titleStyle and the like, a:defaultTextStyle: each level's look (a Map from 0..8).
 * a:defPPr is the default for every level.
 */
export function readLevels(x, ctx) {
  const levels = new Map();
  for (const c of x.children()) {
    let level = null;
    if (c.name === 'defPPr') level = -1;
    else if (c.name.startsWith('lvl') && c.name.endsWith('pPr')) {
      const digits = c.name.slice(3, -3);
      if (/^[+-]?\d+$/.test(digits) && Math.abs(Number(digits)) <= 2147483647) level = Number(digits) - 1;
    }
    if (level == null) continue;
    levels.set(level, readLevelLook(c, ctx));
  }
  if (!levels.has(-1)) return levels;
  const def = levels.get(-1);
  levels.delete(-1);
  const out = new Map();
  for (let i = 0; i <= 8; i++) out.set(i, levelOver(levels.get(i) ?? levelLook(), def));
  return out;
}

function anchorOf(value) {
  switch (value) {
    case 'ctr': return 1;
    case 'b': return 2;
    case 't': return 0;
    default: return null;
  }
}

/** a:bodyPr: a text body's look. */
export function readBodyLook(x) {
  const insets = ['lIns', 'tIns', 'rIns', 'bIns'].map((key) => {
    const v = x.longAttr(key);
    return v != null ? OfficeUnits.emu(v) : null;
  });
  const wrapAttr = x.attr('wrap');
  let vertical = null;
  switch (x.attr('vert')) {
    case 'vert': vertical = 1; break;
    case 'eaVert': vertical = EAST_ASIAN; break;
    case 'wordArtVert': case 'wordArtVertRtl': vertical = STACKED; break;
    case 'vert270': vertical = -1; break;
    case 'horz': vertical = 0; break;
    default: vertical = null;
  }
  let autofit = null;
  let fontScale = null;
  let lineReduction = null;
  for (const c of x.children()) {
    if (c.name === 'noAutofit') autofit = 0;
    else if (c.name === 'normAutofit') {
      autofit = 1;
      const scale = c.percentAttr('fontScale');
      const reduction = c.percentAttr('lnSpcReduction');
      fontScale = scale != null ? f(scale / 100000) : null;
      lineReduction = reduction != null ? f(reduction / 100000) : null;
    } else if (c.name === 'spAutoFit') autofit = 2;
  }
  return bodyLook({
    insets,
    anchor: anchorOf(x.attr('anchor')),
    wrap: wrapAttr != null ? wrapAttr !== 'none' : null,
    autofit,
    fontScale,
    lineReduction,
    vertical,
    firstLastSpacing: x.attr('spcFirstLastPara') != null ? x.flag('spcFirstLastPara') : null,
  });
}

/** The look and text of a run-like element (a:r, a:fld): [look, text]. */
function runParts(x, ctx) {
  let look = null;
  let text = '';
  for (const c of x.children()) {
    if (c.name === 'rPr') look = readRunLook(c, ctx);
    else if (c.name === 't') text += c.text();
  }
  return [look, text];
}

/**
 * a:p: { level (0..8), look, pieces: [{ kind: 'text' | 'break' | 'slidenum', text, look }], end
 * (the paragraph mark's run look), math (it has an equation, which can't be drawn) }.
 */
export function readParagraph(x, ctx) {
  let level = 0;
  let look = null;
  let end = null;
  let math = false;
  const pieces = [];
  for (const c of x.children()) {
    switch (c.name) {
      case 'm': math = true; break;
      case 'pPr':
        level = clamp(c.intAttr('lvl') ?? 0, 0, 8);
        look = readLevelLook(c, ctx);
        break;
      case 'r': {
        const [run, text] = runParts(c, ctx);
        pieces.push({ kind: 'text', text, look: run });
        break;
      }
      case 'br': {
        let run = null;
        for (const r of c.children()) if (r.name === 'rPr') run = readRunLook(r, ctx);
        pieces.push({ kind: 'break', text: '\n', look: run });
        break;
      }
      case 'fld': {
        const [run, text] = runParts(c, ctx);
        pieces.push({ kind: c.attr('type') === 'slidenum' ? 'slidenum' : 'text', text, look: run });
        break;
      }
      case 'endParaRPr': end = readRunLook(c, ctx); break;
      default: break;
    }
  }
  return { level, look, pieces, end, math };
}

/** p:txBody, a:txBody: { look, levels, paragraphs }. */
export function readBody(x, ctx) {
  let look = bodyLook();
  let levels = new Map();
  const paragraphs = [];
  for (const c of x.children()) {
    if (c.name === 'bodyPr') look = readBodyLook(c);
    else if (c.name === 'lstStyle') levels = readLevels(c, ctx);
    else if (c.name === 'p') paragraphs.push(readParagraph(c, ctx));
  }
  return { look, levels, paragraphs };
}

// ---------------------------------------------------------------------------------------------
// Shapes

/** The kinds of shape: SHAPE (p:sp, p:cxnSp), PICTURE, GROUP, TABLE, GRAPHIC (charts and objects not known). */
export const Kind = Object.freeze({ SHAPE: 'shape', PICTURE: 'picture', GROUP: 'group', TABLE: 'table', GRAPHIC: 'graphic' });

/** A shape as the converter keeps it (PptxConverter.Shape), with every field Kotlin defaults. */
export function shapeOf(fields) {
  return {
    kind: Kind.SHAPE, name: '', caption: null, hidden: false, ph: null, xfrm: null, geometry: null, custom: null,
    adjust: new Map(), fill: null, groupFill: false, line: null, styleFill: null, styleLine: null, styleFont: null,
    body: null, textRect: null, children: [], childOffset: [0, 0], childExtent: [0, 0], table: null, chart: false,
    ...fields,
  };
}

/** p:cNvPr's caption (its description, else its title), name and hidden flag. */
function readCNvPr(c) {
  const descr = c.attr('descr');
  const title = c.attr('title');
  return {
    name: c.attr('name') ?? '',
    caption: descr && /\S/u.test(descr) ? descr : title && /\S/u.test(title) ? title : null,
    hidden: c.flag('hidden', false),
  };
}

function readPh(nvPr) {
  let ph = null;
  for (const c of nvPr.children()) if (c.name === 'ph') ph = { type: c.attr('type') ?? 'obj', idx: c.intAttr('idx') };
  return ph;
}

/**
 * Reads PowerPoint shapes: `hooks` gives what needs the package's other parts (chart titles,
 * SmartArt drawings), as async lookups done before reading (see ShapeReader).
 */
export class ShapeReader {
  /**
   * `parts`: { chartTitle(ctx, relId) → string | null, smartArt(ctx, relId) → shapes | null }, both
   * synchronous over what was loaded beforehand (prefetch()).
   */
  constructor(parts) {
    this.parts = parts;
  }

  /** p:spTree, a group's or an mc:Choice's children: their shapes. */
  readShapes(x, ctx) {
    const shapes = [];
    for (const c of x.children()) {
      if (c.name === 'AlternateContent') shapes.push(...this.readAlternate(c, ctx));
      else {
        const s = this.readShape(c, ctx);
        if (s) shapes.push(s);
      }
    }
    return shapes;
  }

  /**
   * mc:AlternateContent: the shapes of its first mc:Choice, or those of its mc:Fallback when the
   * choice has something that can't be drawn here (ink, equations, 3-D models, Slide Zooms...),
   * which the fallback has as a picture.
   */
  readAlternate(x, ctx) {
    let choice = null;
    let fallback = [];
    for (const c of x.children()) {
      if (c.name === 'Choice') { if (choice == null) choice = this.readShapes(c, ctx); }
      else if (c.name === 'Fallback') fallback = this.readShapes(c, ctx);
    }
    const chosen = choice ?? [];
    return fallback.length && (!chosen.length || !chosen.every(drawable)) ? fallback : chosen;
  }

  readShape(x, ctx) {
    switch (x.name) {
      case 'sp': case 'cxnSp': case 'pic': return this.readSp(x, ctx);
      case 'grpSp': return this.readGroup(x, ctx);
      case 'graphicFrame': return this.readFrame(x, ctx);
      default: return null;
    }
  }

  readSp(x, ctx) {
    const isPicture = x.name === 'pic';
    let nv = { name: '', caption: null, hidden: false };
    let ph = null;
    let xfrm = null;
    let geometry = null;
    let custom = null;
    const adjust = new Map();
    let fill = null;
    let groupFill = false;
    let line = null;
    let styleFill = null;
    let styleLine = null;
    let styleFont = null;
    let body = null;
    let textRect = null;
    let picture = null;
    for (const c of x.children()) {
      switch (c.name) {
        case 'nvSpPr': case 'nvCxnSpPr': case 'nvPicPr':
          for (const n of c.children()) {
            if (n.name === 'cNvPr') nv = readCNvPr(n);
            else if (n.name === 'nvPr') ph = readPh(n) ?? ph;
          }
          break;
        case 'spPr':
          for (const p of c.children()) {
            switch (p.name) {
              case 'xfrm': xfrm = readXfrm(p); break;
              case 'prstGeom':
                geometry = p.attr('prst');
                for (const list of p.children('avLst')) {
                  for (const gd of list.children()) {
                    const g = readGuide(gd);
                    if (g) adjust.set(g[0], g[1]);
                  }
                }
                break;
              case 'custGeom': custom = readCustom(p); break;
              case 'ln': line = ctx.outline(p); break;
              case 'grpFill': groupFill = true; break;
              default: {
                const v = ctx.fill(p);
                if (v) fill = v;
              }
            }
          }
          break;
        case 'style':
          for (const ref of c.children()) {
            const idx = ref.intAttr('idx') ?? 0;
            for (const col of ref.children()) {
              const color = ctx.color(col);
              if (ref.name === 'fillRef') { if (idx > 0) styleFill = color; }
              else if (ref.name === 'lnRef') { if (idx > 0) styleLine = color; }
              else if (ref.name === 'fontRef') styleFont = color;
            }
          }
          break;
        case 'txBody': body = readBody(c, ctx); break;
        case 'txXfrm': textRect = readXfrm(c).rect; break;
        case 'blipFill': picture = ctx.fill(c); break;
        default: break;
      }
    }
    return shapeOf({
      kind: isPicture ? Kind.PICTURE : Kind.SHAPE,
      name: nv.name, caption: nv.caption, hidden: nv.hidden, ph, xfrm, geometry, custom, adjust,
      fill: isPicture ? picture : fill,
      groupFill: groupFill && !isPicture,
      line, styleFill, styleLine, styleFont, body, textRect,
    });
  }

  readGroup(x, ctx) {
    let name = '';
    let hidden = false;
    let xfrm = null;
    let fill = null;
    let groupFill = false;
    const children = [];
    for (const c of x.children()) {
      switch (c.name) {
        case 'nvGrpSpPr':
          for (const n of c.children()) {
            if (n.name === 'cNvPr') {
              name = n.attr('name') ?? '';
              hidden = n.flag('hidden', false);
            }
          }
          break;
        case 'grpSpPr':
          for (const p of c.children()) {
            if (p.name === 'xfrm') xfrm = readXfrm(p);
            // The fill of shapes in the group that take the group's (a:grpFill).
            else if (p.name === 'grpFill') groupFill = true;
            else {
              const v = ctx.fill(p);
              if (v) fill = v;
            }
          }
          break;
        case 'AlternateContent': children.push(...this.readAlternate(c, ctx)); break;
        default: {
          const s = this.readShape(c, ctx);
          if (s) children.push(s);
        }
      }
    }
    const rect = xfrm?.rect ?? null;
    const child = xfrm?.child ?? null;
    return shapeOf({
      kind: Kind.GROUP, name, hidden, xfrm, children, fill, groupFill,
      childOffset: child?.offset ?? (rect ? [rect.x, rect.y] : [0, 0]),
      childExtent: child?.extent ?? (rect ? [rect.width, rect.height] : [0, 0]),
    });
  }

  readFrame(x, ctx) {
    let nv = { name: '', caption: null, hidden: false };
    let ph = null;
    let xfrm = null;
    let table = null;
    let drawing = null;
    let chart = false;
    let preview = null;
    for (const c of x.children()) {
      if (c.name === 'nvGraphicFramePr') {
        for (const n of c.children()) {
          if (n.name === 'cNvPr') nv = readCNvPr(n);
          else if (n.name === 'nvPr') ph = readPh(n) ?? ph;
        }
      } else if (c.name === 'xfrm') {
        xfrm = readXfrm(c);
      } else if (c.name === 'graphic') {
        for (const data of c.children('graphicData')) {
          const uri = data.attr('uri') ?? '';
          for (const g of data.children()) {
            if (g.name === 'tbl') table = readTable(g, ctx);
            else if (g.name === 'chart') {
              chart = true;
              nv = { ...nv, caption: nv.caption ?? this.parts.chartTitle(ctx, g.relId()) };
            } else if (g.name === 'relIds' && uri.includes('diagram')) {
              drawing = this.parts.smartArt(ctx, g.relId('dm'));
            } else if (g.name === 'oleObj') {
              // An embedded object (an Excel sheet, an old equation...): the picture of it saved with it.
              preview = preview ?? this.olePreview(g, ctx);
            } else if (g.name === 'AlternateContent') {
              for (const branch of g.children()) {
                for (const o of branch.children()) if (o.name === 'oleObj') preview = preview ?? this.olePreview(o, ctx);
              }
            }
          }
        }
      }
    }
    const rect = xfrm?.rect ?? null;
    if (drawing != null && rect != null) {
      return shapeOf({ kind: Kind.GROUP, name: nv.name, hidden: nv.hidden, xfrm, children: drawing, childOffset: [0, 0], childExtent: [rect.width, rect.height] });
    }
    if (preview != null) return shapeOf({ kind: Kind.PICTURE, name: nv.name, caption: nv.caption, hidden: nv.hidden, ph, xfrm, fill: preview });
    return shapeOf({ kind: table ? Kind.TABLE : Kind.GRAPHIC, name: nv.name, caption: nv.caption, hidden: nv.hidden, ph, xfrm, table, chart });
  }

  /** The picture p:oleObj keeps of an embedded object, or null. */
  olePreview(x, ctx) {
    let preview = null;
    for (const c of x.children()) {
      if (c.name === 'pic') {
        const fill = this.readSp(c, ctx).fill;
        if (fill?.type === 'image') preview = fill;
      }
    }
    return preview;
  }
}

/** Whether `shape` can be drawn as it shows in PowerPoint (a chart as its grey box). */
export function drawable(shape) {
  switch (shape.kind) {
    case Kind.GRAPHIC: return shape.chart;
    case Kind.GROUP: return shape.children.every(drawable);
    default: return shape.body ? !shape.body.paragraphs.some((p) => p.math) : true;
  }
}

/**
 * The relationship ids a part's shapes refer to for charts and SmartArt, found before the part is
 * read so those parts can be loaded first: { charts: Set, diagrams: Set } (the data parts' ids).
 */
export function partReferences(x) {
  const charts = new Set();
  const diagrams = new Set();
  x.descendants((d) => {
    if (d.name === 'graphicData') {
      const uri = d.attr('uri') ?? '';
      for (const g of d.children()) {
        if (g.name === 'chart') { const id = g.relId(); if (id != null) charts.add(id); }
        else if (g.name === 'relIds' && uri.includes('diagram')) { const id = g.relId('dm'); if (id != null) diagrams.add(id); }
      }
      return false;
    }
    return true;
  });
  return { charts, diagrams };
}

// ---------------------------------------------------------------------------------------------
// Tables

/** a:tbl: { grid (points), rows: [[height, cells]], styleId, flags (Set), rtl }. */
export function readTable(x, ctx) {
  const grid = [];
  const rows = [];
  let styleId = null;
  const flags = new Set();
  let rtl = false;
  for (const c of x.children()) {
    if (c.name === 'tblPr') {
      rtl = c.flag('rtl', false);
      for (const flag of ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol']) if (c.flag(flag, false)) flags.add(flag);
      for (const s of c.children()) if (s.name === 'tableStyleId') styleId = s.text().trim();
    } else if (c.name === 'tblGrid') {
      for (const col of c.children()) if (col.name === 'gridCol' && grid.length < MAX_COLUMNS) grid.push(OfficeUnits.emu(col.longAttr('w') ?? 0));
    } else if (c.name === 'tr') {
      const height = OfficeUnits.emu(c.longAttr('h') ?? 0);
      const cells = [];
      for (const tc of c.children()) {
        if (tc.name !== 'tc') continue;
        let body = null;
        let fill = null;
        const borders = [null, null, null, null];
        const margins = [null, null, null, null];
        let anchor = null;
        for (const p of tc.children()) {
          if (p.name === 'txBody') body = readBody(p, ctx);
          else if (p.name === 'tcPr') {
            ['marL', 'marT', 'marR', 'marB'].forEach((key, i) => {
              const v = p.longAttr(key);
              if (v != null) margins[i] = OfficeUnits.emu(v);
            });
            anchor = anchorOf(p.attr('anchor'));
            for (const b of p.children()) {
              switch (b.name) {
                case 'lnL': borders[0] = ctx.outline(b); break;
                case 'lnT': borders[1] = ctx.outline(b); break;
                case 'lnR': borders[2] = ctx.outline(b); break;
                case 'lnB': borders[3] = ctx.outline(b); break;
                default: {
                  const v = ctx.fill(b);
                  if (v) fill = v;
                }
              }
            }
          }
        }
        cells.push({
          body,
          span: clamp(tc.intAttr('gridSpan') ?? 1, 1, MAX_COLUMNS),
          rowSpan: clamp(tc.intAttr('rowSpan') ?? 1, 1, MAX_ROWS),
          hMerge: tc.flag('hMerge', false),
          vMerge: tc.flag('vMerge', false),
          fill, borders, margins, anchor,
        });
      }
      rows.push([height, cells]);
    }
  }
  return { grid, rows, styleId, flags, rtl };
}

/** A part of a table style (wholeTbl, firstRow, band1H...): { fill, borders (Map side → Outline), bold, color }. */
export function readTableStylePart(x, ctx) {
  let fill = null;
  const borders = new Map();
  let bold = null;
  let color = null;
  for (const c of x.children()) {
    if (c.name === 'tcTxStyle') {
      const b = c.attr('b');
      bold = b != null ? b === 'on' : null;
      for (const t of c.children()) {
        if (t.name === 'fontRef') {
          for (const col of t.children()) { const v = ctx.color(col); if (v != null) color = v; }
        } else {
          const v = ctx.color(t);
          if (v != null) color = v;
        }
      }
    } else if (c.name === 'tcStyle') {
      for (const s of c.children()) {
        if (s.name === 'tcBdr') {
          for (const side of s.children()) for (const ln of side.children()) if (ln.name === 'ln') borders.set(side.name, ctx.outline(ln));
        } else if (s.name === 'fill') {
          for (const v of s.children()) { const fl = ctx.fill(v); if (fl) fill = fl; }
        } else if (s.name === 'fillRef') {
          for (const v of s.children()) { const col = ctx.color(v); if (col != null) fill = Fill.solid(col); }
        }
      }
    }
  }
  return { fill, borders, bold, color };
}

/** a:tblStyleLst: the styles by id, each a Map of its parts. */
export function readTableStyles(x, ctx) {
  const found = new Map();
  for (const s of x.children()) {
    if (s.name !== 'tblStyle') continue;
    const id = s.attr('styleId');
    if (id == null) continue;
    const parts = new Map();
    for (const p of s.children()) parts.set(p.name, readTableStylePart(p, ctx));
    found.set(id, { parts });
  }
  return found;
}

/** p:bg: the slide's (or layout's, or master's) background fill, or null. */
export function readBackground(x, ctx) {
  let fill = null;
  for (const c of x.children()) {
    if (c.name === 'bgPr') {
      for (const p of c.children()) {
        const v = ctx.fill(p);
        if (v && fill == null) fill = v;
      }
    } else if (c.name === 'bgRef') {
      for (const p of c.children()) {
        const v = ctx.color(p);
        if (v != null) fill = Fill.solid(v);
      }
    }
  }
  return fill;
}

/**
 * A chart part's title, to show in its grey box (`x` its root, c:chartSpace): the text of the
 * first c:title in c:chart or c:plotArea; null when there's none.
 */
export function chartTitleOf(x) {
  let title = '';
  const texts = (el) => {
    for (const c of el.children()) {
      if (c.name === 't') title += c.text();
      else texts(c);
    }
  };
  const find = (el) => {
    for (const c of el.children()) {
      if (c.name === 'title') texts(c);
      else if (!title && (c.name === 'chart' || c.name === 'plotArea')) find(c);
    }
  };
  find(x);
  const t = title.trim();
  return t || null;
}

/** The relationship id of a SmartArt data part's drawing (dsp:dataModelExt relId), or null. */
export function smartArtDrawingId(x) {
  let id = null;
  const find = (el) => {
    for (const c of el.children()) {
      if (c.name === 'dataModelExt') id = c.attr('relId');
      else if (id == null) find(c);
    }
  };
  find(x);
  return id;
}
