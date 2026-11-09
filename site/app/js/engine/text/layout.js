// Paragraph layout, as Android's StaticLayout does it for the app (OfficeText.kt's ParagraphBlock):
// rich text in runs of different looks, shaped with the bundled fonts, broken into lines at the
// places lines may break, aligned, justified, spaced and indented; ready to be drawn into a PDF
// (canvas.js) or onto a screen canvas (paint.js), whole or a few lines at a time across pages.
// All lengths are in points.
import { resolveStyle, ensureFonts, loadedFont, pickFont, graphemes, fileMetrics, isEmoji } from './fonts.js';
import { shape } from './shaping.js';
import { lineBreaks, isHangingSpace } from './linebreak.js';
import { bidiLevels, firstStrong, visualOrder, mirrored } from './bidi.js';
import { fallbackMetrics } from './fallback.js';
import { parseColor } from './color.js';
import { paintLayout } from './paint.js';

/** The character an inline object (a picture) takes in the text. */
export const OBJECT = '\uFFFC';

/** How far apart a paragraph's lines are (OfficeText.kt's LineSpacing). */
export const LineSpacing = Object.freeze({
  /** Single spacing. */
  SINGLE: Object.freeze({ type: 'multiple', value: 1 }),
  /** A multiple of the font's own line height (1 is single spacing). */
  multiple: (factor) => ({ type: 'multiple', value: factor }),
  /** Exactly this many points from line to line. */
  exact: (points) => ({ type: 'exact', value: points }),
  /** The font's own line height, but at least this many points. */
  atLeast: (points) => ({ type: 'atLeast', value: points }),
});

const EPS = 1e-6;
const ELLIPSIS = '\u2026';
const BREAK_CHARS = new Set(['\n', '\r', '\r\n', '\u000B', '\u000C', '\u0085', '\u2028', '\u2029']);
const WORD_SPACES = new Set([' ', '\u00A0']);

// ---- Rich text (OfficeText.kt's RichText) ----

/** Text with each run's look attached. `behind` is the shading under it, for styles with autoColor. */
export class RichText {
  constructor({ behind = null } = {}) {
    this.behind = behind;
    this.text = '';
    /** [{ start, end, style (resolved), obj? }] covering the text, in order. */
    this.spans = [];
  }

  get length() {
    return this.text.length;
  }

  get isEmpty() {
    return this.text.length === 0;
  }

  /** Whether there's anything but spaces: an inline picture counts. */
  get hasContent() {
    return /\S/u.test(this.text);
  }

  /** Adds `s` in `style` (capitals and small capitals are written in capitals). Returns this. */
  append(s, style = {}) {
    if (s == null || s === '') return this;
    const r = resolveStyle(style, this.behind);
    const shown = r.caps || r.smallCaps ? String(s).toUpperCase() : String(s);
    const start = this.text.length;
    this.text += shown;
    this.spans.push({ start, end: this.text.length, style: r });
    return this;
  }

  /**
   * Adds an object drawn inline, sitting on the baseline like a large letter: `obj` is
   * { width, height, draw(target, { x, y, width, height }) }, where target is the PdfCanvas or
   * screen canvas the paragraph is drawn on. Returns this.
   */
  appendObject(obj, style = {}) {
    const start = this.text.length;
    this.text += OBJECT;
    this.spans.push({ start, end: this.text.length, style: resolveStyle(style, this.behind), obj });
    return this;
  }

  /** The (resolved) style at offset `index`. */
  styleAt(index) {
    for (const s of this.spans) if (index >= s.start && index < s.end) return s.style;
    return this.spans[this.spans.length - 1]?.style ?? null;
  }

  /** Text, runs ([{ text, style }]) or a RichText, as a RichText; a string takes `style`. */
  static from(input, style = {}) {
    if (input instanceof RichText) return input;
    const rich = new RichText();
    if (Array.isArray(input)) for (const run of input) {
      if (run && run.obj) rich.appendObject(run.obj, run.style ?? style);
      else rich.append(run?.text ?? '', run?.style ?? style);
    } else rich.append(String(input ?? ''), style);
    return rich;
  }
}

/** `rich` with each inline object wider than `most` points shrunk to that width, keeping its shape. */
export function fitPictures(rich, most) {
  if (!(rich instanceof RichText) || !(most >= 1)) return rich;
  if (!rich.spans.some((s) => s.obj && s.obj.width > most)) return rich;
  const out = new RichText({ behind: rich.behind });
  out.text = rich.text;
  out.spans = rich.spans.map((s) => {
    if (!s.obj || s.obj.width <= most) return s;
    const o = s.obj;
    const narrowed = Object.assign(Object.create(Object.getPrototypeOf(o)), o, { width: most, height: Math.max(1, (o.height * most) / o.width) });
    return { ...s, obj: narrowed };
  });
  return out;
}

// ---- Spec ----

function normSpacing(sp) {
  if (sp == null) return LineSpacing.SINGLE;
  if (typeof sp === 'number') return LineSpacing.multiple(sp);
  if (sp.type) return sp;
  if (sp.multiple != null) return LineSpacing.multiple(sp.multiple);
  if (sp.exact != null) return LineSpacing.exact(sp.exact);
  if (sp.atLeast != null) return LineSpacing.atLeast(sp.atLeast);
  return LineSpacing.SINGLE;
}

function normTab(t) {
  if (typeof t === 'number') return { pos: t, align: 'left', leader: null };
  return { pos: +t.pos || 0, align: t.align ?? 'left', leader: t.leader && t.leader !== 'none' ? t.leader : null };
}

function normRule(r) {
  if (!r) return null;
  return { width: +r.width || 0.5, color: parseColor(r.color) ?? parseColor('#000'), gap: +r.gap || 0 };
}

