// PowerPoint presentations (.pptx) to PDF: one page per slide, in the presentation's order, the
// size of its slides. Hidden slides are left out. A port of the app's PptxConverter.kt.
//
// What converts: slide backgrounds (colours, gradients, pictures) and the shapes and pictures of
// the slide master and layout behind each slide; shapes with their position, size, rotation, fill
// and outline (rectangles, rounded rectangles, ovals, triangles, arrows and other common shapes,
// lines and connectors with their arrowheads, and freeform shapes); pictures, cropped as on the
// slide; groups, flipped or not; text boxes and placeholders, which take their position, outline
// and text style from the slide layout and master (titles, bulleted and numbered body text at every
// level), with alignment, spacing, bold, italic, underline, size and colour, right to left too;
// text shrunk to fit its box when PowerPoint would shrink it; slide numbers; links; tables, styled
// as in PowerPoint, with merged cells; SmartArt, from the drawing PowerPoint saves with it; ink,
// equations and embedded objects, from the pictures PowerPoint saves of them.
//
// What is simplified: the bundled fonts stand in for the presentation's, so text can take a little
// more or less room; shadows, glow, reflections, 3-D and other effects are left out, as are
// animations, videos (their poster picture shows), speaker notes and comments. Vertical text whose
// characters stand upright (Chinese, Japanese and Korean, or stacked letters) runs across its box,
// wrapped to its width. Charts, and objects saved without a picture, become light grey boxes with
// their title.
import { OfficePackage } from './ooxml.js';
import { OfficePdf, OfficeImages, StandInPicture } from './office-pdf.js';
import { OfficeTheme, Fill, Outline, drawShape as drawGeometry, fillShape, rotateAbout } from './drawingml.js';
import { OfficeUnits, OfficeRect, GroupFrame } from './office-formats.js';
import { OfficeNothingToConvert } from './problems.js';
import { officeOutputName } from './index.js';
import {
  Ctx, Kind, ShapeReader, mapKey, readColorMap, readBackground, readLevels, readTableStyles, partReferences,
  chartTitleOf, smartArtDrawingId, hasText, levelLook, runLook,
} from './pptx-model.js';
import { drawText } from './pptx-text.js';
import { drawTable, defaultTableStyle } from './pptx-table.js';
import { PdfPath } from '../text/index.js';
import { checkCancelled } from '../../core/errors.js';
import { pause } from './pause.js';

const WHITE = 0xffffffff;

/** How long work may run before the page is let to respond (milliseconds). */
const SLICE = 40;

/** SmartArt drawings are read this many levels deep (a drawing whose shapes hold SmartArt in turn). */
const MAX_PART_DEPTH = 2;

const isCancel = (e) => e?.name === 'CancelledError';

/** Errors a shape that can't be drawn mustn't hide: cancelling, and fonts that couldn't be loaded. */
const mustPass = (e) => isCancel(e) || e?.key === 'web_fonts_unavailable';

/** For a slide without a master: Office's default theme and colour map. */
const NO_MASTER = Object.freeze({
  shapes: [], background: null, showMasterShapes: true, theme: OfficeTheme.DEFAULT, colorMap: new Map(), textStyles: new Map(),
});

/** title, body, or the placeholder's own type for dates, footers and slide numbers. */
function kindOf(type) {
  switch (type) {
    case 'title': case 'ctrTitle': return 'title';
    case 'dt': case 'ftr': case 'sldNum': case 'hdr': return type;
    default: return 'body';
  }
}

/** `r` (an OfficeRect) as { left, top, right, bottom }. */
const edges = (r) => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });

/** A shape reader for a part with nothing else to look up. */
const PLAIN_READER = new ShapeReader({ chartTitle: () => null, smartArt: () => null });

class PptxConverter {
  constructor(pkg, pdf, images, hooks) {
    this.pkg = pkg;
    this.pdf = pdf;
    this.images = images;
    this.hooks = hooks;
    this.signal = hooks.signal;
    this.slideWidth = 720;
    this.slideHeight = 540;
    this.main = 'ppt/presentation.xml';
    this.mainRoot = null;
    /** Masters, layouts and slides read, by part and the colour map they were read with. */
    this.templates = new Map();
    this.colorMapOverrides = new Map();
    /** Themes by part, so each is one object (the caches below are by theme and colour map). */
    this.themes = new Map();
    this.themeIds = new WeakMap();
    this.nextThemeId = 1;
    /** The presentation's default text style, read with each theme and colour map it's drawn with. */
    this.defaultTexts = new Map();
    /** The presentation's table styles, read with each theme and colour map they're drawn with. */
    this.tableStyles = new Map();
    this.currentTheme = OfficeTheme.DEFAULT;
    this.lastBreath = now();
  }

