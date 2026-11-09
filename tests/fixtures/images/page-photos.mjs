// Synthetic photos of a page for the page detection tests, ported from the app's PageOutlineTest.kt:
// a sheet of paper with lines of print on a table, upright, tilted or at a slant, in shadow, with a
// folded corner, on a white or coloured desk. The noise comes from a port of Kotlin's Random
// (XorWow), so each photo is the one the app's own test makes.

/** Kotlin's kotlin.random.Random(seed): the XorWow generator, seeded as Kotlin seeds it. */
export class KotlinRandom {
  constructor(seed) {
    const seed1 = seed | 0;
    const seed2 = seed1 >> 31;
    this.x = seed1;
    this.y = seed2;
    this.z = 0;
    this.w = 0;
    this.v = ~seed1;
    this.addend = (seed1 << 10) ^ (seed2 >>> 4);
    for (let i = 0; i < 64; i++) this.nextInt();
  }

  nextInt() {
    let t = this.x;
    t ^= t >>> 2;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    const v0 = this.v;
    this.w = v0;
    t = (t ^ (t << 1)) ^ v0 ^ (v0 << 4);
    this.v = t;
    this.addend = (this.addend + 362437) | 0;
    return (t + this.addend) | 0;
  }

  nextBits(bitCount) {
    return (this.nextInt() >>> (32 - bitCount)) & (-bitCount >> 31);
  }

  /** A whole number from `from` (included) to `until` (left out). */
  nextIntIn(from, until) {
    const n = (until - from) | 0;
    if (n > 0 || n === -2147483648) {
      let rnd;
      if ((n & -n) === n) {
        rnd = this.nextBits(31 - Math.clz32(n));
      } else {
        let bits;
        let v;
        do {
          bits = this.nextInt() >>> 1;
          v = bits % n;
        } while (((bits - v + (n - 1)) | 0) < 0);
        rnd = v;
      }
      return from + rnd;
    }
    for (;;) {
      const rnd = this.nextInt();
      if (rnd >= from && rnd < until) return rnd;
    }
  }

  nextDouble() {
    const hi = this.nextBits(26);
    const lo = this.nextBits(27);
    return (hi * 134217728 + lo) / 9007199254740992;
  }

  nextDoubleIn(from, until) {
    const r = from + this.nextDouble() * (until - from);
    return r >= until ? until - Number.EPSILON * until : r;
  }
}

/** A 3 × 3 projective map, row by row (the last entry 1). */
export class Homography {
  constructor(m) {
    this.m = m;
  }

  map(x, y) {
    const m = this.m;
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  }

  inverse() {
    const [a, b, c, d, e, f, g, h, i] = this.m;
    const co = [e * i - f * h, -(b * i - c * h), b * f - c * e, -(d * i - f * g), a * i - c * g, -(a * f - c * d), d * h - e * g, -(a * h - b * g), a * e - b * d];
    const det = a * co[0] + b * co[3] + c * co[6];
    return new Homography(co.map((v) => v / det));
  }

  /** The unit square's corners (0,0), (1,0), (1,1), (0,1) onto `q` (Heckbert's square-to-quad). */
  static squareTo(q) {
    const [x0, y0] = [q[0].x, q[0].y];
    const [x1, y1] = [q[1].x, q[1].y];
    const [x2, y2] = [q[2].x, q[2].y];
    const [x3, y3] = [q[3].x, q[3].y];
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const dy3 = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / den;
    const h = (dx1 * dy3 - dx3 * dy1) / den;
    return new Homography([x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]);
  }
}

const f32 = Math.fround;

/** Four corners from eight fractions, as the Kotlin tests' corners(...) (Floats). */
export function corners(...xy) {
  return [0, 1, 2, 3].map((i) => ({ x: f32(xy[2 * i]), y: f32(xy[2 * i + 1]) }));
}

/** `cx`, `cy` the centre, `w` × `h` the size (fractions of a `photoWidth` × `photoHeight` photo) turned by `degrees`. */
export function turned(cx, cy, w, h, degrees, photoWidth, photoHeight) {
  const r = degrees * Math.PI / 180;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const dx = sx * w / 2 * photoWidth;
    const dy = sy * h / 2 * photoWidth;
    return {
      x: f32((cx * photoWidth + dx * Math.cos(r) - dy * Math.sin(r)) / photoWidth),
      y: f32((cy * photoHeight + dx * Math.sin(r) + dy * Math.cos(r)) / photoHeight),
    };
  });
}

