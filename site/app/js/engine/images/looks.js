// How a page looks in its PDF: as photographed, or cleaned up like a scan. A port of the app's
// DocumentLooks.kt (the pixel work) and PageLooks.kt (looks on pictures), on typed arrays.
//
// Every look but Original first finds the paper: what the page would show with no ink on it,
// shadows and the light's colour included. The picture is cut into blocks (about BLOCKS along its
// long side), and each block's paper is a bright level that most of its pixels reach (PAPER_SHARE of
// them are as bright or brighter), so print on it doesn't count. A morphological closing of those
// levels then fills blocks covered by a large heading or a dark box from the paper around them,
// while a shadow, which covers many blocks, keeps its edges. Dividing each pixel by the paper there
// makes the paper white everywhere: per channel for the colour looks, which white-balances the page.
//
// Then each look does its own:
// - Lighten puts part of the light back: the paper ends up as bright as the photo's own paper to the
//   power LIGHT_SHADE, at most LIGHT_PAPER but never darker than it was, and keeps part of its
//   colour. The ink is not deepened, so the page still looks like the photo, only better lit.
// - Enhanced makes WHITE and brighter white and deepens the ink along a gamma curve.
// - Super enhanced does so along a steeper curve, white from SUPER_WHITE, though a pale colour (a
//   stain) gets no more colour than Enhanced gives it; then makes clearly coloured pixels richer, so
//   paper and grey print stay neutral; then sharpens with an unsharp mask 3 pixels across.
// - Grayscale is Enhanced's brightness alone.
// - Black & white and Ink saver need only a threshold, but one that adapts to each part of the page
//   (Sauvola's, with the mean and spread of a window around each pixel kept as running sums). Pixels
//   darker than INK are always black, so the inside of a bold letter is never left white. Ink saver
//   then leaves large dark areas hollow.
//
// Brightness and contrast come last. On a colour or grey look they are a tone curve on each channel
// that keeps white white. A black-and-white look has no levels left to bend: they move the threshold
// instead. With neither set, every look is exactly as it was without them.
//
// Long work is written as generators that yield every 64 rows (where the app checks for
// cancelling), so the PDF builder can pause for the browser between them (canvas.js runAsync).
import {
  toImageData, newImageData, imageDataToCanvas, isImageData, runSync, runAsync,
} from './canvas.js';

/** The looks in the order the filter screen shows them, from the photo as it is to the most cleaned up. */
export const LOOKS = ['original', 'lighten', 'enhanced', 'super_enhanced', 'grayscale', 'black_white', 'ink_saver'];

/** Each look's name, a string key (strings.xml). */
export const LOOK_LABELS = {
  original: 'look_original',
  lighten: 'look_lighten',
  enhanced: 'look_enhanced',
  super_enhanced: 'look_super_enhanced',
  grayscale: 'look_grayscale',
  black_white: 'look_black_white',
  ink_saver: 'look_ink_saver',
};

/** Whether the look is black and white, a bit a pixel. */
export const isBilevel = (look) => look === 'black_white' || look === 'ink_saver';

/** Whether the look stays in colour. */
export const isColour = (look) => look === 'original' || look === 'lighten' || look === 'enhanced' || look === 'super_enhanced';

/** Brightness and contrast are each from -MAX_ADJUSTMENT to MAX_ADJUSTMENT; 0 leaves the look as it is. */
export const MAX_ADJUSTMENT = 100;

export const BLOCKS = 64;
export const PAPER_SHARE = 0.2;
export const CLOSING = 3;
export const DARKEST_PAPER = 0.3;
export const WHITE = 235;
export const GAMMA = 1.6;
export const LIGHT_WHITE = 245;
export const LIGHT_PAPER = 250;
export const LIGHT_SHADE = 0.4;
export const LIGHT_TINT = 0.6;
export const SUPER_WHITE = 228;
export const SUPER_GAMMA = 2.4;
export const RICHER = 0.4;
export const GREY_CHROMA = 32;
export const FULL_CHROMA = 96;
export const PALE = 200;
export const PALE_FADE = 40;
export const SHARPEN = 1.0;
export const SHARPEN_FLOOR = 4;
export const INK = 100;
export const SAUVOLA_K = 0.2;
export const SAUVOLA_R = 128.0;
export const WINDOW = 40;
export const DARKNESS_SCALE = 1.6;
export const INK_SCALE = 1.4;
export const SPREAD_PIVOT = 32.0;
export const SPREAD_STRETCH = 2.0;
export const HIGHEST_THRESHOLD = 0.92;
export const HOLLOW = 0.015;
export const OUTLINE = 0.002;
export const BRIGHTNESS_POWER = 2.2;
export const CONTRAST_POWER = 2.5;
export const FADE = 0.35;
/** A pixel this bright on the darkest paper around it starts to count as paper (see normalized). */
const EDGE = 200;

/**
 * `adjustments` checked: whole numbers within ±MAX_ADJUSTMENT. Throws RangeError otherwise.
 * @returns {{ brightness: number, contrast: number }}
 */