function normSpec(spec) {
  const base = resolveStyle(spec.base ?? (spec.text instanceof RichText ? spec.text.spans[0]?.style : null) ?? spec.style ?? {});
  const rich = RichText.from(spec.text ?? '', spec.style ?? base);
  const width = typeof spec.width === 'number' && spec.width > 0 ? spec.width : Infinity;
  return {
    rich,
    base,
    width,
    align: spec.align ?? 'start',
    firstIndent: +spec.firstIndent || 0,
    indent: +spec.indent || 0,
    rightIndent: +spec.rightIndent || 0,
    spacing: normSpacing(spec.spacing),
    lineScale: typeof spec.lineScale === 'number' ? spec.lineScale : 1,
    label: spec.label && spec.label.text ? { text: String(spec.label.text), style: resolveStyle(spec.label.style ?? base), x: +spec.label.x || 0 } : null,
    rtl: !!spec.rtl,
    directionFromText: spec.directionFromText ?? true,
    mirrored: !!spec.mirrored,
    background: parseColor(spec.background),
    tabs: (spec.tabs ?? []).map(normTab).sort((a, b) => a.pos - b.pos),
    defaultTab: spec.defaultTab > 0 ? spec.defaultTab : 36,
    avoidSingleLines: spec.avoidSingleLines ?? true,
    ruleAbove: normRule(spec.ruleAbove),
    ruleBelow: normRule(spec.ruleBelow),
    maxLines: spec.maxLines > 0 ? Math.floor(spec.maxLines) : 0,
    ellipsis: spec.ellipsis ?? true,
  };
}

const LEADERS = { dot: '.', hyphen: '-', underscore: '_', middleDot: '\u00B7', heavy: '_' };

/** The text runs a spec draws, for loading their fonts. */
function runsOf(spec) {
  const s = spec.__norm ?? normSpec(spec);
  const runs = s.rich.spans.map((sp) => ({ text: s.rich.text.slice(sp.start, sp.end), style: sp.style }));
  runs.push({ text: ' ', style: s.base });
  if (s.label) runs.push({ text: s.label.text, style: s.label.style });
  if (s.maxLines) for (const sp of s.rich.spans) runs.push({ text: ELLIPSIS, style: sp.style });
  const leaders = s.tabs.filter((t) => t.leader).map((t) => LEADERS[t.leader] ?? '.').join('');
  if (leaders) for (const sp of s.rich.spans) runs.push({ text: leaders, style: sp.style });
  return runs;
}

/** Loads the fonts a paragraph spec needs (the async layout functions do this themselves). */
export async function prepareParagraph(spec) {
  await ensureFonts(runsOf(spec));
}

// ---- Layout ----

/**
 * Lays out a paragraph. `spec` (OfficeText.kt's ParagraphSpec; lengths in points):
 *   text        RichText, a string, or [{ text, style }] runs
 *   base        the paragraph mark's style: an empty paragraph's height (default: the first run's)
 *   style       the style of a plain string `text` (default: base)
 *   width       the paragraph's width (default: unlimited, one line per line break)
 *   align       'start' | 'center' | 'end' | 'justify' (start is left, or right when right to left), or 'left' | 'right'
 *   firstIndent, indent, rightIndent   from the paragraph's left edge to its first line, its other lines, and from its right edge
 *   spacing     LineSpacing.multiple(1) (default), .exact(points) or .atLeast(points)
 *   lineScale   multiple spacing is scaled by this (see lineScale() in fonts.js)
 *   label       { text, style, x }: a list number or bullet drawn before the first line, x points from the left edge
 *   rtl, directionFromText (default true), mirrored   right-to-left paragraphs (see docs/api/text.md)
 *   background  a colour filling the paragraph's box
 *   tabs        stops in points from the left edge: numbers, or { pos, align: 'left'|'center'|'right'|'decimal', leader: 'dot'|'hyphen'|'underscore'|'middleDot' }
 *   defaultTab  stops after the last one, every this many points (default 36)
 *   avoidSingleLines (default true)   keep a lone first or last line from being left at a page break (split())
 *   ruleAbove, ruleBelow   { width, color, gap }: lines drawn in the space above and below
 *   maxLines, ellipsis (default true)   at most this many lines, the last ending in "…" when cut
 * Resolves to a ParagraphLayout.
 */
export async function layoutParagraph(spec) {
  const norm = normSpec(spec);
  await ensureFonts(runsOf({ ...spec, __norm: norm }));
  return new ParagraphLayout(norm, buildCore(norm));
}

/** layoutParagraph() for when the fonts are loaded (prepareParagraph or ensureFonts); throws if they aren't. */
export function layoutParagraphSync(spec) {
  const norm = normSpec(spec);
  return new ParagraphLayout(norm, buildCore(norm));
}

/**
 * One line of text, not wrapped (lines break only at line breaks), measured: { width, ascent,
 * descent, height, ink: { left, top, right, bottom } (relative to the first baseline's start;
 * y down), layout }. For page numbers, watermarks and the like.
 */
export async function measureText(text, style = {}) {
  await ensureFonts(String(text ?? ''), style);
  return measureTextSync(text, style);
}

/** measureText() for when the fonts are loaded. */
export function measureTextSync(text, style = {}) {
  const layout = layoutParagraphSync({ text: String(text ?? ''), base: style, width: Infinity });
  const first = layout.lines[0];
  const ink = layout.inkBounds();
  return {
    width: layout.contentWidth,
    ascent: first ? first.baseline - first.top : 0,
    descent: first ? first.bottom - first.baseline : 0,
    height: layout.height,
    ink: { left: ink.left, right: ink.right, top: ink.top - layout.firstBaseline, bottom: ink.bottom - layout.firstBaseline },
    layout,
  };
}

/** The start and end offset of each cluster of `text`, as one flat list. */
function graphemeOffsets(text) {
  const out = [];
  let at = 0;
  for (const g of graphemes(text)) {
    out.push(at, at + g.length);
    at += g.length;
  }
  return out;
}

function needFont(file) {
  const f = loadedFont(file);
  if (!f) throw new Error(`Font ${file} isn't loaded yet: await ensureFonts(), prepareParagraph() or use the async layout functions`);
  return f;
}