/**
 * A grey photo `width` × `height` of a page whose corners (fractions of the photo, clockwise from
 * the page's top-left) are `corners`. Text lines run across the page; `shade` darkens a point of the
 * photo (1 = no shadow); `extra` paints more things on the table. The table is wood unless `desk`
 * gives its level at each point (fractions of the photo); a page on a desk casts a `shadow` that
 * much darker along its edges. With `deskColour`, rgba() makes a colour photo of the grey page on a
 * desk of that colour. `soft` blurs the grey photo that many pixels each way.
 */
export class Photo {
  constructor(width, height, pageCorners, opts = {}) {
    this.width = width;
    this.height = height;
    this.corners = pageCorners;
    this.paper = opts.paper ?? 226;
    this.table = opts.table ?? 72;
    this.noise = opts.noise ?? 10;
    this.seed = opts.seed ?? 1;
    this.shade = opts.shade ?? (() => 1);
    this.fold = opts.fold ?? 0;
    this.extra = opts.extra ?? (() => null);
    this.desk = opts.desk ?? null;
    this.shadow = opts.shadow ?? 0;
    this.deskColour = opts.deskColour ?? null;
    this.soft = opts.soft ?? 0;
    this.toPhoto = Homography.squareTo(pageCorners.map((c) => ({ x: f32(c.x * width), y: f32(c.y * height) })));
    this.toPage = this.toPhoto.inverse();
    this.xs = pageCorners.map((c) => c.x * width);
    this.ys = pageCorners.map((c) => c.y * height);
  }

  /** The grey photo, a byte a pixel. */
  luma() {
    if (this._luma) return this._luma;
    const { width, height, noise } = this;
    const random = new KotlinRandom(this.seed);
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Two samples a pixel across and down, for soft edges.
        let sum = 0;
        for (let sy = 0; sy <= 1; sy++) for (let sx = 0; sx <= 1; sx++) sum += this.level(x + 0.25 + sx * 0.5, y + 0.25 + sy * 0.5);
        const v = sum / 4 * this.shade(x / width, y / height) + random.nextIntIn(-noise, noise + 1);
        out[y * width + x] = Math.min(255, Math.max(0, Math.round(v)));
      }
    }
    if (this.soft === 0) return (this._luma = out);
    const soft = this.soft;
    const at = (x, y) => out[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    const blurred = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let dy = -soft; dy <= soft; dy++) for (let dx = -soft; dx <= soft; dx++) sum += at(i % width + dx, Math.floor(i / width) + dy);
      blurred[i] = Math.trunc(sum / ((2 * soft + 1) * (2 * soft + 1)));
    }
    return (this._luma = blurred);
  }

  /** The colour photo (with deskColour), 4 bytes a pixel as ImageData has it. */
  rgba() {
    if (this._rgba) return this._rgba;
    const colour = this.deskColour;
    const { width, height, noise } = this;
    const random = new KotlinRandom(this.seed);
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = Math.floor(i / width);
      for (let channel = 0; channel <= 2; channel++) {
        let sum = 0;
        for (let sy = 0; sy <= 1; sy++) {
          for (let sx = 0; sx <= 1; sx++) {
            const px = x + 0.25 + sx * 0.5;
            const py = y + 0.25 + sy * 0.5;
            sum += this.pageLevel(px, py) ?? (colour[channel] - this.shadowAt(px, py));
          }
        }
        const v = sum / 4 * this.shade(x / width, y / height) + random.nextIntIn(-noise, noise + 1);
        out[4 * i + channel] = Math.min(255, Math.max(0, Math.round(v)));
      }
      out[4 * i + 3] = 255;
    }
    return (this._rgba = out);
  }

  /** The photo in colour if it has one, else its grey as colour: 4 bytes a pixel. */
  pixels() {
    if (this.deskColour) return this.rgba();
    const luma = this.luma();
    const out = new Uint8ClampedArray(luma.length * 4);
    for (let i = 0; i < luma.length; i++) {
      out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = luma[i];
      out[4 * i + 3] = 255;
    }
    return out;
  }

  level(x, y) {
    const thing = this.extra(x / this.width, y / this.height);
    if (thing != null) return thing;
    const page = this.pageLevel(x, y);
    if (page != null) return page;
    if (!this.desk) return this.table + 10 * Math.sin(y / 9 + 3 * Math.sin(x / 70));
    return this.desk(x / this.width, y / this.height) - this.shadowAt(x, y);
  }

  /** The page's level at a point, or null off the page. */
  pageLevel(x, y) {
    const [u, v] = this.toPage.map(x, y);
    // A corner folded over: the table shows through a triangle at the page's top-right.
    const folded = this.fold > 0 && (1 - u) + v < this.fold;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1) || folded) return null;
    // Lines of print inside the margins, and a heading.
    const printed = u >= 0.12 && u <= 0.88 && ((v >= 0.1 && v <= 0.14) ||
      (v >= 0.2 && v <= 0.9 && Math.trunc((v - 0.2) / 0.035) % 2 === 0 && u < 0.88 - 0.2 * (Math.trunc(v * 37) % 3)));
    return printed ? 60 : this.paper;
  }

  /** How much the page's shadow darkens the desk at a point off the page: most at its edge, none 3 pixels out. */
  shadowAt(x, y) {
    if (this.shadow === 0) return 0;
    const { xs, ys } = this;
    let nearest = Infinity;
    for (let i = 0; i <= 3; i++) {
      const j = (i + 1) % 4;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      const t = Math.min(1, Math.max(0, ((x - xs[i]) * dx + (y - ys[i]) * dy) / (dx * dx + dy * dy)));
      nearest = Math.min(nearest, Math.hypot(x - xs[i] - t * dx, y - ys[i] - t * dy));
    }
    return this.shadow * Math.max(0, 1 - nearest / 3);
  }
}