export function lookAdjustments({ brightness = 0, contrast = 0 } = {}) {
  const b = Math.round(Number(brightness));
  const c = Math.round(Number(contrast));
  if (!(Math.abs(b) <= MAX_ADJUSTMENT && Math.abs(c) <= MAX_ADJUSTMENT)) {
    throw new RangeError(`Brightness ${brightness} and contrast ${contrast} must be within ±${MAX_ADJUSTMENT}`);
  }
  return { brightness: b + 0, contrast: c + 0 };
}

const isNone = (adj) => adj.brightness === 0 && adj.contrast === 0;

function checkLook(look) {
  if (!LOOKS.includes(look)) throw new RangeError(`Unknown look ${look}`);
}

// ---- Tables ----

/** Paper made white, ink deepened: WHITE and up to 255, the rest along a gamma curve. */
const CURVE = Int32Array.from({ length: 256 }, (_, v) => Math.trunc(255 * Math.pow(Math.min(1, v / WHITE), GAMMA) + 0.5));

/** As CURVE, white sooner and steeper. */
const SUPER_CURVE = Int32Array.from({ length: 256 }, (_, v) => Math.trunc(255 * Math.pow(Math.min(1, v / SUPER_WHITE), SUPER_GAMMA) + 0.5));

/** Lighten's: straight, LIGHT_WHITE and up to 1, as a part of the paper to put a pixel on. */
const LIGHT_CURVE = Float32Array.from({ length: 256 }, (_, v) => Math.min(255, Math.trunc(Math.fround(Math.fround(v * 255) / LIGHT_WHITE) + 0.5)) / 255);

const LINEAR = Int32Array.from({ length: 256 }, (_, v) => v);

/** The brightness of an sRGB colour, as the page finder and most photo apps take it. */
export const luma = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;

/** One 8-bit channel composited over white using `alpha`. */
const flatten = (value, alpha) => (alpha === 255 ? value : Math.trunc((value * alpha + 255 * (255 - alpha) + 127) / 255));

const rgb = (r, g, b) => (r << 16) | (g << 8) | b;

/**
 * The tone curve of `adjustments` for the colour and grey looks, a level for each of 0 to 255; it
 * never turns back, and keeps white white. Brightness first: up, 1 - (1 - v)^p, down, v^p, p up to
 * BRIGHTNESS_POWER. Then contrast: up, the S-shaped v^p / (v^p + (1 - v)^p); down, straight, with
 * black lifted towards FADE, as faded print.
 */
export function tones(adjustments) {
  const { brightness: bb, contrast: cc } = lookAdjustments(adjustments);
  const brightness = bb / MAX_ADJUSTMENT;
  const contrast = cc / MAX_ADJUSTMENT;
  const out = new Int32Array(256);
  for (let level = 0; level < 256; level++) {
    let v = level / 255;
    if (brightness > 0) v = 1 - Math.pow(1 - v, 1 + brightness * (BRIGHTNESS_POWER - 1));
    else if (brightness < 0) v = Math.pow(v, 1 - brightness * (BRIGHTNESS_POWER - 1));
    if (contrast > 0) {
      const p = 1 + contrast * (CONTRAST_POWER - 1);
      const a = Math.pow(v, p);
      v = a / (a + Math.pow(1 - v, p));
    } else if (contrast < 0) {
      v += -contrast * FADE * (1 - v);
    }
    out[level] = Math.min(255, Math.max(0, Math.trunc(v * 255 + 0.5)));
  }
  return out;
}

/** Half the width of the threshold's window for a `width` x `height` picture. */
export const windowRadius = (width, height) => Math.max(4, Math.floor(Math.max(width, height) / (2 * WINDOW)));

/** The side of the blocks the paper is found in. */
export const blockSize = (width, height) => Math.max(8, Math.ceil(Math.max(width, height) / BLOCKS));

/**
 * `v` on paper of brightness `paper`, made white: 0 to 255. Beside a shadow's hard edge the
 * interpolated paper is too bright, so a pixel as bright as the paper of the darkest of the blocks
 * around it is taken as paper on that block's level instead (gradually, by `weight`).
 */
function normalized(v, paper, darkest, weight) {
  const n = (v * 255) / paper;
  if (n >= WHITE || weight === 0) return Math.min(255, Math.trunc(n + 0.5));
  const m = (v * 255) / darkest;
  return Math.min(255, Math.trunc(n + weight * (m - n) + 0.5));
}

/** How much `v` counts as paper on the `darkest` paper around it: 0 not at all, to 1. */
function paperWeight(v, paper, darkest) {
  if ((v * 255) / paper >= WHITE) return 0;
  const m = (v * 255) / darkest;
  return m <= EDGE ? 0 : Math.min(1, (m - EDGE) / (WHITE - EDGE));
}

// ---- The paper ----

/**
 * Finds the paper's level in each block of a picture, from its rows of one channel given one after
 * another: each block's histogram, and the level PAPER_SHARE of its pixels reach.
 */