  /** A theme font reference ("+mn-lt"...) or font name as the font to draw with; the body font without one. */
  themeFont(name) {
    return this.currentTheme.font(name ?? '+mn-lt');
  }

  /** Lets the page respond now and then during long work, and stops when cancelled. */
  async breathe() {
    checkCancelled(this.signal);
    if (now() - this.lastBreath > SLICE) {
      await pause();
      this.lastBreath = now();
      checkCancelled(this.signal);
    }
  }

  /** Converts every slide that isn't hidden; resolves to { bytes, pageCount }. Throws OfficeNothingToConvert when none is left. */
  async convert() {
    const { pkg } = this;
    const main = pkg.mainPart() ?? 'ppt/presentation.xml';
    this.main = main;
    const ids = [];
    let firstNumber = 1;
    const x = await pkg.xml(main);
    this.mainRoot = x;
    if (x) {
      const n = x.intAttr('firstSlideNum');
      if (n != null) firstNumber = n;
      for (const c of x.children()) {
        if (c.name === 'sldSz') {
          const cx = c.longAttr('cx');
          const cy = c.longAttr('cy');
          if (cx != null && cx > 0) this.slideWidth = clamp(OfficeUnits.emu(cx), 72, 14400);
          if (cy != null && cy > 0) this.slideHeight = clamp(OfficeUnits.emu(cy), 72, 14400);
        } else if (c.name === 'sldIdLst') {
          for (const s of c.children()) {
            if (s.name !== 'sldId') continue;
            const id = s.relId();
            if (id != null) ids.push(id);
          }
        }
      }
    }
    // A slide's number is its place among all the slides, hidden ones too, as PowerPoint numbers them.
    const slides = [];
    for (let i = 0; i < ids.length; i++) {
      const target = pkg.target(main, ids[i]);
      if (target == null) continue;
      await this.breathe();
      if (await this.isShown(target)) slides.push([firstNumber + i, target]);
    }
    if (!slides.length) throw new OfficeNothingToConvert();
    for (let i = 0; i < slides.length; i++) {
      checkCancelled(this.signal);
      this.hooks.onProgress?.(i + 1, slides.length);
      await this.drawSlide(slides[i][1], slides[i][0]);
      // Only once the time slice is used up: a timer's pause after each of hundreds of quick
      // slides would add up (to a second each in a background tab, where timers are slowed).
      await this.breathe();
    }
    return this.pdf.finish(this.hooks);
  }

  async isShown(slide) {
    const x = await this.pkg.xml(slide);
    return x ? x.flag('show') : false;
  }

  // ---- Reading ----

  async theme(path) {
    const key = path == null ? '' : path.toLowerCase();
    let t = this.themes.get(key);
    if (!t) {
      t = OfficeTheme.read(this.pkg, path);
      this.themes.set(key, t);
    }
    return t;
  }

  themeId(theme) {
    let id = this.themeIds.get(theme);
    if (id == null) {
      id = this.nextThemeId++;
      this.themeIds.set(theme, id);
    }
    return id;
  }

