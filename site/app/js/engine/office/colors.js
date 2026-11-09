// Colours in Office files (the OfficeColors object of the app's core/OfficeFormats.kt). Colours are
// ARGB numbers from 0 to 0xFFFFFFFF, never negative (opaque red is 0xFFFF0000), as the spreadsheet
// engine and the text engine take them. The arithmetic is Kotlin's Float arithmetic, so a scheme
// colour made lighter or darker comes out exactly as in the app.
import { trim, digitOf } from './xlsx-numbers-kt.js';

const f = Math.fround;

/** Kotlin's Float.mod(1f): the remainder, made positive. */
function mod1(x) {
  const r = f(x % 1);
  return r !== 0 && r < 0 ? f(r + 1) : r;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function toHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = f(f(max + min) / 2);
  if (max === min) return [0, 0, l];
  const d = f(max - min);
  const s = l > 0.5 ? f(d / f(f(2 - max) - min)) : f(d / f(max + min));
  let h;
  if (max === r) h = f(f(f(g - b) / d) + (g < b ? 6 : 0));
  else if (max === g) h = f(f(f(b - r) / d) + 2);
  else h = f(f(f(r - g) / d) + 4);
  return [f(h / 6), s, l];
}

function fromHsl(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? f(l * f(1 + s)) : f(f(l + s) - f(l * s));
  const p = f(f(2 * l) - q);
  const third = f(1 / 3);
  const sixth = f(1 / 6);
  const twoThirds = f(2 / 3);
  const hue = (t0) => {
    const t = mod1(t0);
    if (t < sixth) return f(p + f(f(f(q - p) * 6) * t));
    if (t < 0.5) return q;
    if (t < twoThirds) return f(p + f(f(f(q - p) * f(twoThirds - t)) * 6));
    return p;
  };
  return [hue(f(h + third)), hue(h), hue(f(h - third))];
}