export class PaperEstimator {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.block = blockSize(width, height);
    this.columns = Math.ceil(width / this.block);
    this.rows = Math.ceil(height / this.block);
    this.levels = new Float32Array(this.columns * this.rows);
    this.histograms = new Int32Array(this.columns * 256);
    this.histogramOf = Int32Array.from({ length: width }, (_, x) => Math.floor(x / this.block) * 256);
    this.y = 0;
  }

  addRow(values) {
    if (this.y >= this.height) throw new Error('More rows than the picture has');
    const { width, histograms, histogramOf } = this;
    for (let x = 0; x < width; x++) histograms[histogramOf[x] + values[x]]++;
    this.y++;
    if (this.y % this.block === 0 || this.y === this.height) {
      const blockRow = Math.floor((this.y - 1) / this.block);
      for (let column = 0; column < this.columns; column++) {
        const start = column * 256;
        let total = 0;
        for (let v = 0; v < 256; v++) total += histograms[start + v];
        const wanted = Math.max(1, Math.trunc(total * PAPER_SHARE));
        let seen = 0;
        let level = 255;
        while (level > 0) {
          seen += histograms[start + level];
          if (seen >= wanted) break;
          level--;
        }
        this.levels[blockRow * this.columns + column] = level;
        histograms.fill(0, start, start + 256);
      }
    }
  }

  /** The paper across the picture, once every row has been added. */
  finish() {
    if (this.y !== this.height) throw new Error(`Only ${this.y} of ${this.height} rows were added`);
    const closed = this.filter(this.filter(this.levels, Math.max), Math.min);
    const sorted = Float32Array.from(closed).sort();
    const brightest = sorted[Math.floor((closed.length * 9) / 10)];
    const floor = Math.max(24, Math.fround(brightest * Math.fround(DARKEST_PAPER)));
    for (let i = 0; i < closed.length; i++) closed[i] = Math.max(closed[i], floor);
    return new PaperMap(this.width, this.height, this.block, this.columns, this.rows, closed);
  }

  /** A separable max or min over the blocks within CLOSING of each. */
  filter(grid, pick) {
    const { columns, rows } = this;
    const reach = CLOSING;
    const across = new Float32Array(grid.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        let v = grid[r * columns + c];
        for (let k = Math.max(0, c - reach); k <= Math.min(columns - 1, c + reach); k++) v = pick(v, grid[r * columns + k]);
        across[r * columns + c] = v;
      }
    }
    const out = new Float32Array(grid.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        let v = across[r * columns + c];
        for (let k = Math.max(0, r - reach); k <= Math.min(rows - 1, r + reach); k++) v = pick(v, across[k * columns + c]);
        out[r * columns + c] = v;
      }
    }
    return out;
  }
}

/**
 * The paper's level across a picture, a value per block (levels, row after row), read back a row
 * of pixels at a time between the blocks' centres.
 */
export class PaperMap {
  constructor(width, height, block, columns, rows, levels) {
    this.width = width;
    this.height = height;
    this.block = block;
    this.columns = columns;
    this.rows = rows;
    this.levels = levels;
    this.firstColumn = new Int32Array(width);
    this.columnWeight = new Float32Array(width);
    this.blockRow = new Float32Array(columns);
    for (let x = 0; x < width; x++) {
      const at = Math.min(Math.max(Math.fround((x + 0.5) / block - 0.5), 0), columns - 1);
      const c = Math.min(Math.trunc(at), Math.max(0, columns - 2));
      this.firstColumn[x] = c;
      this.columnWeight[x] = columns === 1 ? 0 : at - c;
    }
  }

  /** The same blocks with other levels, one for each of these. */
  withLevels(levels) {
    if (levels.length !== this.levels.length) throw new Error(`${levels.length} levels for ${this.levels.length} blocks`);
    return new PaperMap(this.width, this.height, this.block, this.columns, this.rows, levels);
  }

  /** The paper's level at each pixel of row y, into out, and the darkest of the four blocks around each pixel into darkest if given. */
  row(y, out, darkest = null) {
    const { columns, rows, levels, blockRow, firstColumn, columnWeight, width } = this;
    const at = Math.min(Math.max(Math.fround((y + 0.5) / this.block - 0.5), 0), rows - 1);
    const r = Math.min(Math.trunc(at), Math.max(0, rows - 2));
    const t = rows === 1 ? 0 : at - r;
    const r2 = Math.min(r + 1, rows - 1);
    for (let c = 0; c < columns; c++) blockRow[c] = levels[r * columns + c] * (1 - t) + levels[r2 * columns + c] * t;
    for (let x = 0; x < width; x++) {
      const c = firstColumn[x];
      const w = columnWeight[x];
      const c2 = Math.min(c + 1, columns - 1);
      out[x] = blockRow[c] * (1 - w) + blockRow[c2] * w;
      if (darkest) {
        darkest[x] = Math.min(
          Math.min(levels[r * columns + c], levels[r * columns + c2]),
          Math.min(levels[r2 * columns + c], levels[r2 * columns + c2]),
        );
      }
    }
  }

  /** The level found for block (column, row), for tests. */
  blockLevel(column, row) {
    return this.levels[row * this.columns + column];
  }
}

