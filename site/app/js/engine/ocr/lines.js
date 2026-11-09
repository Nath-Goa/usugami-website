// From what Tesseract read (its blocks of paragraphs, lines, words and symbols) to the lines and
// words of a Recognition: text with corners and a baseline in the pixels of the picture given to
// the recognizer, as the app's OcrLine has them (top-left, top-right, bottom-right, bottom-left as
// the text reads, which also give its angle).

/**
 * Lines read with less confidence than this (0 to 100) are left out: what is read with less is
 * mostly not text, as PaddleOCR's MIN_CONFIDENCE (0.5) has it in the app.
 */
export const MIN_LINE_CONFIDENCE = 50;

/**
 * In a line that is kept, a word without a letter or digit read with less confidence than this is
 * left out: a speck, or a table's rule read as a mark. Words with letters stay, as Tesseract may be
 * unsure of a word it read right (one at the end of a tilted line, say).
 */
export const MIN_MARK_CONFIDENCE = 40;

const LETTER = /[\p{L}\p{N}]/u;

/** How well a reading went: the letters read with some confidence, weighted by it (for choosing a turn). */
export function readingScore(blocks) {
  let score = 0;
  for (const line of tesseractLines(blocks)) {
    for (const word of line.words ?? []) {
      const text = (word.text ?? '').trim();
      if (text && word.confidence >= 50) score += word.confidence * [...text].length;
    }
  }
  return score;
}

/** Every line Tesseract found, in reading order. */
export function tesseractLines(blocks) {
  const lines = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) if (line) lines.push(line);
    }
  }
  return lines;
}

/**
 * The lines of a Recognition from Tesseract's `blocks`, read on a picture `width` x `height`
 * pixels that was the original turned `quarterTurns` times clockwise and scaled by `scale`. Each
 * point goes back through the turn and the scale, so it lands on the original picture.
 * @returns {Array<{ text: string, confidence: number, corners: Point[], baseline: Point[],
 *   words: Array<{ text: string, confidence: number, corners: Point[], baseline: Point[] }> }>}
 */
export function linesFromBlocks(blocks, { width, height, quarterTurns = 0, scale = 1 } = {}) {
  const back = unturn(width, height, quarterTurns, scale);
  const result = [];
  for (const line of tesseractLines(blocks)) {
    const read = lineGeometry(line);
    if (!read) continue;
    const words = read.words.map((w) => ({
      text: w.text,
      confidence: w.confidence,
      corners: w.corners.map(back),
      baseline: w.baseline.map(back),
    }));
    result.push({
      text: words.map((w) => w.text).join(' '),
      confidence: Math.round(Number(line.confidence) || 0),
      corners: read.corners.map(back),
      baseline: read.baseline.map(back),
      words,
    });
  }
  return result;
}

/**
 * The geometry of one line in the pixels it was read in: its height across the text from
 * Tesseract's row attributes, its baseline fitted through the bottoms of its letters (Tesseract's
 * own baseline assumes every line of a block is parallel, which a photo taken at an angle breaks),
 * and each word's stretch of that baseline. Null when the line is left out or no word is kept.
 */
export function lineGeometry(line) {
  const all = (line.words ?? [])
    .map((w) => ({ ...w, text: (w.text ?? '').trim(), confidence: Number(w.confidence) || 0 }))
    .filter((w) => w.text && validBox(w.bbox));
  if (!all.length) return null;
  const confidence = Number.isFinite(Number(line.confidence))
    ? Number(line.confidence)
    : all.reduce((sum, w) => sum + w.confidence, 0) / all.length;
  if (confidence < MIN_LINE_CONFIDENCE) return null;
  const words = all.filter((w) => LETTER.test(w.text) || w.confidence >= MIN_MARK_CONFIDENCE);
  if (!words.length) return null;
  const box = validBox(line.bbox) ? line.bbox : unionBox(words.map((w) => w.bbox));
  const boxHeight = Math.max(1, box.y1 - box.y0);

  // Height across the text (ascenders to descenders) and how far the descenders reach below the
  // baseline. Tesseract measures them on the straightened line; a value far off the line's box
  // (a line of one dot, say) gives way to the box.
  const row = line.rowAttributes ?? {};
  let height = Number(row.rowHeight);
  if (!(height > boxHeight * 0.3 && height < boxHeight * 3)) height = boxHeight;
  let descent = Math.abs(Number(row.descenders));
  if (!(descent >= 0 && descent < height * 0.6)) descent = height * 0.2;

  const { slope, at } = fitBaseline(words, line.baseline, box, height, descent);
  const norm = Math.hypot(1, slope);
  const along = { x: 1 / norm, y: slope / norm };
  const up = { x: slope / norm, y: -1 / norm };
  const origin = { x: box.x0, y: at(box.x0) };
  const project = (x, y) => (x - origin.x) * along.x + (y - origin.y) * along.y;
  const onBaseline = (s) => ({ x: origin.x + s * along.x, y: origin.y + s * along.y });
  const rect = (s0, s1) => {
    const start = onBaseline(s0);
    const end = onBaseline(s1);
    const rise = height - descent;
    return {
      baseline: [round(start), round(end)],
      corners: [
        round(offset(start, up, rise)),
        round(offset(end, up, rise)),
        round(offset(end, up, -descent)),
        round(offset(start, up, -descent)),
      ],
    };
  };

  let first = Infinity;
  let last = -Infinity;
  const placed = words.map((w) => {
    // The middles of the word's left and right edges, along the baseline.
    const middle = (w.bbox.y0 + w.bbox.y1) / 2;
    const s0 = project(w.bbox.x0, middle);
    const s1 = Math.max(s0 + 1, project(w.bbox.x1, middle));
    first = Math.min(first, s0);
    last = Math.max(last, s1);
    return { text: w.text, confidence: Math.round(w.confidence), ...rect(s0, s1) };
  });
  return { words: placed, height, descent, slope, ...rect(first, last) };
}