  /**
   * The master, layout or slide in part `path` (`master` null for a master). Its colours are read
   * with `colorMap` when given (a slide's or layout's override of its master's), else with its
   * master's colour map. `root`: the part already parsed; `cache`: false for slides, read once.
   */
  async template(path, master, colorMap = null, { root, cache = true } = {}) {
    const key = `${path.toLowerCase()}\n${colorMap ? mapKey(colorMap) : 'null'}`;
    if (cache) {
      const found = this.templates.get(key);
      if (found) return found;
    }
    const theme = master == null ? await this.theme(this.pkg.targetOfType(path, '/theme')) : master.theme;
    const x = root !== undefined ? root : await this.pkg.xml(path);
    // A master's colour map comes after its shapes in the file, but their colours depend on it.
    const map = colorMap ?? master?.colorMap ?? readColorMap(x) ?? new Map();
    const ctx = new Ctx(this.pkg, path, theme, map);
    let shapes = [];
    let background = null;
    let showMaster = true;
    const styles = new Map();
    if (x) {
      showMaster = x.flag('showMasterSp');
      const reader = await this.readerFor(x, ctx);
      for (const c of x.children()) {
        if (c.name === 'cSld') {
          for (const s of c.children()) {
            if (s.name === 'bg') background = readBackground(s, ctx);
            else if (s.name === 'spTree') shapes = reader.readShapes(s, ctx);
          }
        } else if (c.name === 'txStyles') {
          for (const s of c.children()) {
            const kind = s.name === 'titleStyle' ? 'title' : s.name === 'bodyStyle' ? 'body' : 'other';
            styles.set(kind, readLevels(s, ctx));
          }
        }
      }
    }
    const t = {
      shapes, background, showMasterShapes: showMaster, theme, colorMap: map,
      textStyles: styles.size ? styles : master?.textStyles ?? new Map(),
    };
    if (cache) this.templates.set(key, t);
    return t;
  }

  /** A layout's override of its master's colour map, read once. */
  async layoutColorMap(path) {
    const key = path.toLowerCase();
    if (this.colorMapOverrides.has(key)) return this.colorMapOverrides.get(key);
    const map = readColorMap(await this.pkg.xml(path));
    this.colorMapOverrides.set(key, map);
    return map;
  }

  /** What `read` gives, or null when the part of a shape's own it reads (a chart's, SmartArt's...) is damaged. */
  async orNull(read) {
    try {
      return await read();
    } catch (e) {
      if (isCancel(e)) throw e;
      return null;
    }
  }

  /**
   * A shape reader for the part whose root is `x`, with the titles of the charts and the drawings
   * of the SmartArt its shapes refer to loaded beforehand.
   */
  async readerFor(x, ctx, depth = 0) {
    if (depth >= MAX_PART_DEPTH) return PLAIN_READER;
    const { charts, diagrams } = partReferences(x);
    if (!charts.size && !diagrams.size) return PLAIN_READER;
    const titles = new Map();
    const drawings = new Map();
    for (const id of charts) {
      titles.set(id, await this.orNull(async () => {
        const path = this.pkg.target(ctx.part, id);
        const chart = path != null ? await this.pkg.xml(path) : null;
        return chart ? chartTitleOf(chart) : null;
      }));
    }
    for (const id of diagrams) drawings.set(id, await this.orNull(() => this.smartArt(ctx, id, depth)));
    return new ShapeReader({
      chartTitle: (_, id) => titles.get(id) ?? null,
      smartArt: (_, id) => drawings.get(id) ?? null,
    });
  }

  /** SmartArt, from the drawing PowerPoint saves alongside it; null when there's none. */
  async smartArt(ctx, dataId, depth) {
    const data = this.pkg.target(ctx.part, dataId);
    if (data == null) return null;
    const dataRoot = await this.pkg.xml(data);
    const drawingId = dataRoot ? smartArtDrawingId(dataRoot) : null;
    const drawing = this.pkg.target(ctx.part, drawingId);
    if (drawing == null) return null;
    const x = await this.pkg.xml(drawing);
    if (!x) return null;
    const dctx = ctx.forPart(drawing);
    const reader = await this.readerFor(x, dctx, depth + 1);
    let shapes = null;
    for (const c of x.children()) if (c.name === 'spTree') shapes = reader.readShapes(c, dctx);
    return shapes;
  }

  /** The presentation's default text style, its colours (tx1...) those of `template`'s theme and colour map. */
  defaultText(template) {
    const key = `${this.themeId(template.theme)}\n${mapKey(template.colorMap)}`;
    let levels = this.defaultTexts.get(key);
    if (!levels) {
      levels = new Map();
      const x = this.mainRoot;
      if (x) {
        const ctx = new Ctx(this.pkg, this.main, template.theme, template.colorMap);
        for (const c of x.children()) if (c.name === 'defaultTextStyle') levels = readLevels(c, ctx);
      }
      this.defaultTexts.set(key, levels);
    }
    return levels;
  }