/** The paper under a picture, per channel, read back a row at a time. */
class Paper {
  constructor(red, green, blue) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    const width = red.width;
    this.width = width;
    this.levelR = new Float32Array(width);
    this.levelG = new Float32Array(width);
    this.levelB = new Float32Array(width);
    this.darkestR = new Float32Array(width);
    this.darkestG = new Float32Array(width);
    this.darkestB = new Float32Array(width);
  }

  /** Row y of the picture (RGBA at `offset` of `data`) divided by the paper, into r, g and b: 0 to 255, the paper 255. */
  whitened(y, data, offset, r, g, b) {
    const { levelR, levelG, levelB, darkestR, darkestG, darkestB, width } = this;
    this.red.row(y, levelR, darkestR);
    this.green.row(y, levelG, darkestG);
    this.blue.row(y, levelB, darkestB);
    for (let x = 0, i = offset; x < width; x++, i += 4) {
      const a = data[i + 3];
      const vr = flatten(data[i], a);
      const vg = flatten(data[i + 1], a);
      const vb = flatten(data[i + 2], a);
      // One weight for all three, so the paper beside a shadow doesn't get coloured speckles.
      const t = (paperWeight(vr, levelR[x], darkestR[x]) + paperWeight(vg, levelG[x], darkestG[x]) + paperWeight(vb, levelB[x], darkestB[x])) / 3;
      r[x] = normalized(vr, levelR[x], darkestR[x], t);
      g[x] = normalized(vg, levelG[x], darkestG[x], t);
      b[x] = normalized(vb, levelB[x], darkestB[x], t);
    }
  }

  /**
   * The paper Lighten leaves on each block, per channel: as bright as the paper found to the power
   * LIGHT_SHADE (against the page's brightest, which ends up at LIGHT_PAPER), and its colour, against
   * its brightness, to the power LIGHT_TINT; but never darker than that paper.
   */
  lit() {
    const count = this.red.levels.length;
    const R = this.red.levels;
    const G = this.green.levels;
    const B = this.blue.levels;
    const brightness = new Float32Array(count);
    for (let i = 0; i < count; i++) brightness[i] = (R[i] * 77 + G[i] * 150 + B[i] * 29) / 256;
    const brightest = Float32Array.from(brightness).sort()[Math.floor((count * 9) / 10)];
    const lit = (paper) => {
      const levels = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const light = Math.pow(brightness[i] / brightest, LIGHT_SHADE);
        const tint = Math.pow(paper.levels[i] / brightness[i], LIGHT_TINT);
        levels[i] = Math.min(255, Math.max(paper.levels[i], LIGHT_PAPER * light * tint));
      }
      return paper.withLevels(levels);
    };
    return new Paper(lit(this.red), lit(this.green), lit(this.blue));
  }

  /** Lighten on row y, this being its paper, from the row's channels on paper made white, into `row` through `toneTable`. */
  lightened(y, r, g, b, toneTable, row) {
    const { levelR, levelG, levelB, width } = this;
    this.red.row(y, levelR);
    this.green.row(y, levelG);
    this.blue.row(y, levelB);
    for (let x = 0; x < width; x++) {
      row[x] = rgb(
        toneTable[Math.trunc(LIGHT_CURVE[r[x]] * levelR[x] + 0.5)],
        toneTable[Math.trunc(LIGHT_CURVE[g[x]] * levelG[x] + 0.5)],
        toneTable[Math.trunc(LIGHT_CURVE[b[x]] * levelB[x] + 0.5)],
      );
    }
  }
}

/**
 * A Super enhanced colour made richer: a pixel whose channels differ by more than GREY_CHROMA has
 * them drawn further from its brightest channel, by up to RICHER times `strength` more, never so
 * far that one passes 0, which keeps its hue.
 */
function richer(r, g, b, strength) {
  const high = Math.max(r, g, b);
  const chroma = high - Math.min(r, g, b);
  if (chroma <= GREY_CHROMA || strength <= 0) return rgb(r, g, b);
  const more = Math.min(1, (chroma - GREY_CHROMA) / (FULL_CHROMA - GREY_CHROMA)) * strength;
  const k = Math.min(1 + RICHER * more, high / chroma);
  return rgb(Math.trunc(high - (high - r) * k + 0.5), Math.trunc(high - (high - g) * k + 0.5), Math.trunc(high - (high - b) * k + 0.5));
}

/**
 * A pixel of Super enhanced before it is sharpened, from its channels on paper made white: each
 * along SUPER_CURVE, then richer. A colour as bright as PALE is given no more colour than Enhanced
 * gives it and isn't made richer; one PALE_FADE darker or more is left to the curve and made fully
 * richer, in between in proportion.
 */
function superEnhancedPixel(r, g, b) {
  const pale = Math.min(1, Math.max(0, (luma(r, g, b) - (PALE - PALE_FADE)) / PALE_FADE));
  const cr = SUPER_CURVE[r];
  const cg = SUPER_CURVE[g];
  const cb = SUPER_CURVE[b];
  const high = Math.max(cr, cg, cb);
  const chroma = high - Math.min(cr, cg, cb);
  // The colour Enhanced gives it: that curve never turns back, so it keeps which channels are brightest and darkest.
  const enhanced = CURVE[Math.max(r, g, b)] - CURVE[Math.min(r, g, b)];
  if (pale === 0 || chroma <= enhanced) return richer(cr, cg, cb, 1 - pale);
  const k = 1 - pale * (1 - enhanced / chroma);
  return richer(
    Math.trunc(high - (high - cr) * k + 0.5),
    Math.trunc(high - (high - cg) * k + 0.5),
    Math.trunc(high - (high - cb) * k + 0.5),
    1 - pale,
  );
}