/** Shapes and measures one piece of text (one style, one font, one direction, no break inside). */
function measurePiece(p, text) {
  const st = p.style;
  const S = st.drawnSize;
  const hs = st.scaleX;
  const ls = st.letterSpacing;
  p.width = 0;
  p.trailing = 0;
  p.trailingClusters = 0;
  p.spaceClusters = 0;
  if (p.kind === 'text') {
    const font = needFont(p.file);
    let t = text.slice(p.start, p.end);
    if (p.rtl) t = mirrored(t);
    const features = ls !== 0 ? { ...(st.features ?? {}), liga: false, clig: false } : st.features;
    const sh = shape(font, t, { rtl: p.rtl, features, lang: st.lang });
    p.font = font;
    p.shaped = sh;
    const cw = new Float64Array(sh.clusters.length);
    const space = new Uint8Array(sh.clusters.length);
    let width = 0;
    sh.clusters.forEach((c, i) => {
      let a = 0;
      for (let g = c.g0; g < c.g1; g++) a += sh.adv[g];
      cw[i] = (a * S + ls) * hs;
      width += cw[i];
      const ch = t.slice(c.start, c.end);
      if (WORD_SPACES.has(ch)) space[i] = 1;
      if (isHangingSpace(ch)) space[i] |= 2;
    });
    p.cw = cw;
    p.space = space;
    p.width = width;
    for (let i = sh.clusters.length - 1; i >= 0 && space[i] & 2; i--) {
      p.trailing += cw[i];
      p.trailingClusters++;
    }
    for (let i = 0; i < space.length; i++) if (space[i] & 1) p.spaceClusters++;
  } else if (p.kind === 'fallback') {
    const t = text.slice(p.start, p.end);
    const m = fallbackMetrics(t, st.kind, st.bold, st.italic, p.rtl);
    p.metrics = m;
    p.emoji = isEmoji(t);
    p.width = m ? (m.width * S + ls * p.clusterCount) * hs : p.clusterCount * S * hs;
  } else if (p.kind === 'object') {
    p.width = Math.max(0, +p.obj.width || 0);
  }
}

/** Splits text into pieces: one style, one font, one direction, no line break opportunity inside. */
function itemize(text, spans, breaks, levels) {
  const g = graphemeOffsets(text);
  const pieces = [];
  let si = 0;
  let cur = null;
  for (let k = 0; k < g.length; k += 2) {
    const a = g[k];
    const b = g[k + 1];
    while (si < spans.length - 1 && a >= spans[si].end) si++;
    const span = spans[si];
    const st = span.style;
    const ch = text.slice(a, b);
    let kind;
    let entry = null;
    if (BREAK_CHARS.has(ch)) kind = 'break';
    else if (ch === '\t') kind = 'tab';
    else if (ch === OBJECT && span.obj) kind = 'object';
    else {
      entry = pickFont(st.stack, ch);
      kind = entry ? 'text' : 'fallback';
    }
    const level = levels[a];
    const joins = cur && breaks[a] === 0 && cur.span === span && cur.kind === kind && cur.level === level &&
      (kind === 'text' ? cur.file === entry.file && cur.slant === entry.slant : kind === 'fallback');
    if (joins) {
      cur.end = b;
      cur.clusterCount++;
    } else {
      cur = { start: a, end: b, span, style: st, kind, file: entry?.file ?? null, slant: entry?.slant ?? false, level, rtl: (level & 1) === 1, obj: kind === 'object' ? span.obj : null, clusterCount: 1 };
      pieces.push(cur);
    }
  }
  for (const p of pieces) measurePiece(p, text);
  return pieces;
}

/** Each paragraph of the text (split at line breaks) gets its own direction, as in Android's layout. */
function directions(text, breaks, s) {
  const levels = new Uint8Array(text.length);
  const segments = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || breaks[i] === 2) {
      const seg = text.slice(start, i);
      const rtl = s.rtl || (s.directionFromText && firstStrong(seg) === true);
      levels.set(bidiLevels(seg, rtl), start);
      segments.push({ start, end: i, rtl });
      start = i;
    }
  }
  return { levels, segments };
}

function piecesOfUnits(units) {
  const out = [];
  for (const u of units) for (const p of u.pieces) out.push(p);
  return out;
}

/** Splits piece p at text offset `cut` (a cluster boundary) into two newly shaped pieces. */
function cutPiece(p, cut, text) {
  const count = (a, b) => graphemes(text.slice(a, b)).length;
  const head = { ...p, end: cut, clusterCount: count(p.start, cut) };
  const tail = { ...p, start: cut, clusterCount: count(cut, p.end) };
  measurePiece(head, text);
  measurePiece(tail, text);
  return [head, tail];
}

/** Splits piece p at the text offsets `cuts` (cluster boundaries, in order) into newly shaped pieces. */
function cutPieceMany(p, cuts, text) {
  const bounds = [p.start, ...cuts, p.end];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const q = { ...p, start: bounds[i], end: bounds[i + 1], clusterCount: graphemes(text.slice(bounds[i], bounds[i + 1])).length };
    measurePiece(q, text);
    out.push(q);
  }
  return out;
}

/** The offsets inside piece p where it may be cut (between its clusters), with the width before each. */
function cutsOf(p, text) {
  const out = [];
  if (p.kind === 'text') {
    const cl = p.shaped.clusters;
    let w = 0;
    for (let i = 0; i < cl.length - 1; i++) {
      w += p.cw[i];
      if (!p.rtl) out.push({ at: p.start + cl[i].end, before: w });
    }
  } else if (p.kind === 'fallback' && p.clusterCount > 1) {
    let at = p.start;
    const parts = graphemes(text.slice(p.start, p.end));
    const per = p.width / parts.length;
    for (let i = 0; i < parts.length - 1; i++) {
      at += parts[i].length;
      out.push({ at, before: per * (i + 1) });
    }
  }
  return out;
}

class Breaker {
  constructor(s, text, pieces, breaks, segments) {
    this.s = s;
    this.text = text;
    this.breaks = breaks;
    this.segments = segments;
    const left = Math.min(s.firstIndent, s.indent);
    this.left = left;
    this.layoutWidth = Math.max(1, s.width - left - s.rightIndent);
    this.indents = [Math.max(0, s.firstIndent - left), Math.max(0, s.indent - left)];
    // Tab stops, from the line's start (as Android measures them), then the default ones after the last.
    const stops = s.tabs.map((t) => ({ ...t, pos: t.pos - left })).filter((t) => t.pos > 0);
    const last = stops.length ? stops[stops.length - 1].pos : 0;
    let next = (Math.floor(last / s.defaultTab) + 1) * s.defaultTab;
    for (let i = 0; i < 64; i++, next += s.defaultTab) stops.push({ pos: next, align: 'left', leader: null });
    this.stops = stops;
    this.units = [];
    let cur = null;
    for (const p of pieces) {
      if (!cur) cur = { pieces: [] };
      cur.pieces.push(p);
      if (breaks[p.end] >= 1 || p.end === text.length) {
        cur.mandatory = breaks[p.end] === 2 || p.kind === 'break';
        this.units.push(cur);
        cur = null;
      }
    }
    if (cur) this.units.push(cur);
  }

