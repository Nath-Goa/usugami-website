// The small "Usugami" mark's look and place (core/MarkLayout.kt: MarkStyle and MarkLayout): pure,
// without pdf-lib, so the result screen can show it before any PDF is read. engine/page-mark.js
// puts it in PDFs and re-exports all of this.

export const DEFAULT_SIZE = 20;
export const DEFAULT_OPACITY = 30;
export const MIN_OPACITY = 10;

/**
 * The mark's look, as the result screen's sliders set it: `size` from 0 (smallest) to 100
 * (largest), and `opacity` in percent, from MIN_OPACITY (barely visible) to 100 (solid). Both
 * whole numbers; out of range throws RangeError (MarkStyle.of brings values into range).
 * @example new MarkStyle({ size: 0 })   // the smallest, at the default opacity
 */
export class MarkStyle {
  constructor({ size = DEFAULT_SIZE, opacity = DEFAULT_OPACITY } = {}) {
    if (!Number.isInteger(size) || size < 0 || size > 100) throw new RangeError(`Size must be 0 to 100, not ${size}`);
    if (!Number.isInteger(opacity) || opacity < MIN_OPACITY || opacity > 100) {
      throw new RangeError(`Opacity must be ${MIN_OPACITY} to 100, not ${opacity}`);
    }
    this.size = size;
    this.opacity = opacity;
    Object.freeze(this);
  }

  /** How much of the page the mark covers, from 0.1 to 1. */
  get alpha() {
    return this.opacity / 100;
  }

  /** Whether `other` (a MarkStyle or { size, opacity }) is the same style. */
  equals(other) {
    return !!other && other.size === this.size && other.opacity === this.opacity;
  }

  /** The style with `size` and `opacity`, each rounded and brought into its range, as read from settings or a PDF. */
  static of(size, opacity) {
    const whole = (v, fallback) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
    return new MarkStyle({
      size: Math.min(100, Math.max(0, whole(size, DEFAULT_SIZE))),
      opacity: Math.min(100, Math.max(MIN_OPACITY, whole(opacity, DEFAULT_OPACITY))),
    });
  }
}

/** `style` as a MarkStyle (from a MarkStyle or a plain { size, opacity }), or null for none. */
export function markStyle(style) {
  if (style == null || style === false) return null;
  if (style instanceof MarkStyle) return style;
  return MarkStyle.of(style.size, style.opacity);
}

/** Whether `a` and `b` (MarkStyles, plain styles or null for none) are the same mark. */
export function sameMark(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.size === b.size && a.opacity === b.opacity;
}

const TEXT_WIDTH = 4.223;
const MARGIN = 1;

/**
 * Where the mark goes on a page as shown (its crop box, turned by its rotation): upright in its
 * bottom-right corner, kept from the right and bottom edges by MARGIN font sizes, in Helvetica Bold.
 * Its size sets the word's width as a share of the shown page's width: from MIN_WIDTH, which is
 * barely readable on a whole page seen on a phone, to MAX_WIDTH, where the word starts on the page's
 * middle. In between the share grows geometrically, so the small end, where most will want it, has
 * the finest control.
 */
export const MarkLayout = Object.freeze({
  TEXT: 'Usugami',
  /** The word's width in Helvetica Bold, in font sizes: its letters' widths are 4223 thousandths. */
  TEXT_WIDTH,
  /** How far its "g" reaches below the baseline, in font sizes. */
  DESCENT: 0.217,
  /** How far the word keeps from the shown page's right and bottom edges, in font sizes. */
  MARGIN,
  /** The word's width as a share of the shown page's width at the smallest size: about a 5.6 pt font on A4. */
  MIN_WIDTH: 0.04,
  /** At the largest size: the word then starts on the middle of the page. */
  MAX_WIDTH: TEXT_WIDTH / (2 * (TEXT_WIDTH + MARGIN)),
  /** The font size is at most this share of the shown page's height, for a page much wider than tall. */
  MAX_HEIGHT: 0.25,
  /** The mark's grey, from 0 (black) to 1 (white): solid at full opacity, a light grey at 30%. */
  GRAY: 0.2,

  /** The word's width as a share of the shown page's width at `size` (0 to 100). */
  widthShare(size) {
    const s = Math.min(100, Math.max(0, size));
    return this.MIN_WIDTH * (this.MAX_WIDTH / this.MIN_WIDTH) ** (s / 100);
  },

  /**
   * Where the word goes in `style` on a page `shownWidth` × `shownHeight` as shown (origin
   * bottom-left, y up): its baseline starts at (x, y), in fontSize. Throws RangeError for a page
   * without width or height.
   * @param {{ size: number }} style
   * @returns {{ x: number, y: number, fontSize: number }}
   */
  place(style, shownWidth, shownHeight) {
    if (!(shownWidth > 0 && shownHeight > 0)) throw new RangeError('A page needs a width and a height');
    const fontSize = Math.min((this.widthShare(style.size) * shownWidth) / this.TEXT_WIDTH, this.MAX_HEIGHT * shownHeight);
    return {
      x: shownWidth - (this.MARGIN + this.TEXT_WIDTH) * fontSize,
      y: (this.MARGIN + this.DESCENT) * fontSize,
      fontSize,
    };
  },
});

const NEEDLE = [...'/UsugamiMark'].map((c) => c.charCodeAt(0));

/**
 * Whether `bytes` may hold Usugami's mark, told quickly without reading the PDF: each of the
 * mark's streams has /UsugamiMark in its dictionary, which is never compressed. False means it
 * certainly hasn't.
 * @param {Uint8Array} bytes
 */
export function mayCarryMark(bytes) {
  if (!bytes?.length) return false;
  // Searched from its "U", much rarer in a PDF than the "/" every name starts with.
  const first = NEEDLE[1];
  const n = NEEDLE.length;
  for (let i = bytes.indexOf(first, 1); i >= 1 && i + n - 1 <= bytes.length; i = bytes.indexOf(first, i + 1)) {
    if (bytes[i - 1] !== NEEDLE[0]) continue;
    let j = 2;
    while (j < n && bytes[i - 1 + j] === NEEDLE[j]) j++;
    if (j === n) return true;
  }
  return false;
}