/**
 * Super enhanced's unsharp mask, on rows handed to it one after another: each pixel's brightness
 * less the mean of the 3 x 3 pixels round it (weighted 1 2 1 each way) is the detail the photo's
 * softness took away; less SHARPEN_FLOOR, it is added back SHARPEN times to each channel. A row goes
 * to `target` (through `toneTable`) once the row below it has come.
 */
class Sharpener {
  constructor(width, height, toneTable, target) {
    this.width = width;
    this.height = height;
    this.tones = toneTable;
    this.target = target;
    this.rows = [new Int32Array(width), new Int32Array(width), new Int32Array(width)];
    this.lumas = [new Int32Array(width), new Int32Array(width), new Int32Array(width)];
    this.out = new Int32Array(width);
  }

  add(y, row) {
    this.rows[y % 3].set(row);
    const l = this.lumas[y % 3];
    for (let x = 0; x < this.width; x++) {
      const c = row[x];
      l[x] = luma((c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
    }
    if (y > 0) this.send(y - 1);
    if (y === this.height - 1) this.send(y);
  }

  send(y) {
    const { width, height, tones: tt, out } = this;
    const above = this.lumas[(y > 0 ? y - 1 : y) % 3];
    const here = this.lumas[y % 3];
    const below = this.lumas[(y < height - 1 ? y + 1 : y) % 3];
    const pixels = this.rows[y % 3];
    const last = width - 1;
    const floor = SHARPEN_FLOOR * 16;
    for (let x = 0; x <= last; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < last ? x + 1 : x;
      const mean = above[l] + 2 * above[x] + above[r] + 2 * (here[l] + 2 * here[x] + here[r]) + below[l] + 2 * below[x] + below[r];
      // In sixteenths of a level.
      const detail = here[x] * 16 - mean;
      const c = pixels[x];
      let add = 0;
      if (detail > floor) add = Math.trunc(((detail - floor) * SHARPEN) / 16 + 0.5);
      else if (detail < -floor) add = -Math.trunc(((-detail - floor) * SHARPEN) / 16 + 0.5);
      out[x] = rgb(
        tt[Math.min(255, Math.max(0, ((c >>> 16) & 0xff) + add))],
        tt[Math.min(255, Math.max(0, ((c >>> 8) & 0xff) + add))],
        tt[Math.min(255, Math.max(0, (c & 0xff) + add))],
      );
    }
    this.target(y, out);
  }
}

// ---- The looks ----

/** Writes a row of packed RGB into RGBA `data` at row y, opaque. */
function putRow(data, width, y, row) {
  for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
    const c = row[x];
    data[i] = (c >>> 16) & 0xff;
    data[i + 1] = (c >>> 8) & 0xff;
    data[i + 2] = c & 0xff;
    data[i + 3] = 255;
  }
}

/**
 * `source` (ImageData) with a colour look and adjustments, written into `out` (an RGBA array the
 * same size, which may be source.data itself: each row is read for the last time before it is
 * written). A generator: yields every 64 rows.
 */
export function* colourGen(source, look, adjustments, out = source.data) {
  if (!isColour(look)) throw new RangeError(`${look} isn't a colour look`);
  const adj = lookAdjustments(adjustments);
  const toneTable = isNone(adj) ? LINEAR : tones(adj);
  const { width, height, data } = source;
  if (look === 'original') {
    for (let y = 0; y < height; y++) {
      if ((y & 63) === 0) yield;
      for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
        const a = data[i + 3];
        out[i] = toneTable[flatten(data[i], a)];
        out[i + 1] = toneTable[flatten(data[i + 1], a)];
        out[i + 2] = toneTable[flatten(data[i + 2], a)];
        out[i + 3] = 255;
      }
    }
    return;
  }
  yield* cleanedGen(source, look, toneTable, out);
}

/**
 * The colour looks that find the paper: the picture is read once to find it per channel, then again
 * a row at a time, each pixel divided by the paper there and given the look, then the tones.
 */
function* cleanedGen(source, look, toneTable, out) {
  const { width, height, data } = source;
  const red = new PaperEstimator(width, height);
  const green = new PaperEstimator(width, height);
  const blue = new PaperEstimator(width, height);
  const r = new Int32Array(width);
  const g = new Int32Array(width);
  const b = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      const a = data[i + 3];
      r[x] = flatten(data[i], a);
      g[x] = flatten(data[i + 1], a);
      b[x] = flatten(data[i + 2], a);
    }
    red.addRow(r);
    green.addRow(g);
    blue.addRow(b);
  }
  const paper = new Paper(red.finish(), green.finish(), blue.finish());
  const lit = look === 'lighten' ? paper.lit() : null;
  const curve = Int32Array.from(CURVE, (v) => toneTable[v]);
  const target = (y, row) => putRow(out, width, y, row);
  const sharpener = look === 'super_enhanced' ? new Sharpener(width, height, toneTable, target) : null;
  const row = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    paper.whitened(y, data, y * width * 4, r, g, b);
    if (lit) {
      lit.lightened(y, r, g, b, toneTable, row);
    } else if (sharpener) {
      for (let x = 0; x < width; x++) row[x] = superEnhancedPixel(r[x], g[x], b[x]);
    } else {
      for (let x = 0; x < width; x++) row[x] = rgb(curve[r[x]], curve[g[x]], curve[b[x]]);
    }
    if (sharpener) sharpener.add(y, row);
    else target(y, row);
  }
}