  avail(index) {
    return this.layoutWidth - this.indents[Math.min(1, index)];
  }

  /** The text width after a tab piece, to the next tab or line break: for right, centre and decimal stops. */
  following(units, ui, pi, decimal) {
    let w = 0;
    for (let u = ui; u < units.length; u++) {
      const ps = units[u].pieces;
      for (let k = u === ui ? pi + 1 : 0; k < ps.length; k++) {
        const p = ps[k];
        if (p.kind === 'tab' || p.kind === 'break') return w;
        if (decimal && p.kind === 'text') {
          const t = this.text.slice(p.start, p.end);
          // The decimal point: a full stop, else a comma (as French and Spanish write it).
          const dot = t.includes('.') ? t.indexOf('.') : t.indexOf(',');
          if (dot >= 0) {
            for (let i = 0; i < p.shaped.clusters.length; i++) {
              if (p.shaped.clusters[i].start >= dot) return w;
              w += p.cw[i];
            }
            return w;
          }
        }
        w += p.width;
      }
    }
    return w;
  }

  /** Sets the widths of the tabs in unit `ui` placed at `x`, and returns its width with and without its hanging spaces. */
  measureUnit(units, ui, x0) {
    const u = units[ui];
    let x = x0;
    u.pieces.forEach((p, pi) => {
      if (p.kind === 'tab') {
        const stop = this.stops.find((t) => t.pos > x + EPS);
        let w;
        if (!stop) w = Math.floor((x + 2) / 2) * 2 - x; // Android's default steps
        else if (stop.align === 'left' || !stop.align) w = stop.pos - x;
        else {
          const f = this.following(units, ui, pi, stop.align === 'decimal');
          const start = stop.align === 'center' ? stop.pos - f / 2 : stop.pos - f;
          w = Math.max(0, start - x);
        }
        p.width = w;
        p.leader = stop?.leader ?? null;
      }
      x += p.width;
    });
    let trailing = 0;
    for (let k = u.pieces.length - 1; k >= 0; k--) {
      const p = u.pieces[k];
      if (p.kind === 'break') continue;
      if (p.kind === 'text') {
        trailing += p.trailing;
        if (p.trailing < p.width - EPS) break;
      } else break;
    }
    return { full: x - x0, content: x - x0 - trailing };
  }

  /**
   * Cuts a unit too wide for an empty line into pieces that each fill a line: the first `room`
   * wide, the next as wide as the lines after it (at least one cluster each). All the cuts are made
   * at once, so a word of thousands of letters is shaped only once more.
   */
  splitUnit(units, ui, room, nextRoom) {
    const u = units[ui];
    // Every place the unit may be cut, with the width before it.
    const places = [];
    let w = 0;
    u.pieces.forEach((p, k) => {
      if (k > 0) places.push({ k, at: p.start, piece: null, before: w });
      for (const c of cutsOf(p, this.text)) places.push({ k, at: c.at, piece: p, before: w + c.before });
      w += p.width;
    });
    if (!places.length) return false;
    // Greedy: as much as fits on each line, at least one place further each time.
    const chosen = [];
    let lineStart = 0;
    let limit = room;
    let i = 0;
    while (i < places.length) {
      let best = -1;
      while (i < places.length && places[i].before - lineStart <= limit + EPS) best = i++;
      if (best < 0) best = i++;
      chosen.push(places[best]);
      lineStart = places[best].before;
      limit = nextRoom;
      if (w - lineStart <= limit + EPS) break;
    }
    // Cut the pieces at the chosen places.
    const parts = [];
    let current = [];
    let k = 0;
    let c = 0;
    while (k < u.pieces.length) {
      const place = chosen[c];
      if (place && place.k === k && !place.piece) {
        // A cut before this piece.
        parts.push(current);
        current = [];
        c++;
        continue;
      }
      if (place && place.k === k && place.piece) {
        // Cuts inside this piece.
        const inside = [];
        while (chosen[c] && chosen[c].k === k && chosen[c].piece) inside.push(chosen[c++].at);
        const segments = cutPieceMany(u.pieces[k], inside, this.text);
        current.push(segments[0]);
        for (let q = 1; q < segments.length; q++) {
          parts.push(current);
          current = [segments[q]];
        }
      } else {
        current.push(u.pieces[k]);
      }
      k++;
    }
    parts.push(current);
    const made = parts.filter((ps) => ps.length).map((ps, n, all) => ({ pieces: ps, mandatory: n === all.length - 1 ? u.mandatory : false }));
    if (made.length < 2) return false;
    units.splice(ui, 1, ...made);
    return true;
  }

  run() {
    const units = this.units;
    const lines = [];
    let line = { units: [] };
    let x = 0;
    const finish = (hard, wrapped = false) => {
      const pieces = piecesOfUnits(line.units);
      if (wrapped) this.hyphenate(pieces);
      lines.push(this.makeLine(pieces, hard));
      line = { units: [] };
      x = 0;
    };
    for (let ui = 0; ui < units.length; ui++) {
      const avail = this.avail(lines.length);
      let w = this.measureUnit(units, ui, x);
      if (!line.units.length && w.content > avail + EPS && Number.isFinite(avail)) {
        // A word longer than the line: broken between its characters, as Android does.
        if (this.splitUnit(units, ui, avail, this.avail(lines.length + 1))) w = this.measureUnit(units, ui, x);
      }
      if (!line.units.length || x + w.content <= avail + EPS) {
        line.units.push(units[ui]);
        x += w.full;
        if (units[ui].mandatory) finish(true);
      } else {
        finish(false, true);
        ui--;
      }
    }
    if (line.units.length) finish(false);
    // A text ending with a line break gets an empty line after it, as in Android's layout.
    const text = this.text;
    if (!lines.length || (text.length && this.breaks[text.length] === 2) || /[\n\r\u2028\u2029\u000B\u000C\u0085]$/.test(text)) {
      lines.push(this.makeLine([], false));
    }
    this.lines = lines;
    return lines;
  }