/** At most this many letters of a line are paired for its slope (they are spread along it). */
const MAX_PAIRED = 80;

/**
 * The line's baseline as y = at(x): a straight line through the bottoms of most of its letters.
 * Those below it (descenders, a Q's tail, commas) or above it (quotes) are outvoted: the slope is
 * the median of the slopes between pairs of letters (Theil-Sen), then fitted closely through the
 * letters near that line. With too few letters for a slope, Tesseract's baseline, or the bottom
 * of the line's box above its descenders.
 */
function fitBaseline(words, tesseractBaseline, box, height, descent) {
  const points = [];
  for (const w of words) {
    for (const s of w.symbols ?? []) {
      if (validBox(s.bbox) && (s.text ?? '').trim()) points.push({ x: (s.bbox.x0 + s.bbox.x1) / 2, y: s.bbox.y1 });
    }
  }
  const tb = tesseractBaseline;
  const hasTesseract = tb && [tb.x0, tb.y0, tb.x1, tb.y1].every(Number.isFinite) && tb.x1 !== tb.x0;
  let slope = hasTesseract ? (tb.y1 - tb.y0) / (tb.x1 - tb.x0) : 0;
  let intercept = hasTesseract ? tb.y0 - slope * tb.x0 : box.y1 - descent;
  const spread = points.length ? Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)) : 0;
  if (points.length >= 3 && spread >= height) {
    const step = Math.max(1, points.length / MAX_PAIRED);
    const paired = [];
    for (let i = 0; i < points.length; i += step) paired.push(points[Math.floor(i)]);
    const slopes = [];
    for (let i = 0; i < paired.length; i++) {
      for (let j = i + 1; j < paired.length; j++) {
        const dx = paired[j].x - paired[i].x;
        // Letters too close together (or one above the other) say little about the slope.
        if (Math.abs(dx) >= height * 0.5) slopes.push((paired[j].y - paired[i].y) / dx);
      }
    }
    if (slopes.length) {
      slope = median(slopes);
      intercept = median(points.map((p) => p.y - slope * p.x));
      const tolerance = Math.max(1.5, height * 0.05);
      const near = points.filter((p) => Math.abs(p.y - (intercept + slope * p.x)) <= tolerance);
      const fit = near.length >= 3 ? leastSquares(near) : null;
      if (fit && Math.abs(fit[1] - slope) < 0.05) [intercept, slope] = fit;
    }
  } else if (points.length) {
    // Too short for a slope: the slope as Tesseract has it, through the bottoms most letters share.
    const bottoms = points.map((p) => p.y - slope * p.x).sort((a, b) => a - b);
    intercept = bottoms[Math.floor((bottoms.length - 1) / 2)];
  }
  // Lines are read roughly level (a page turned further is read turned): a wild slope is a bad fit.
  if (!(Math.abs(slope) <= 1)) {
    slope = 0;
    intercept = box.y1 - descent;
  }
  return { slope, at: (x) => intercept + slope * x };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** [intercept, slope] of the straight line closest to `points`, or null for a vertical spread. */
function leastSquares(points) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return [my - slope * mx, slope];
}

/**
 * A function taking a point read on the turned, scaled picture back to the original picture: a
 * picture `width` x `height` (as read) turned `quarterTurns` clockwise from the original.
 */
export function unturn(width, height, quarterTurns, scale = 1) {
  const k = ((quarterTurns % 4) + 4) % 4;
  return ({ x, y }) => {
    let p;
    if (k === 1) p = { x: y, y: width - x }; // read turned a quarter clockwise: the original was `width` high
    else if (k === 2) p = { x: width - x, y: height - y };
    else if (k === 3) p = { x: height - y, y: x };
    else p = { x, y };
    return round({ x: p.x / scale, y: p.y / scale });
  };
}

function validBox(b) {
  return b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) && b.x1 >= b.x0 && b.y1 >= b.y0;
}

function unionBox(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

function offset(p, dir, by) {
  return { x: p.x + dir.x * by, y: p.y + dir.y * by };
}

function round(p) {
  return { x: Math.round(p.x * 100) / 100 + 0, y: Math.round(p.y * 100) / 100 + 0 };
}