/** The brightness of each pixel (flattened onto white), and the paper's. */
function* lumaAndPaperGen(source) {
  const { width, height, data } = source;
  const pixels = new Uint8Array(width * height);
  const estimator = new PaperEstimator(width, height);
  const row = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    const offset = y * width;
    for (let x = 0, i = offset * 4; x < width; x++, i += 4) {
      const a = data[i + 3];
      const v = luma(flatten(data[i], a), flatten(data[i + 1], a), flatten(data[i + 2], a));
      row[x] = v;
      pixels[offset + x] = v;
    }
    estimator.addRow(row);
  }
  return { image: { width, height, pixels }, paper: estimator.finish() };
}

/** Each pixel of `image` divided by the paper there, then through `curve`. */
function* normalizeGen(image, paper, curve) {
  const { width, height, pixels } = image;
  const levels = new Float32Array(width);
  const darkest = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    paper.row(y, levels, darkest);
    const offset = y * width;
    for (let x = 0; x < width; x++) {
      const v = pixels[offset + x];
      pixels[offset + x] = curve[normalized(v, levels[x], darkest[x], paperWeight(v, levels[x], darkest[x]))];
    }
  }
}

/**
 * `source` (ImageData) with the Grayscale look and adjustments: a byte a pixel, 0 black to 255 white.
 * A generator returning { width, height, pixels: Uint8Array }.
 */
export function* grayscaleGen(source, adjustments) {
  const adj = lookAdjustments(adjustments);
  const { image, paper } = yield* lumaAndPaperGen(source);
  let curve = CURVE;
  if (!isNone(adj)) {
    const t = tones(adj);
    curve = Int32Array.from(CURVE, (v) => t[v]);
  }
  yield* normalizeGen(image, paper, curve);
  return image;
}

/**
 * `source` (ImageData) with a black-and-white look (black_white or ink_saver) and adjustments. A
 * generator returning a BitImage { width, height, rowBytes, data }: rows of rowBytes bytes, the
 * leftmost pixel in the high bit, 1 for white and 0 for black, as a PDF's DeviceGray reads them;
 * unused bits at a row's end are 1.
 */
export function* blackAndWhiteGen(source, look = 'black_white', adjustments) {
  if (!isBilevel(look)) throw new RangeError(`${look} isn't a black-and-white look`);
  const adj = lookAdjustments(adjustments);
  const bits = yield* thresholdedGen(source, adj);
  if (look === 'ink_saver') yield* hollowGen(bits);
  return bits;
}

/** Black & white, in a function of its own so that the grey picture it is made from is let go before ink saver's work. */
function* thresholdedGen(source, adj) {
  const { image, paper } = yield* lumaAndPaperGen(source);
  yield* normalizeGen(image, paper, LINEAR);
  return yield* thresholdGen(image, adj);
}

/** A white BitImage `width` x `height`. */
export function bitImage(width, height) {
  if (!(width > 0 && height > 0)) throw new RangeError(`A ${width} x ${height} picture`);
  const rowBytes = (width + 7) >> 3;
  return { width, height, rowBytes, data: new Uint8Array(rowBytes * height).fill(0xff) };
}

/** Whether pixel (x, y) of a BitImage is black. */
export function isBlack(bits, x, y) {
  return ((bits.data[y * bits.rowBytes + (x >>> 3)] >> (7 - (x & 7))) & 1) === 0;
}

/**
 * Sauvola's threshold on a grey `image` (its paper already white): black where a pixel is darker
 * than its window's mean m lowered by k (1 - s / R), s the window's standard deviation, or darker
 * than INK. Brightness scales how far below the mean it sits, by up to DARKNESS_SCALE either way, and
 * lowers or raises INK by up to INK_SCALE; contrast raises INK and stretches the windows' spreads away
 * from SPREAD_PIVOT, by up to SPREAD_STRETCH times. Neither puts a threshold above HIGHEST_THRESHOLD
 * of its mean that wasn't there already, so the paper's grain stays white.
 */
