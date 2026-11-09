// The eight ways to turn or flip an image (ImageTransform.kt), as a map of normalised coordinates
// (s, t) in [0,1]², origin top-left, t pointing down:
//
//   s' = a·s + b·t + c
//   t' = d·s + e·t + f
//
// A transform is a frozen plain object { a, b, c, d, e, f }.

const make = (a, b, c, d, e, f) => Object.freeze({ a, b, c, d, e, f });

export const IDENTITY = make(1, 0, 0, 0, 1, 0);
const ROTATE_90_CW = make(0, -1, 1, 1, 0, 0);

/** True when `t` turns the image sideways, so width and height trade places. */
export function swapsAxes(t) {
  return t.a === 0;
}

/** Whether two transforms are the same. */
export function sameTransform(p, q) {
  return p.a === q.a && p.b === q.b && p.c === q.c && p.d === q.d && p.e === q.e && p.f === q.f;
}

/** `t` followed by `next`. */
export function then(t, next) {
  return make(
    next.a * t.a + next.b * t.d,
    next.a * t.b + next.b * t.e,
    next.a * t.c + next.b * t.f + next.c,
    next.d * t.a + next.e * t.d,
    next.d * t.b + next.e * t.e,
    next.d * t.c + next.e * t.f + next.f,
  );
}

/** The transform that undoes `t`: from the image as shown back to the image as stored. */
export function inverse(t) {
  // The 2×2 part only swaps and flips axes, so its inverse is its transpose.
  return make(t.a, t.d, -(t.a * t.c + t.d * t.f) + 0, t.b, t.e, -(t.b * t.c + t.e * t.f) + 0);
}

/**
 * The PDF `cm` matrix [A B C D E F] that paints an image XObject (which always fills the unit
 * square, first row at the top) transformed by `t`, into the rectangle (x, y, width, height) on the
 * page, with y measured from the bottom.
 */
export function pdfMatrix(t, x, y, width, height) {
  return [
    width * t.a,
    -height * t.d,
    -width * t.b,
    height * t.e,
    x + width * (t.b + t.c),
    y + height * (1 - t.e - t.f),
  ];
}

/**
 * The canvas matrix [a, b, c, d, e, f] (for ctx.setTransform) that draws a `width` × `height`
 * image transformed by `t`, filling an `outWidth` × `outHeight` canvas (by default the image's size
 * as shown, width and height swapped when `t` turns it sideways).
 */
export function canvasMatrix(t, width, height, outWidth, outHeight) {
  const ow = outWidth ?? (swapsAxes(t) ? height : width);
  const oh = outHeight ?? (swapsAxes(t) ? width : height);
  // Pixel (px, py) is at s = px / width, t = py / height; it lands at (s' · ow, t' · oh).
  return [t.a * ow / width, t.d * oh / width, t.b * ow / height, t.e * oh / height, t.c * ow, t.f * oh];
}

/** The transform that displays an image stored with the given EXIF orientation (1–8) upright. */
export function fromExif(orientation) {
  switch (orientation) {
    case 2: return make(-1, 0, 1, 0, 1, 0); // mirror horizontally
    case 3: return make(-1, 0, 1, 0, -1, 1); // rotate 180°
    case 4: return make(1, 0, 0, 0, -1, 1); // mirror vertically
    case 5: return make(0, 1, 0, 1, 0, 0); // transpose
    case 6: return ROTATE_90_CW;
    case 7: return make(0, -1, 1, -1, 0, 1); // transverse
    case 8: return make(0, 1, 0, -1, 0, 1); // rotate 90° counter-clockwise
    default: return IDENTITY;
  }
}

/** A clockwise rotation by a multiple of 90 degrees (any integer, normalised). */
export function rotation(degreesClockwise) {
  const quarterTurns = Math.floor(floorMod(degreesClockwise, 360) / 90);
  let t = IDENTITY;
  for (let i = 0; i < quarterTurns; i++) t = then(t, ROTATE_90_CW);
  return t;
}

/** EXIF orientation first, then the user's clockwise rotation. */
export function transformOf(exifOrientation, userRotationDegrees) {
  return then(fromExif(exifOrientation), rotation(userRotationDegrees));
}

/** Kotlin's Math.floorMod: the remainder with the divisor's sign. */
export function floorMod(x, m) {
  return ((x % m) + m) % m;
}