  /** The table style `id` of the presentation, with `ctx`'s colours, or null. */
  async tableStyle(id, ctx) {
    if (id == null) return null;
    // Their colours are the theme's (accent1...), so slides of another master get their own.
    const key = `${this.themeId(ctx.theme)}\n${mapKey(ctx.colorMap)}`;
    let all = this.tableStyles.get(key);
    if (!all) {
      // Damaged, the styles aren't read, and tables get PowerPoint's default look.
      all = (await this.orNull(async () => {
        const path = this.pkg.targetOfType(this.main, '/tableStyles');
        if (path == null) return null;
        const x = await this.pkg.xml(path);
        return x ? readTableStyles(x, ctx.forPart(path)) : null;
      })) ?? new Map();
      this.tableStyles.set(key, all);
    }
    return all.get(id) ?? null;
  }

  // ---- Drawing ----

  async drawSlide(path, number) {
    const { pkg } = this;
    const layoutPath = pkg.targetOfType(path, '/slideLayout');
    const masterPath = layoutPath != null ? pkg.targetOfType(layoutPath, '/slideMaster') : null;
    const plainMaster = masterPath != null ? await this.template(masterPath, null) : null;
    const root = await pkg.xml(path);
    // A slide's or its layout's own colour map (a dark title layout's, say) is the one for all of
    // the slide, the master's shapes and text styles too.
    let colorMap = readColorMap(root) ?? (layoutPath != null ? await this.layoutColorMap(layoutPath) : null);
    if (colorMap != null && plainMaster != null && mapKey(colorMap) === mapKey(plainMaster.colorMap)) colorMap = null;
    const master = colorMap == null ? plainMaster : masterPath != null ? await this.template(masterPath, null, colorMap) : null;
    const layout = layoutPath != null ? await this.template(layoutPath, master ?? NO_MASTER, colorMap) : null;
    // A slide's own template is read once and not needed again.
    const slide = await this.template(path, master ?? layout ?? NO_MASTER, colorMap, { root, cache: false });
    this.currentTheme = slide.theme;
    const canvas = this.pdf.startPage(this.slideWidth, this.slideHeight);
    try {
      const page = new OfficeRect(0, 0, this.slideWidth, this.slideHeight);
      const background = slide.background ?? layout?.background ?? master?.background ?? Fill.solid(WHITE);
      canvas.fillStyle = WHITE;
      canvas.fillRect(0, 0, canvas.width, canvas.height);
      const outline = new PdfPath();
      outline.rect(0, 0, this.slideWidth, this.slideHeight);
      const picture = background.type === 'image' ? await this.images.picture(background.path, this.slideWidth, this.slideHeight, background.crop) : null;
      fillShape(canvas, background, outline, page, () => picture);
      const scene = { slide, layout, master, number };
      if (slide.showMasterShapes && layout?.showMasterShapes !== false && master != null) {
        for (const shape of master.shapes) if (shape.ph == null) await this.guarded(canvas, shape, () => this.drawShape(canvas, shape, scene, master, null));
      }
      if (slide.showMasterShapes && layout != null) {
        for (const shape of layout.shapes) if (shape.ph == null) await this.guarded(canvas, shape, () => this.drawShape(canvas, shape, scene, layout, null));
      }
      for (const shape of slide.shapes) await this.guarded(canvas, shape, () => this.drawShape(canvas, shape, scene, slide, null));
    } finally {
      // The page's content is compressed now rather than all at once when the PDF is saved, which
      // would hold up the page that long. (Its text was drawn with its fonts loaded, so nothing waits.)
      canvas.close();
      this.pdf.finishPage();
    }
  }

  /**
   * Draws one shape with `draw`. A shape that can't be drawn (such as one with values no slide
   * could have, or a damaged part or picture of its own) is left out, rather than the whole
   * presentation failing. The canvas is saved before and restored after, so a shape can turn it
   * as it needs.
   */
  async guarded(canvas, shape, draw) {
    await this.breathe();
    // As the app's restoreToCount(save()): a shape that fails partway leaves nothing it saved.
    const saved = canvas.save();
    try {
      await draw();
    } catch (e) {
      if (mustPass(e)) throw e;
      // Left out.
      this.hooks.onLeftOut?.(e, shape?.name ?? '');
    } finally {
      if (typeof canvas.restoreToCount === 'function') canvas.restoreToCount(saved);
      else canvas.restore();
    }
  }