  /** A line broken at a soft hyphen shows a hyphen at its end, as Android draws it. */
  hyphenate(pieces) {
    let k = pieces.length - 1;
    while (k >= 0 && pieces[k].kind === 'break') k--;
    const p = pieces[k];
    if (!p || p.kind !== 'text' || !this.text.slice(p.start, p.end).endsWith('\u00AD')) return;
    pieces.splice(k + 1, 0, extraPiece('-', p.style, p.end));
  }

  makeLine(pieces, hard) {
    const line = { pieces, hard, start: pieces[0]?.start ?? this.text.length, end: pieces.length ? pieces[pieces.length - 1].end : this.text.length };
    this.measureLineWidth(line);
    return line;
  }

  measureLineWidth(line) {
    let w = 0;
    let trailing = 0;
    let spaces = 0;
    const ps = line.pieces;
    let last = -1;
    for (let k = ps.length - 1; k >= 0; k--) if (ps[k].kind !== 'break') { last = k; break; }
    // The hanging spaces at the line's end, across pieces.
    let trailingFrom = last + 1;
    for (let k = last; k >= 0; k--) {
      const p = ps[k];
      if (p.kind === 'text' && p.trailing >= p.width - EPS && p.width > 0) {
        trailingFrom = k;
        continue;
      }
      break;
    }
    ps.forEach((p, k) => {
      w += p.width;
      p.lineTrailing = 0;
      if (k >= trailingFrom && p.kind === 'text') {
        p.lineTrailing = p.trailingClusters;
        trailing += p.width;
      } else if (k === trailingFrom - 1 && p.kind === 'text') {
        p.lineTrailing = p.trailingClusters;
        trailing += p.trailing;
      }
      if (p.kind === 'text') {
        const n = p.shaped.clusters.length;
        for (let i = 0; i < n - p.lineTrailing; i++) if (p.space[i] & 1) spaces++;
      }
    });
    line.width = w - trailing;
    line.spaces = spaces;
    // Tabs end justification before them: only the spaces after the last tab stretch.
    let afterTab = 0;
    for (let k = ps.length - 1; k >= 0; k--) {
      const p = ps[k];
      if (p.kind === 'tab') break;
      if (p.kind === 'text') {
        const n = p.shaped.clusters.length;
        for (let i = 0; i < n - p.lineTrailing; i++) if (p.space[i] & 1) afterTab++;
      }
    }
    line.stretchable = afterTab;
  }
}

/** Lays out a normalized spec: lines with their pieces, metrics and places. */
function buildCore(s) {
  let text = s.rich.text;
  let spans = s.rich.spans;
  if (!text) {
    text = ' ';
    spans = [{ start: 0, end: 1, style: s.base }];
  }
  const breaks = lineBreaks(text);
  const { levels, segments } = directions(text, breaks, s);
  const pieces = itemize(text, spans, breaks, levels);
  const breaker = new Breaker(s, text, pieces, breaks, segments);
  let lines = breaker.run();
  if (s.maxLines && lines.length > s.maxLines) {
    lines = lines.slice(0, s.maxLines);
    if (s.ellipsis) ellipsize(breaker, lines[lines.length - 1], lines.length - 1, text);
  }
  const core = { s, text, lines, breaker, segments };
  placeLines(core);
  return core;
}

/** A piece drawing text that isn't in the paragraph's own (an ellipsis, a hyphen), at offset `at`. */
function extraPiece(text, style, at) {
  const entry = pickFont(style.stack, text) ?? style.stack[0];
  const p = { start: 0, end: text.length, span: null, style, kind: 'text', file: entry.file, slant: entry.slant, level: 0, rtl: false, obj: null, clusterCount: 1, extra: true, text };
  measurePiece(p, text);
  p.start = at;
  p.end = at;
  return p;
}

/** Cuts the last kept line so that "…" fits after it. */
function ellipsize(breaker, line, index, text) {
  let pieces = line.pieces.filter((p) => p.kind !== 'break');
  const lastStyle = (pieces[pieces.length - 1] ?? line.pieces[0])?.style ?? breaker.s.base;
  const ell = extraPiece(ELLIPSIS, lastStyle, line.end);
  // A hyphen shown at a soft hyphen goes: the text goes on after it.
  if (pieces.length && pieces[pieces.length - 1].extra) pieces.pop();
  const avail = breaker.avail(index);
  const width = () => pieces.reduce((w, p) => w + p.width, 0) - trailingOf(pieces);
  while (pieces.length && width() + ell.width > avail + EPS) {
    const p = pieces[pieces.length - 1];
    const cuts = cutsOf(p, text);
    if (cuts.length) pieces[pieces.length - 1] = cutPiece(p, cuts[cuts.length - 1].at, text)[0];
    else pieces.pop();
  }
  // No spaces before the "…".
  while (pieces.length) {
    const p = pieces[pieces.length - 1];
    if (p.kind === 'text' && p.trailing > 0) {
      if (p.trailing >= p.width - EPS) pieces.pop();
      else {
        const cl = p.shaped.clusters;
        const keep = cl[cl.length - p.trailingClusters - 1];
        pieces[pieces.length - 1] = cutPiece(p, p.start + keep.end, text)[0];
        break;
      }
    } else break;
  }
  pieces.push(ell);
  line.pieces = pieces;
  line.hard = false;
  line.end = pieces.length > 1 ? pieces[pieces.length - 2].end : line.start;
  breaker.measureLineWidth(line);
}

function trailingOf(pieces) {
  const p = pieces[pieces.length - 1];
  return p && p.kind === 'text' ? p.trailing : 0;
}