/** Colours in Office files, as ARGB numbers. */
export const OfficeColors = Object.freeze({
  /** "4472C4" (with or without "#"), or null for "auto" and anything else. */
  hex(text) {
    if (text == null) return null;
    let t = trim(String(text));
    if (t.startsWith('#')) t = t.slice(1);
    if (t.length !== 6) return null;
    let v = 0;
    for (let i = 0; i < 6; i++) {
      const d = digitOf(t[i], 16);
      if (d < 0) return null;
      v = v * 16 + d;
    }
    return (0xff000000 + v) >>> 0;
  },

  /** Word's highlight colours (w:highlight). */
  highlight(name) {
    switch (name) {
      case 'yellow': return 0xffffff00;
      case 'green': return 0xff00ff00;
      case 'cyan': return 0xff00ffff;
      case 'magenta': return 0xffff00ff;
      case 'blue': return 0xff0000ff;
      case 'red': return 0xffff0000;
      case 'darkBlue': return 0xff000080;
      case 'darkCyan': return 0xff008080;
      case 'darkGreen': return 0xff008000;
      case 'darkMagenta': return 0xff800080;
      case 'darkRed': return 0xff800000;
      case 'darkYellow': return 0xff808000;
      case 'darkGray': return 0xff808080;
      case 'lightGray': return 0xffc0c0c0;
      case 'black': return 0xff000000;
      case 'white': return 0xffffffff;
      default: return null;
    }
  },

  /** The few DrawingML preset colours (a:prstClr) that show up in practice; others are black. */
  preset(name) {
    switch (name?.toLowerCase()) {
      case 'white': return 0xffffffff;
      case 'red': return 0xffff0000;
      case 'green': return 0xff008000;
      case 'lime': return 0xff00ff00;
      case 'blue': return 0xff0000ff;
      case 'yellow': return 0xffffff00;
      case 'gray': case 'grey': return 0xff808080;
      case 'silver': case 'ltgray': case 'lightgray': return 0xffc0c0c0;
      case 'dkgray': case 'darkgray': return 0xffa9a9a9;
      case 'orange': return 0xffffa500;
      case 'purple': return 0xff800080;
      case 'navy': return 0xff000080;
      case 'cyan': case 'aqua': return 0xff00ffff;
      case 'magenta': case 'fuchsia': return 0xffff00ff;
      default: return 0xff000000;
    }
  },

  /**
   * Applies DrawingML colour changes, in order: `modifiers` are [name, value] pairs, the element
   * names (such as "lumMod", "tint", "alpha") with their values in thousandths of a percent (75000
   * is 75%); those that take no value ("inv", "gray", "comp") with any.
   */
  modify(argb, modifiers) {
    const c = argb >>> 0;
    let a = f(((c >>> 24) & 0xff) / 255);
    let r = f(((c >>> 16) & 0xff) / 255);
    let g = f(((c >>> 8) & 0xff) / 255);
    let b = f((c & 0xff) / 255);
    for (const [name, raw] of modifiers) {
      const v = f(f(raw) / 100000);
      switch (name) {
        case 'alpha': a = v; break;
        case 'alphaMod': a = f(a * v); break;
        case 'alphaOff': a = f(a + v); break;
        case 'lumMod': case 'lumOff': case 'satMod': case 'satOff': case 'hueOff': case 'comp': {
          const hsl = toHsl(r, g, b);
          if (name === 'lumMod') hsl[2] = f(hsl[2] * v);
          else if (name === 'lumOff') hsl[2] = f(hsl[2] + v);
          else if (name === 'satMod') hsl[1] = f(hsl[1] * v);
          else if (name === 'satOff') hsl[1] = f(hsl[1] + v);
          // The complementary colour: across the colour wheel.
          else if (name === 'comp') hsl[0] = mod1(f(hsl[0] + 0.5));
          else hsl[0] = mod1(f(hsl[0] + f(f(f(raw) / 60000) / 360)));
          hsl[1] = clamp01(hsl[1]);
          hsl[2] = clamp01(hsl[2]);
          [r, g, b] = fromHsl(hsl[0], hsl[1], hsl[2]);
          break;
        }
        // Towards white, or towards black, by the share given.
        case 'tint':
          r = f(1 - f(f(1 - r) * v));
          g = f(1 - f(f(1 - g) * v));
          b = f(1 - f(f(1 - b) * v));
          break;
        case 'shade':
          r = f(r * v);
          g = f(g * v);
          b = f(b * v);
          break;
        case 'gray': {
          const y = f(f(f(f(0.3) * r) + f(f(0.59) * g)) + f(f(0.11) * b));
          r = y;
          g = y;
          b = y;
          break;
        }
        case 'inv':
          r = f(1 - r);
          g = f(1 - g);
          b = f(1 - b);
          break;
        default:
          break;
      }
    }
    const channel = (x) => Math.round(f(clamp01(x) * 255));
    return ((channel(a) << 24) | (channel(r) << 16) | (channel(g) << 8) | channel(b)) >>> 0;
  },

  /** Whether text in black would be hard to read on `argb`: a rough check of its brightness. */
  isDark(argb) {
    const c = argb >>> 0;
    return 0.299 * ((c >>> 16) & 0xff) + 0.587 * ((c >>> 8) & 0xff) + 0.114 * (c & 0xff) < 128;
  },

  /** The alpha of `argb`, from 0 to 255. */
  alpha(argb) {
    return ((argb >>> 0) >>> 24) & 0xff;
  },

  /** `argb` as a CSS colour, for screens: '#rrggbb' or 'rgba(r, g, b, a)'. */
  css(argb) {
    const c = argb >>> 0;
    const a = (c >>> 24) & 0xff;
    const hex = (c & 0xffffff).toString(16).padStart(6, '0');
    return a === 255 ? `#${hex}` : `rgba(${(c >>> 16) & 255}, ${(c >>> 8) & 255}, ${c & 255}, ${+(a / 255).toFixed(3)})`;
  },

  /** Android's Color.TRANSPARENT, BLACK and WHITE. */
  TRANSPARENT: 0,
  BLACK: 0xff000000,
  WHITE: 0xffffffff,
});