export function* thresholdGen(image, adjustments) {
  const adj = lookAdjustments(adjustments);
  const { width, height, pixels } = image;
  const plain = isNone(adj);
  const lighter = adj.brightness / MAX_ADJUSTMENT;
  const contrast = adj.contrast / MAX_ADJUSTMENT;
  const darkness = SAUVOLA_K * Math.pow(DARKNESS_SCALE, lighter);
  const ink = INK * Math.pow(INK_SCALE, contrast - lighter);
  const steepness = Math.pow(SPREAD_STRETCH, contrast);
  const radius = windowRadius(width, height);
  const out = bitImage(width, height);
  const { rowBytes, data } = out;
  const columnSum = new Int32Array(width);
  const columnSquares = new Float64Array(width);
  let top = 0;
  let bottom = -1;
  const addRow = (y, sign) => {
    const offset = y * width;
    for (let x = 0; x < width; x++) {
      const v = pixels[offset + x];
      columnSum[x] += sign * v;
      columnSquares[x] += sign * v * v;
    }
  };
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    const newBottom = Math.min(height - 1, y + radius);
    const newTop = Math.max(0, y - radius);
    while (bottom < newBottom) addRow(++bottom, 1);
    while (top < newTop) addRow(top++, -1);
    const rows = bottom - top + 1;
    let sum = 0;
    let squares = 0;
    let left = 0;
    let right = -1;
    const offset = y * width;
    const rowStart = y * rowBytes;
    let bits = 0;
    for (let x = 0; x < width; x++) {
      const newRight = Math.min(width - 1, x + radius);
      const newLeft = Math.max(0, x - radius);
      while (right < newRight) {
        right++;
        sum += columnSum[right];
        squares += columnSquares[right];
      }
      while (left < newLeft) {
        sum -= columnSum[left];
        squares -= columnSquares[left];
        left++;
      }
      const v = pixels[offset + x];
      let black;
      if (v < ink) {
        black = true;
      } else {
        const n = (right - left + 1) * rows;
        const mean = sum / n;
        // At or above the mean, a pixel is white whatever the spread.
        if (v >= mean) {
          black = false;
        } else {
          const deviation = Math.sqrt(Math.max(0, squares / n - mean * mean));
          const threshold = mean * (1 + SAUVOLA_K * (deviation / SAUVOLA_R - 1));
          if (plain) {
            black = v < threshold;
          } else {
            const spread = Math.min(SAUVOLA_R, SPREAD_PIVOT + steepness * (deviation - SPREAD_PIVOT));
            const adjusted = mean * (1 - darkness * (1 - spread / SAUVOLA_R));
            black = v < Math.min(adjusted, Math.max(threshold, mean * HIGHEST_THRESHOLD));
          }
        }
      }
      bits = (bits << 1) | (black ? 0 : 1);
      if ((x & 7) === 7) {
        data[rowStart + (x >>> 3)] = bits;
        bits = 0;
      }
    }
    const left8 = width & 7;
    if (left8 !== 0) {
      // The row's last pixels, then white padding.
      data[rowStart + rowBytes - 1] = ((bits << (8 - left8)) | ((1 << (8 - left8)) - 1)) & 0xff;
    }
  }
  return out;
}

const isBit = (bits, start, x) => ((bits[start + (x >>> 3)] >> (7 - (x & 7))) & 1) === 1;
const setBit = (bits, start, x) => { bits[start + (x >>> 3)] |= 0x80 >>> (x & 7); };

/**
 * Calls onRow(y, counts, areas) for every row of a `width` x `height` picture: for each pixel x,
 * how many of the pixels within `radius` of it (a square) are set in `mask` (a byte a pixel, 0 or
 * 1), and how many pixels that square holds, fewer where the picture's edge cuts it. The counts run
 * a column at a time, so a pixel costs the same whatever the radius.
 */
function* squareCountsGen(mask, width, height, radius, onRow) {
  const columns = new Int32Array(width);
  const counts = new Int32Array(width);
  const areas = new Int32Array(width);
  let top = 0;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) yield;
    const newBottom = Math.min(height - 1, y + radius);
    const newTop = Math.max(0, y - radius);
    while (bottom < newBottom) {
      bottom++;
      const o = bottom * width;
      for (let x = 0; x < width; x++) columns[x] += mask[o + x];
    }
    while (top < newTop) {
      const o = top * width;
      for (let x = 0; x < width; x++) columns[x] -= mask[o + x];
      top++;
    }
    const rows = bottom - top + 1;
    let sum = 0;
    let left = 0;
    let right = -1;
    for (let x = 0; x < width; x++) {
      const newRight = Math.min(width - 1, x + radius);
      const newLeft = Math.max(0, x - radius);
      while (right < newRight) sum += columns[++right];
      while (left < newLeft) sum -= columns[left++];
      counts[x] = sum;
      areas[x] = (right - left + 1) * rows;
    }
    onRow(y, counts, areas);
  }
}

/**
 * Ink saver: `bits` with each large dark area made white inside, but for an outline about OUTLINE of
 * the long side wide. An area is large where a square HOLLOW of the long side across (2 reach + 1
 * pixels) is black in it, but for at most 2 reach white pixels (fewer, in proportion, where the
 * picture's edge cuts the square). Those squares' centres, grown by the reach less the outline, are
 * made white, but only where no open white is within the outline: white that isn't a centre and
 * fills over a quarter of the pixels within the outline round it, so the paper or a white letter
 * rather than a speck. Beyond the picture's edge counts as black.
 */