/** Each line's height and baseline (with the paragraph's line spacing), and where its text starts. */
function placeLines(core) {
  const { s, lines, breaker } = core;
  let top = 0;
  const baseM = fileMetrics(s.base.stack[0].file);
  lines.forEach((line, i) => {
    let ascent = 0;
    let descent = 0;
    let picture = false;
    let any = false;
    for (const p of line.pieces) {
      const st = p.style;
      const S = st.drawnSize;
      const m = fileMetrics(st.stack[0].file);
      ascent = Math.max(ascent, m.ascent * S);
      descent = Math.max(descent, m.descent * S);
      any = true;
      if (p.kind === 'text' && p.file !== st.stack[0].file) {
        const f = fileMetrics(p.file);
        ascent = Math.max(ascent, f.ascent * S);
        descent = Math.max(descent, f.descent * S);
      } else if (p.kind === 'fallback' && p.metrics) {
        ascent = Math.max(ascent, p.metrics.ascent * S);
        descent = Math.max(descent, p.metrics.descent * S);
      } else if (p.kind === 'object') {
        ascent = Math.max(ascent, +p.obj.height || 0);
        picture = true;
      }
    }
    if (!any) {
      ascent = baseM.ascent * s.base.drawnSize;
      descent = baseM.descent * s.base.drawnSize;
    }
    const natural = ascent + descent;
    let target = natural;
    if (natural > 0) {
      const sp = s.spacing;
      if (sp.type === 'exact') target = sp.value;
      else if (sp.type === 'atLeast') target = Math.max(natural, sp.value);
      else {
        const f = sp.value * s.lineScale;
        target = natural * (picture ? Math.max(1, f) : f);
      }
    }
    // The extra goes above the text, as in Word.
    const asc = ascent + (target - natural);
    line.top = top;
    line.ascent = asc;
    line.descent = descent;
    line.baseline = top + asc;
    line.bottom = line.baseline + descent;
    line.index = i;
    line.last = i === lines.length - 1;
    const seg = core.segments.find((g) => line.start >= g.start && line.start < g.end) ?? core.segments[core.segments.length - 1];
    line.rtl = seg ? seg.rtl : s.rtl;
    top = line.bottom;
  });
  // Unlimited width: lines are aligned to the longest one.
  if (!Number.isFinite(breaker.layoutWidth)) {
    let w = 1;
    lines.forEach((line, i) => { w = Math.max(w, line.width + breaker.indents[Math.min(1, i)]); });
    breaker.layoutWidth = w;
  }
  for (const line of lines) align(core, line);
}

function align(core, line) {
  const { s, breaker } = core;
  const indent = breaker.indents[Math.min(1, line.index)];
  const full = breaker.layoutWidth;
  const regionStart = s.mirrored ? 0 : indent;
  const regionEnd = s.mirrored ? full - indent : full;
  const avail = regionEnd - regionStart;
  const a = s.align;
  const justify = a === 'justify' && !line.hard && !line.last && line.stretchable > 0 && line.width < avail;
  let side;
  if (a === 'left' || a === 'right' || a === 'center') side = a;
  else if (a === 'end') side = line.rtl ? 'left' : 'right';
  else side = line.rtl ? 'right' : 'left';
  line.extra = justify ? (avail - line.width) / line.stretchable : 0;
  const width = justify ? avail : line.width;
  line.x = side === 'left' ? regionStart : side === 'right' ? regionEnd - width : regionStart + (avail - width) / 2;
  line.drawnWidth = width;
}

// ---- Drawing items ----

/** The pieces of a line in the order they show, left to right. */
function visualPieces(line) {
  const ps = line.pieces.filter((p) => p.kind !== 'break');
  if (!ps.some((p) => p.level)) return ps;
  return visualOrder(Uint8Array.from(ps.map((p) => p.level))).map((i) => ps[i]);
}

/** What one line draws, relative to the paragraph's text box (x from its left, y from the part's top). */
function lineItems(core, line, dy) {
  const items = { back: [], fore: [], deco: [], links: [] };
  let x = line.x;
  const baseline = line.baseline - dy;
  const top = line.top - dy;
  const bottom = line.bottom - dy;
  // Justification stretches only the spaces after the line's last tab.
  let lastTab = -1;
  line.pieces.forEach((p, k) => { if (p.kind === 'tab') lastTab = k; });
  for (const p of visualPieces(line)) {
    const st = p.style;
    const stretch = line.extra && line.pieces.indexOf(p) > lastTab ? line.extra : 0;
    let w = 0;
    if (p.kind === 'text') {
      const run = glyphRun(core, p, x, baseline + st.shift, stretch);
      w = run.width;
      if (run.gid.length) items.fore.push(run);
    } else if (p.kind === 'fallback') {
      w = p.width;
      items.fore.push({
        kind: 'fallback', x, y: baseline + st.shift, width: w, size: st.drawnSize, scaleX: st.scaleX, color: st.color,
        text: core.text.slice(p.start, p.end), family: st.kind, bold: st.bold, italic: st.italic, rtl: p.rtl, emoji: p.emoji,
        metrics: p.metrics, letterSpacing: st.letterSpacing, carrier: loadedFont(st.stack[0].file),
      });
    } else if (p.kind === 'object') {
      w = p.width;
      const h = +p.obj.height || 0;
      items.fore.push({ kind: 'object', obj: p.obj, x, y: baseline - h, w, h });
    } else if (p.kind === 'tab') {
      w = p.width;
      if (p.leader && w > 0) {
        const leader = leaderRun(p, x, baseline + st.shift, w);
        if (leader) items.fore.push(leader);
      }
    }
    if (w > 0) {
      if (st.background && p.kind !== 'tab') items.back.push({ kind: 'rect', x, y: top, w, h: bottom - top, color: st.background });
      if ((st.underline || st.strike) && p.kind !== 'object') {
        const m = fileMetrics(st.stack[0].file);
        const S = st.drawnSize;
        const y0 = baseline + st.shift;
        if (st.underline) {
          const t = m.underlineThickness * S;
          const uy = y0 - (m.underlinePosition + m.underlineThickness / 2) * S;
          items.deco.push({ kind: 'rect', x, y: uy, w, h: t, color: st.color });
          if (st.underline === 'double') items.deco.push({ kind: 'rect', x, y: uy + 2 * t, w, h: t, color: st.color });
        }
        if (st.strike) {
          items.deco.push({ kind: 'rect', x, y: y0 - m.strikePosition * S, w, h: m.strikeThickness * S, color: st.color });
        }
      }
      if (st.link && p.kind !== 'tab') {
        const prev = items.links[items.links.length - 1];
        if (prev && prev.link === st.link && Math.abs(prev.x + prev.w - x) < 0.01) prev.w += w;
        else items.links.push({ kind: 'link', x, y: top, w, h: bottom - top, link: st.link });
      }
    }
    x += w;
  }
  return items;
}

