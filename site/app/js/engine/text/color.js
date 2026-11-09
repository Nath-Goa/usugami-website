// Colours as the canvas takes them (CSS strings) and as the app's Kotlin passes them (ARGB
// integers, as Android's Color), turned into { r, g, b, a } with each part from 0 to 1.

const NAMED = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff,
  beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff,
  blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00,
  chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9,
  darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000,
  darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493,
  deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222,
  floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000,
  greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
  lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff,
  maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
  midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
  navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23,
  orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
  paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9,
  peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080,
  rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513,
  salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d,
  silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090,
  snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3,
  white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
};

const cache = new Map();

/**
 * `value` as { r, g, b, a } (0 to 1), or null when it isn't a colour. Takes CSS colours ('#c00',
 * '#rrggbbaa', 'rgb(…)', 'rgba(…)', 'hsl(…)', names, 'transparent'), ARGB integers (0xFF336699,
 * as Android's Color), and { r, g, b, a } objects.
 */
export function parseColor(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const v = value >>> 0;
    return { r: ((v >>> 16) & 255) / 255, g: ((v >>> 8) & 255) / 255, b: (v & 255) / 255, a: ((v >>> 24) & 255) / 255 };
  }
  if (typeof value === 'object') {
    if (typeof value.r !== 'number') return null;
    return { r: clamp01(value.r), g: clamp01(value.g), b: clamp01(value.b), a: clamp01(value.a ?? 1) };
  }
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const parsed = parseCss(key);
  if (cache.size > 500) cache.clear();
  cache.set(key, parsed);
  return parsed;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0;
}

function parseCss(s) {
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'currentcolor') return { r: 0, g: 0, b: 0, a: 1 };
  if (s in NAMED) {
    const v = NAMED[s];
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 };
  }
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const n = [...hex].map((c) => parseInt(c + c, 16) / 255);
      return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = [0, 2, 4, 6].map((i) => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) / 255 : 1));
      return { r: n[0], g: n[1], b: n[2], a: n[3] };
    }
    return null;
  }
  const m = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts.length === 4 ? number(parts[3], 1) : 1;
  if (alpha == null) return null;
  if (m[1].startsWith('rgb')) {
    const c = parts.slice(0, 3).map((p) => number(p, 255));
    if (c.some((x) => x == null)) return null;
    return { r: clamp01(c[0] / 255), g: clamp01(c[1] / 255), b: clamp01(c[2] / 255), a: clamp01(alpha) };
  }
  const h = parseFloat(parts[0]);
  const sat = number(parts[1], 1);
  const light = number(parts[2], 1);
  if (!Number.isFinite(h) || sat == null || light == null) return null;
  const [r, g, b] = hslToRgb((((h % 360) + 360) % 360) / 360, clamp01(sat), clamp01(light));
  return { r, g, b, a: clamp01(alpha) };
}

/** A CSS number; a percentage is a share of `full`. */
function number(text, full) {
  if (text === 'none') return 0;
  const pct = text.endsWith('%');
  const n = parseFloat(pct ? text.slice(0, -1) : text);
  if (!Number.isFinite(n)) return null;
  return pct ? (n / 100) * full : n;
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

/** Whether the colour is dark, as Word decides when its automatic text colour turns white (OfficeColors.isDark). */
export function isDark(color) {
  const c = parseColor(color);
  if (!c) return false;
  return 0.299 * c.r * 255 + 0.587 * c.g * 255 + 0.114 * c.b * 255 < 128;
}

/** The colour as a CSS string for a 2D canvas. */
export function cssColor(c) {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
}

export const BLACK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
export const WHITE = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