/**
 * The crop tests' photo (the app's PagePhotos.kt): a white page with a coloured square in each
 * corner and a black line across its middle, lying seen a little from the side on a dark wooden
 * table, as RGBA pixels.
 */
export const PAGE_PHOTO = {
  PAGE_WIDTH: 700,
  PAGE_HEIGHT: 990,
  PHOTO_WIDTH: 1200,
  PHOTO_HEIGHT: 1600,
  CORNERS: [300, 260, 930, 330, 1010, 1350, 170, 1290],
  MARKS: [[220, 30, 30], [30, 170, 60], [30, 60, 220], [230, 190, 20]],
  MARK: 70,
};
PAGE_PHOTO.QUAD = [0, 1, 2, 3].map((i) => ({ x: PAGE_PHOTO.CORNERS[2 * i] / PAGE_PHOTO.PHOTO_WIDTH, y: PAGE_PHOTO.CORNERS[2 * i + 1] / PAGE_PHOTO.PHOTO_HEIGHT }));

/** PagePhotos.photo(): `width` × `height` with the page at `pageCorners` (pixels), as RGBA. */
export function pagePhoto(width = PAGE_PHOTO.PHOTO_WIDTH, height = PAGE_PHOTO.PHOTO_HEIGHT, pageCorners = PAGE_PHOTO.CORNERS) {
  const { PAGE_WIDTH: pw, PAGE_HEIGHT: ph, MARK, MARKS } = PAGE_PHOTO;
  const toPage = Homography.squareTo([0, 1, 2, 3].map((i) => ({ x: pageCorners[2 * i], y: pageCorners[2 * i + 1] }))).inverse();
  const out = new Uint8ClampedArray(width * height * 4);
  const pageColour = (u, v) => {
    // u, v in page pixels.
    const spots = [[0, 0], [pw - MARK, 0], [pw - MARK, ph - MARK], [0, ph - MARK]];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = spots[i];
      if (u >= sx && u < sx + MARK && v >= sy && v < sy + MARK) return MARKS[i];
    }
    if (u >= 100 && u < pw - 100 && v >= ph / 2 - 4 && v < ph / 2 + 4) return [0, 0, 0];
    return [242, 240, 234];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = 4 * (y * width + x);
      const grain = Math.trunc(12 * Math.sin(y / 9 + 3 * Math.sin(x / 70)));
      let r = 0;
      let g = 0;
      let b = 0;
      // Four samples a pixel, for smooth edges.
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const [u01, v01] = toPage.map(x + 0.25 + 0.5 * sx, y + 0.25 + 0.5 * sy);
          if (u01 >= 0 && u01 < 1 && v01 >= 0 && v01 < 1) {
            const c = pageColour(u01 * pw, v01 * ph);
            r += c[0]; g += c[1]; b += c[2];
          } else {
            r += 96 + grain; g += 66 + grain; b += 42 + grain;
          }
        }
      }
      out[o] = r / 4;
      out[o + 1] = g / 4;
      out[o + 2] = b / 4;
      out[o + 3] = 255;
    }
  }
  return out;
}