/** A text piece's glyphs placed from `x`, with letter spacing and justification. */
function glyphRun(core, p, x, y, stretch) {
  const st = p.style;
  const sh = p.shaped;
  const S = st.drawnSize;
  const hs = st.scaleX;
  const ls = st.letterSpacing * hs;
  const clusters = sh.clusters;
  const n = clusters.length;
  const skip = p.lineTrailing ?? 0;
  const gid = [];
  const gx = [];
  const gdx = [];
  const gdy = [];
  const gtext = [];
  const gextra = [];
  let pen = 0;
  // In drawing order: reading order, reversed for right to left.
  const order = p.rtl ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
  for (const i of order) {
    const c = clusters[i];
    const trailing = !p.rtl ? i >= n - skip : i >= n - skip;
    if (trailing) continue;
    pen += ls / 2;
    for (let g = c.g0; g < c.g1; g++) {
      gid.push(sh.gid[g]);
      gx.push(pen);
      gdx.push(sh.dx[g] * S * hs);
      gdy.push(sh.dy[g] * S);
      gtext.push(sh.gtext[g]);
      gextra.push(sh.extra[g]);
      pen += sh.adv[g] * S * hs;
    }
    pen += ls / 2;
    if (stretch && p.space[i] & 1) pen += stretch;
  }
  let text = core.text.slice(p.start, p.end);
  if (p.extra) text = p.text;
  if (skip) text = text.replace(/[\s\u3000]+$/u, '');
  return {
    kind: 'glyphs', font: p.font, slant: p.slant, size: S, scaleX: hs, color: st.color, x, y,
    gid, gx, gdx, gdy, gtext, gextra, width: pen, letterSpacing: st.letterSpacing,
    actualText: sh.complex ? text.replace(/[\p{Cf}\p{Cc}]/gu, '') : null,
  };
}

/** Leader characters filling a tab: dots or dashes up to the stop. */
function leaderRun(p, x, y, w) {
  const st = p.style;
  const ch = LEADERS[p.leader] ?? '.';
  const entry = pickFont(st.stack, ch) ?? st.stack[0];
  const font = loadedFont(entry.file);
  if (!font) return null;
  const sh = shape(font, ch);
  if (!sh.n) return null;
  const S = st.drawnSize;
  const adv = sh.adv[0] * S * st.scaleX;
  if (!(adv > 0)) return null;
  const pad = S * 0.15;
  const count = Math.floor((w - 2 * pad) / adv);
  if (count < 1) return null;
  const start = x + w - pad - count * adv;
  const run = { kind: 'glyphs', font, slant: entry.slant, size: S, scaleX: st.scaleX, color: st.color, x: start, y, gid: [], gx: [], gdx: [], gdy: [], gtext: [], gextra: [], width: count * adv, actualText: null };
  for (let i = 0; i < count; i++) {
    run.gid.push(sh.gid[0]);
    run.gx.push(i * adv);
    run.gdx.push(0);
    run.gdy.push(0);
    run.gtext.push(ch);
    run.gextra.push(null);
  }
  return run;
}

// ---- The laid-out paragraph ----

/**
 * PageBreaking.linesThatFit: how many of the lines (whose bottoms are `lineBottoms`, from the top)
 * fit in `space`, keeping a lone first or last line from being stranded when `avoidSingleLines`;
 * with `force` at least one.
 */
export function linesThatFit(lineBottoms, space, avoidSingleLines, force, keepFirst = true, keepLast = true) {
  const count = lineBottoms.length;
  let fit = 0;
  for (const b of lineBottoms) if (b <= space + EPS) fit++;
  if (avoidSingleLines && fit >= 1 && fit < count) {
    if (keepLast && fit === count - 1) fit -= 1;
    if (keepFirst && fit === 1) fit = 0;
  }
  return force ? Math.max(fit, Math.min(1, count)) : fit;
}

/**
 * A laid-out paragraph, or a part of one (some of its lines, after split()). It draws itself with
 * draw(target, x, y), x and y being its box's top-left corner on a PdfCanvas or a screen canvas.
 */
export class ParagraphLayout {
  constructor(spec, core, from = 0, to = core.lines.length, isFirst = true, isLast = true) {
    this.spec = spec;
    this.core = core;
    this.from = from;
    this.to = to;
    this.isFirst = isFirst;
    this.isLast = isLast;
    this.top = from < core.lines.length ? core.lines[from].top : 0;
  }

  /** This part's lines: { start, end (text offsets), top, baseline, bottom (points from the part's top), x, width, ascent, descent, hard }. */
  get lines() {
    return this.core.lines.slice(this.from, this.to).map((l) => ({
      start: l.start, end: l.end, top: l.top - this.top, baseline: l.baseline - this.top, bottom: l.bottom - this.top,
      x: l.x + this.textLeft, width: l.width, ascent: l.ascent, descent: l.descent, hard: l.hard, rtl: l.rtl,
    }));
  }

  get lineCount() {
    return this.to - this.from;
  }

  /** The paragraph's text (this part's, after split()). */
  get text() {
    if (!this.lineCount) return '';
    const ls = this.core.lines;
    return this.core.text.slice(ls[this.from].start, ls[this.to - 1].end);
  }

  get height() {
    if (!this.lineCount) return 0;
    return this.core.lines[this.to - 1].bottom - this.top;
  }

  /** The baseline of the first line, from the top. */
  get firstBaseline() {
    return this.lineCount ? this.core.lines[this.from].baseline - this.top : 0;
  }

  /** How tall the first line is. */
  get firstLineHeight() {
    return this.lineCount ? this.core.lines[this.from].bottom - this.top : 0;
  }

  /** The widest line, without the spaces it ends with: for text that isn't wrapped, and shrinking to fit. */
  get contentWidth() {
    let w = 0;
    for (let i = this.from; i < this.to; i++) w = Math.max(w, this.core.lines[i].width);
    return w;
  }

  /** The width it was laid out to (the widest line plus indents when the width was unlimited). */
  get width() {
    const s = this.spec;
    return Number.isFinite(s.width) ? s.width : this.core.breaker.layoutWidth + this.core.breaker.left + s.rightIndent;
  }

  /** Where the text goes across, from the paragraph's left edge (mirrored for right-to-left Word paragraphs). */
  get textLeft() {
    const s = this.spec;
    return s.mirrored ? s.rightIndent : this.core.breaker.left;
  }

  get textRight() {
    const s = this.spec;
    return s.mirrored ? this.width - this.core.breaker.left : this.width - s.rightIndent;
  }