function* hollowGen(bits) {
  const { width, height, rowBytes, data } = bits;
  const long = Math.max(width, height);
  const reach = Math.max(2, Math.floor((long * HOLLOW) / 2 + 0.5));
  const outline = Math.min(Math.max(Math.floor(long * OUTLINE + 0.5), 1), reach - 1);
  const square = (2 * reach + 1) * (2 * reach + 1);
  // White pixels, a byte each, for the running counts.
  const white = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const start = y * rowBytes;
    for (let x = 0; x < width; x++) white[y * width + x] = (data[start + (x >>> 3)] >> (7 - (x & 7))) & 1;
  }
  // The centres of the squares, a bit each, 1 for a centre.
  const centres = new Uint8Array(rowBytes * height);
  let any = false;
  yield* squareCountsGen(white, width, height, reach, (y, counts, areas) => {
    const start = y * rowBytes;
    for (let x = 0; x < width; x++) {
      // At most 2 reach white pixels in a whole square, fewer in one the picture's edge cuts.
      if (counts[x] * square <= 2 * reach * areas[x]) {
        setBit(centres, start, x);
        any = true;
      }
    }
  });
  if (!any) return;
  // The open white, a byte each: not a centre, and white over a quarter of the pixels within the
  // outline round it, so not a speck.
  const open = new Uint8Array(width * height);
  yield* squareCountsGen(white, width, height, outline, (y, counts, areas) => {
    const start = y * rowBytes;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      if (counts[x] * 4 > areas[x] && white[o + x] === 1 && !isBit(centres, start, x)) open[o + x] = 1;
    }
  });
  // Where no open white is within the outline, a bit each.
  const inner = new Uint8Array(rowBytes * height);
  yield* squareCountsGen(open, width, height, outline, (y, counts) => {
    const start = y * rowBytes;
    for (let x = 0; x < width; x++) if (counts[x] === 0) setBit(inner, start, x);
  });
  // The centres grown into squares: across a row, then down the columns through the last row each
  // column was reached in, so a row is made white once the rows below that reach it are seen.
  const grow = reach - outline;
  const reached = new Int32Array(width).fill(-0x3fffffff);
  for (let seen = 0; seen < height + grow; seen++) {
    if ((seen & 63) === 0) yield;
    if (seen < height) {
      const start = seen * rowBytes;
      let x = 0;
      while (x < width) {
        if (!isBit(centres, start, x)) {
          x++;
          continue;
        }
        let end = x;
        while (end + 1 < width && isBit(centres, start, end + 1)) end++;
        for (let c = Math.max(0, x - grow); c <= Math.min(width - 1, end + grow); c++) reached[c] = seen;
        x = end + 1;
      }
    }
    const y = seen - grow;
    if (y < 0) continue;
    const start = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (reached[x] >= y - grow && isBit(inner, start, x)) setBit(data, start, x);
    }
  }
}

// ---- Looks on pictures (PageLooks.kt) ----

/**
 * The pixels of `source` with `look` as a generator returning one of:
 * { kind: 'colour', imageData } (RGBA, opaque), { kind: 'gray', gray: { width, height, pixels } }
 * or { kind: 'bilevel', bits: BitImage }. With `inPlace`, a colour look is written into `source`
 * (an ImageData) itself, without a second picture as large.
 */
export function* lookGen(source, look, adjustments, { inPlace = false } = {}) {
  checkLook(look);
  if (isColour(look)) {
    const target = inPlace ? source : newImageData(source.width, source.height);
    yield* colourGen(source, look, adjustments, target.data);
    return { kind: 'colour', imageData: target };
  }
  if (look === 'grayscale') return { kind: 'gray', gray: yield* grayscaleGen(source, adjustments) };
  return { kind: 'bilevel', bits: yield* blackAndWhiteGen(source, look, adjustments) };
}

/** A look's result (see lookGen) as RGBA ImageData, to show. */
export function lookToImageData(result) {
  if (result.kind === 'colour') return result.imageData;
  if (result.kind === 'gray') {
    const { width, height, pixels } = result.gray;
    const out = newImageData(width, height);
    const d = out.data;
    for (let p = 0, i = 0; p < pixels.length; p++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = pixels[p];
      d[i + 3] = 255;
    }
    return out;
  }
  const bits = result.bits;
  const out = newImageData(bits.width, bits.height);
  const d = out.data;
  for (let y = 0, i = 0; y < bits.height; y++) {
    const start = y * bits.rowBytes;
    for (let x = 0; x < bits.width; x++, i += 4) {
      const v = ((bits.data[start + (x >>> 3)] >> (7 - (x & 7))) & 1) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return out;
}

function finishApplied(source, result, output) {
  const imageData = lookToImageData(result);
  const wantsImageData = output === 'imagedata' || (output == null && isImageData(source));
  if (wantsImageData) return imageData;
  return imageDataToCanvas(imageData, { dom: output === 'dom' || (output == null && typeof document !== 'undefined') });
}

/**
 * `source` as `look` shows it with brightness and contrast, as a new opaque picture of the same
 * size; `source` is left as it is. Synchronous: for previews (keep the picture small, about 1000 px).
 * @param {ImageData|HTMLCanvasElement|OffscreenCanvas|ImageBitmap|HTMLImageElement} source
 * @param {string} look one of LOOKS
 * @param {{ brightness?: number, contrast?: number }} [adjustments] each -100 to 100
 * @param {{ output?: 'imagedata' | 'canvas' | 'dom' }} [options] what to return: ImageData for an
 *   ImageData source, otherwise a canvas (an HTMLCanvasElement in a page, OffscreenCanvas in a worker)
 * @returns {ImageData|HTMLCanvasElement|OffscreenCanvas}
 */
export function applyLook(source, look, adjustments = {}, { output } = {}) {
  const pixels = toImageData(source);
  return finishApplied(source, runSync(lookGen(pixels, look, adjustments)), output);
}

/** As applyLook, pausing for the browser during the work; stops with CancelledError when `signal` is aborted. */
export async function applyLookAsync(source, look, adjustments = {}, { output, signal } = {}) {
  const pixels = toImageData(source);
  return finishApplied(source, await runAsync(lookGen(pixels, look, adjustments), { signal }), output);
}