  /** The layout's and master's placeholders that `ph` takes its place and look from. */
  inherited(ph, scene, owner) {
    const out = [];
    const match = (shapes, p) =>
      shapes.find((s) => s.ph != null && p.idx != null && s.ph.idx === p.idx && p.type !== 'title' && p.type !== 'ctrTitle') ??
      shapes.find((s) => s.ph?.type === p.type) ??
      shapes.find((s) => s.ph != null && kindOf(s.ph.type) === kindOf(p.type) && kindOf(p.type) !== 'body') ??
      null;
    const fromLayout = owner === scene.slide && scene.layout ? match(scene.layout.shapes, ph) : null;
    if (fromLayout) out.push(fromLayout);
    if (owner !== scene.master) {
      const type = fromLayout?.ph?.type ?? ph.type;
      const kind = kindOf(type);
      const masterType = kind === 'title' || kind === 'body' ? kind : type;
      const m = scene.master?.shapes.find((s) => s.ph != null && (s.ph.type === masterType || kindOf(s.ph.type) === masterType));
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Draws `shape`, in a group placed by `group` and filled with `groupFill` (null outside groups).
   * Always called through guarded(), which saves the canvas and restores it afterwards.
   */
  async drawShape(canvas, shape, scene, owner, group, groupFill = null) {
    if (shape.hidden) return;
    // An empty placeholder (only a slide's are drawn) doesn't show in PowerPoint's slide show or
    // its PDFs, whatever fill and outline it has: not even a space was typed in it.
    if (shape.ph != null && shape.kind === Kind.SHAPE && (shape.body == null || shape.body.paragraphs.every((p) => !p.pieces.length)) && shape.fill?.type !== 'image') return;
    const parents = shape.ph ? this.inherited(shape.ph, scene, owner) : [];
    const own = shape.xfrm ?? parents.find((p) => p.xfrm)?.xfrm ?? null;
    if (!own) return;
    // In a flipped group the shape is mirrored: where it is, which way it faces and turns.
    let xfrm = own;
    if (group) {
      const [rotation, flipH, flipV] = group.mirror(own.rotation, own.flipH, own.flipV);
      xfrm = { rect: own.rect, rotation, flipH, flipV };
    }
    const rect = group ? group.place(xfrm.rect) : xfrm.rect;
    switch (shape.kind) {
      case Kind.GROUP: {
        const inner = new GroupFrame(rect, shape.childOffset, shape.childExtent, xfrm.flipH, xfrm.flipV);
        const innerFill = shape.groupFill ? groupFill : shape.fill;
        this.rotate(canvas, xfrm, rect);
        for (const child of shape.children) await this.guarded(canvas, child, () => this.drawShape(canvas, child, scene, owner, inner, innerFill));
        return;
      }
      case Kind.TABLE:
        if (shape.table) await this.drawTable(canvas, shape.table, rect, scene, owner);
        return;
      case Kind.GRAPHIC:
        (await StandInPicture.create(shape.caption)).draw(canvas, rect);
        return;
      default:
        break;
    }
    this.rotate(canvas, xfrm, rect);
    // The outline, with its adjustments, is the shape's own, or else the placeholder's it takes after.
    const source = shape.geometry != null || shape.custom != null ? shape : parents.find((p) => p.geometry != null || p.custom != null) ?? null;
    const geometry = source?.geometry ?? (source == null && shape.kind !== Kind.PICTURE ? 'rect' : null);
    const adjust = source?.adjust ?? shape.adjust;
    const fill = shape.groupFill
      ? groupFill ?? Fill.NONE
      : shape.fill ?? parents.find((p) => p.fill)?.fill ?? (shape.styleFill != null ? Fill.solid(shape.styleFill) : null);
    let line = shape.line ?? parents.find((p) => p.line)?.line ?? null;
    if (line == null) line = shape.styleLine != null ? new Outline(shape.styleLine, 0.75, false) : null;
    else if (line.color == null && line.width > 0) line = shape.styleLine != null ? line.copy({ color: shape.styleLine }) : null;
    const picture = fill?.type === 'image' ? await this.images.picture(fill.path, rect.width, rect.height, fill.crop) : null;
    const custom = source?.custom ?? null;
    // Freeform shapes whose points need formulas are left out (their text still shows).
    if (shape.kind === Kind.PICTURE || custom == null || custom.length) {
      // How much a group shrinks or stretches the shape: a path without a size of its own is in the shape's EMUs.
      const unit = group ? group.place(new OfficeRect(0, 0, 1, 1)) : null;
      drawGeometry(canvas, {
        rect, rotation: 0, flipH: xfrm.flipH, flipV: xfrm.flipV,
        picture: shape.kind === Kind.PICTURE, geometry, adjust,
        custom: shape.kind === Kind.PICTURE ? null : custom,
        groupScale: [unit?.width ?? 1, unit?.height ?? 1],
        fill, line,
      }, { picture: (f) => (f === fill ? picture : null) });
    }
    const body = shape.body;
    if (body && hasText(body)) {
      const placed = shape.textRect ? (group ? group.place(shape.textRect) : shape.textRect) : rect;
      const textBox = edges(placed);
      // Flipped upside down, a shape's text is too: a vertical flip is a half turn and a mirroring,
      // and text follows the turn but is never mirrored. (SmartArt places its text by a frame of its own.)
      if (xfrm.flipV && shape.textRect == null) rotateAbout(canvas, 180, (textBox.left + textBox.right) / 2, (textBox.top + textBox.bottom) / 2);
      const looks = parents.map((p) => p.body?.look).filter(Boolean);
      await drawText(this, canvas, body, textBox, this.textChain(shape, parents, scene, owner), looks, shape.styleFont, scene.number, fill);
    }
  }

  rotate(canvas, xfrm, rect) {
    if (xfrm.rotation) rotateAbout(canvas, xfrm.rotation, rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  /** The text styles a shape's paragraphs inherit, nearest first, per level. */
  textChain(shape, parents, scene, owner) {
    const chain = [];
    if (shape.body) chain.push(shape.body.levels);
    if (shape.styleFont != null) {
      const look = levelLook({ run: runLook({ color: shape.styleFont }) });
      chain.push(new Map([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => [i, look])));
    }
    for (const parent of parents) if (parent.body) chain.push(parent.body.levels);
    const master = scene.master ?? owner;
    const kind = shape.ph ? kindOf(parents.find((p) => p.ph?.type != null)?.ph.type ?? shape.ph.type) : null;
    if (kind === 'title' || kind === 'body') {
      const styles = master.textStyles.get(kind);
      if (styles) chain.push(styles);
    } else {
      const styles = master.textStyles.get('other');
      if (styles) chain.push(styles);
      chain.push(this.defaultText(master));
    }
    return chain;
  }

  async drawTable(canvas, table, rect, scene, owner) {
    const template = scene.master ?? owner;
    const ctx = new Ctx(this.pkg, '', template.theme, template.colorMap);
    const style = (await this.tableStyle(table.styleId, ctx)) ?? (table.styleId != null ? defaultTableStyle(ctx) : null);
    const chain = [scene.master?.textStyles.get('other'), this.defaultText(template)].filter(Boolean);
    await drawTable(this, canvas, table, rect, style, chain, scene.number);
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Converts a PowerPoint presentation (.pptx) into a PDF: one page per slide that isn't hidden, in
 * order, the size of the slides. Call it through convertOffice('powerpoint', ...) (index.js),
 * which checks the file first and turns failures into the app's messages.
 *
 * @param {{ name: string, bytes: Uint8Array }} input   a .pptx file
 * @param {{ name?: string }} [options]   name: the PDF's name as typed, without ".pdf"
 * @param {{ onProgress?: (done: number, total: number, info?: { compressing: boolean }) => void, signal?: AbortSignal, onLeftOut?: (error: Error, shapeName: string) => void }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number }>}
 *   Throws OfficeNothingToConvert (no slides, or only hidden ones), ZipError and XmlError (a
 *   damaged file), the text engine's UserError('web_fonts_unavailable'), or CancelledError.
 */
export async function convertPptx(input, options = {}, hooks = {}) {
  checkCancelled(hooks.signal);
  const pkg = await OfficePackage.open(input.bytes, { signal: hooks.signal });
  try {
    const pdf = await OfficePdf.create();
    const images = new OfficeImages(pkg, pdf.doc, { signal: hooks.signal });
    const { bytes, pageCount } = await new PptxConverter(pkg, pdf, images, hooks).convert();
    return { name: officeOutputName(input, 'powerpoint', options?.name ?? null), bytes, type: 'application/pdf', pageCount };
  } finally {
    pkg.close();
  }
}