  /** The bottom of each line, from this part's top. */
  lineBottoms() {
    const out = [];
    for (let i = this.from; i < this.to; i++) out.push(this.core.lines[i].bottom - this.top);
    return out;
  }

  /**
   * The part of this paragraph that fits in `space` points and the rest (null when it all fits), as
   * [head, tail]; or null when nothing fits. With `force`, at least one line fits.
   */
  split(space, force = false) {
    const fit = linesThatFit(this.lineBottoms(), space, this.spec.avoidSingleLines, force);
    if (fit === 0) return null;
    if (fit >= this.lineCount) return [this, null];
    const cut = this.from + fit;
    return [
      new ParagraphLayout(this.spec, this.core, this.from, cut, this.isFirst, false),
      new ParagraphLayout(this.spec, this.core, cut, this.to, false, this.isLast),
    ];
  }

  /** Draws this paragraph (part) with its box's top-left corner at (x, y), on a PdfCanvas or a 2D canvas context. */
  draw(target, x, y) {
    if (target && typeof target.drawLayout === 'function') return target.drawLayout(this, x, y);
    return paintLayout(target, this, x, y);
  }

  /**
   * Everything this part draws, in the order to draw it, placed for its top-left corner at (x, y):
   * { kind: 'rect', x, y, w, h, color }, { kind: 'glyphs', font, slant, size, scaleX, color, x, y,
   * gid[], gx[], gdx[], gdy[], gtext[], gextra[], actualText }, { kind: 'fallback', ... },
   * { kind: 'object', obj, x, y, w, h }, { kind: 'line', x1, y1, x2, y2, width, color } and
   * { kind: 'link', x, y, w, h, link }. Used by the PDF and screen renderers.
   */
  items(x = 0, y = 0) {
    const s = this.spec;
    const core = this.core;
    const out = [];
    const tl = this.textLeft;
    const tr = this.textRight;
    const h = this.height;
    if (s.background && this.lineCount) out.push({ kind: 'rect', x: x + tl, y, w: tr - tl, h, color: s.background });
    const back = [];
    const fore = [];
    const deco = [];
    const links = [];
    for (let i = this.from; i < this.to; i++) {
      const it = lineItems(core, core.lines[i], this.top);
      for (const [list, dst] of [[it.back, back], [it.fore, fore], [it.deco, deco], [it.links, links]]) {
        for (const item of list) dst.push(offset(item, x + tl, y));
      }
    }
    out.push(...back);
    if (this.isFirst && s.label && this.lineCount) out.push(...this.labelItems(x, y));
    out.push(...fore, ...deco);
    const ruleFrom = s.mirrored ? s.rightIndent : Math.min(s.firstIndent, s.indent);
    const ruleTo = s.mirrored ? this.width - Math.min(s.firstIndent, s.indent) : this.width - s.rightIndent;
    if (this.isFirst && s.ruleAbove) {
      const r = s.ruleAbove;
      out.push({ kind: 'line', x1: x + ruleFrom, x2: x + ruleTo, y1: y - r.gap - r.width / 2, y2: y - r.gap - r.width / 2, width: r.width, color: r.color });
    }
    if (this.isLast && s.ruleBelow) {
      const r = s.ruleBelow;
      out.push({ kind: 'line', x1: x + ruleFrom, x2: x + ruleTo, y1: y + h + r.gap + r.width / 2, y2: y + h + r.gap + r.width / 2, width: r.width, color: r.color });
    }
    out.push(...links);
    return out;
  }

  labelItems(x, y) {
    const s = this.spec;
    if (!this.labelLayout) {
      this.labelLayout = layoutParagraphSync({ text: s.label.text, base: s.label.style, width: Infinity, rtl: s.mirrored, directionFromText: !s.mirrored });
    }
    const lab = this.labelLayout;
    const w = lab.contentWidth;
    // Ending x points in from the right when mirrored, as Word shows it.
    const lx = s.mirrored ? x + this.width - s.label.x - w : x + s.label.x;
    const ly = y + this.firstBaseline - lab.firstBaseline;
    return lab.items(lx, ly).filter((it) => it.kind !== 'link');
  }

  /** The box the ink of this part's glyphs covers, relative to its top-left corner: { left, top, right, bottom }. */
  inkBounds() {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const add = (x0, y0, x1, y1) => {
      left = Math.min(left, x0, x1);
      right = Math.max(right, x0, x1);
      top = Math.min(top, y0, y1);
      bottom = Math.max(bottom, y0, y1);
    };
    for (const it of this.items(0, 0)) {
      if (it.kind === 'glyphs') {
        const k = it.size / it.font.upm;
        for (let i = 0; i < it.gid.length; i++) {
          const b = it.font.fk.getGlyph(it.gid[i])?.bbox;
          if (!b || !(b.maxX > b.minX)) continue;
          const ox = it.x + it.gx[i] + it.gdx[i];
          const oy = it.y - it.gdy[i];
          const skew = it.slant ? 0.25 : 0;
          for (const [gx, gy] of [[b.minX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY], [b.maxX, b.minY]]) {
            add(ox + (gx * it.scaleX + skew * gy) * k, oy - gy * k, ox + (gx * it.scaleX + skew * gy) * k, oy - gy * k);
          }
        }
      } else if (it.kind === 'fallback' && it.metrics) {
        const m = it.metrics;
        const S = it.size;
        add(it.x + m.inkLeft * S * it.scaleX, it.y - m.inkTop * S, it.x + m.inkRight * S * it.scaleX, it.y + m.inkBottom * S);
      } else if (it.kind === 'object' || it.kind === 'rect') {
        add(it.x, it.y, it.x + (it.w ?? 0), it.y + (it.h ?? 0));
      }
    }
    if (left === Infinity) return { left: 0, top: 0, right: 0, bottom: 0 };
    return { left, top, right, bottom };
  }
}

function offset(item, dx, dy) {
  const o = { ...item, x: item.x + dx, y: item.y + dy };
  return o;
}

/**
 * Plain text in lines, laid out as Edit PDF's text boxes (PageText.kt): split at line breaks,
 * not wrapped unless `width` is given. Resolves to a ParagraphLayout.
 */
export function layoutText(text, style = {}, options = {}) {
  return layoutParagraph({ ...options, text: String(text ?? ''), base: style });
}
