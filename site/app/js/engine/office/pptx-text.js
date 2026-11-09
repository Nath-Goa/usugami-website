// Text on PowerPoint slides: paragraphs in the look their list styles give them, bullets and
// numbers, spacing, text boxes' insets, anchoring, vertical text, and text shrunk to fit its box as
// PowerPoint does (normAutofit). A port of PptxConverter.kt's drawText, layoutText and textStyle,
// laid out with the text engine (engine/text) in points.
import { layoutParagraph, measureText, lineScale, LineSpacing } from '../text/index.js';
import { ListNumbering, SymbolFonts } from './office-formats.js';
import { OfficeColors } from './colors.js';
import { Fill, rotateAbout } from './drawingml.js';
import { Spaced } from './blocks.js';
import { levelLook, levelOver, runLook, runOver, bodyOver, gapPoints, EAST_ASIAN, STACKED } from './pptx-model.js';

const f = Math.fround;

/** Android lays text out in whole tenths of a point: a length cut to them, as the app's `.toInt()` of units. */
export const tenths = (points) => Math.trunc(points * 10) / 10;

const BLACK = 0xff000000;
const WHITE = 0xffffffff;

/** Scripts PowerPoint keeps upright in East Asian vertical text. */
const UPRIGHT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/** Whether `body` has characters PowerPoint keeps upright in vertical text: Chinese, Japanese or Korean ones. */
export function hasUprightText(body) {
  return body.paragraphs.some((p) => p.pieces.some((piece) => piece.kind === 'text' && UPRIGHT.test(piece.text)));
}

/**
 * The text engine's style for a run's look: `scale` shrinks it (autofit), `styleFont` is the
 * shape's style font colour, `darkFill` makes text without a colour white. `themeFont(name)`
 * resolves "+mn-lt" and the like.
 */
export function textStyle(look, scale, styleFont, darkFill, themeFont) {
  return {
    font: themeFont(look.font),
    size: f((look.size ?? 18) * scale),
    bold: look.bold === true,
    italic: look.italic === true,
    underline: look.underline === true,
    strike: look.strike === true,
    color: look.color ?? styleFont ?? (darkFill ? WHITE : BLACK),
    background: look.highlight ?? null,
    baseline: look.baseline ?? 0,
    caps: look.caps === true,
    spacing: f((look.spacing ?? 0) * scale),
  };
}

/**
 * Lays out `body`'s paragraphs `width` points wide: Spaced blocks (ParagraphLayouts with the space
 * before and after them), each with `align` and `rtl` (how it was laid out). `chain` is the list
 * styles the paragraphs inherit, nearest first (Maps from level to look); `scale` and `reduction`
 * are autofit's font scale and line spacing reduction; `slide` the slide's number.
 * `conv` gives `themeFont(name)` and `breathe()` (lets the page respond during long work).
 */
export async function layoutText(conv, body, chain, width, scale, reduction, slide, styleFont, darkFill) {
  const counters = new Array(9).fill(0);
  const out = [];
  const themeFont = (name) => conv.themeFont(name);
  for (const p of body.paragraphs) {
    await conv.breathe();
    const level = p.level;
    let look = p.look ?? levelLook();
    for (const levels of chain) look = levelOver(look, levels.get(level) ?? null);
    const rtl = look.rtl === true;
    const baseRun = look.run ?? runLook();
    const runs = [];
    let firstStyle = null;
    for (const piece of p.pieces) {
      const run = runOver(piece.look ?? runLook(), baseRun);
      const style = textStyle(run, scale, styleFont, darkFill, themeFont);
      if (firstStyle == null) firstStyle = style;
      // Characters of Symbol and Wingdings, which devices don't have, as the ones they show.
      if (piece.kind === 'text') runs.push({ text: SymbolFonts.text(themeFont(run.font), piece.text, run.symbol), style });
      else if (piece.kind === 'break') runs.push({ text: '\n', style });
      else runs.push({ text: String(slide), style });
    }
    const mark = textStyle(runOver(p.end ?? runLook(), baseRun), scale, styleFont, darkFill, themeFont);
    const first = firstStyle ?? mark;
    const hasContent = runs.some((r) => r.text !== '' && /\S/u.test(r.text));
    // Numbering counts consecutive numbered paragraphs at a level; a higher level starts it over.
    for (let deeper = level + 1; deeper < 9; deeper++) counters[deeper] = 0;
    const bullet = hasContent ? look.bullet : null;
    let labelText = null;
    if (bullet?.type === 'char') {
      labelText = SymbolFonts.bullet(look.bulletFont, bullet.text);
    } else if (bullet?.type === 'number') {
      counters[level] = counters[level] === 0 ? bullet.start : counters[level] + 1;
      const [format, prefix, suffix] = ListNumbering.powerPointScheme(bullet.scheme);
      labelText = prefix + ListNumbering.format(counters[level], format) + suffix;
    } else if (hasContent || look.bullet?.type !== 'number') {
      // An empty paragraph in a numbered list shows no number, and the list goes on counting after it, as in PowerPoint.
      counters[level] = 0;
    }
    const marL = look.marL ?? 0;
    const firstStart = f(marL + (look.indent ?? 0));
    let textStart = firstStart;
    let label = null;
    if (labelText) {
      const style = {
        ...first,
        size: f(first.size * (look.bulletSize ?? 1)),
        color: look.bulletColor ?? first.color,
        underline: false, strike: false, background: null,
        bold: first.bold && bullet.type === 'number',
      };
      const end = firstStart + (await measureText(labelText, style)).width;
      textStart = end <= marL ? marL : end + style.size * 0.3;
      label = { text: labelText, style, x: tenths(firstStart) };
    }
    const size = first.size;
    let line;
    if (look.line == null) line = LineSpacing.multiple(f(1 - reduction));
    else if (look.line.type === 'multiple') line = LineSpacing.multiple(Math.max(0.5, f(look.line.value - reduction)));
    else line = look.line;
    let align;
    // DrawingML's l and r are the left and right sides, whichever way the paragraph reads.
    switch (look.align) {
      case null: case undefined: align = 'start'; break;
      case 'start': align = rtl ? 'end' : 'start'; break;
      case 'end': align = rtl ? 'start' : 'end'; break;
      default: align = look.align;
    }
    const block = await layoutParagraph({
      text: runs.filter((r) => r.text !== ''),
      base: mark,
      width,
      align,
      firstIndent: tenths(textStart),
      indent: tenths(marL),
      spacing: line,
      // PowerPoint's single spacing is 1.2 times the font size, whatever the font.
      lineScale: lineScale(first, 1.2),
      label,
      // A paragraph reads the way it says, not the way its first letter does; a right-to-left one
      // has its indents and bullet on the right.
      rtl,
      mirrored: rtl,
      directionFromText: false,
      avoidSingleLines: false,
    });
    const item = new Spaced(block, look.before ? tenths(gapPoints(look.before, size)) : 0, look.after ? tenths(gapPoints(look.after, size)) : 0);
    item.align = align;
    item.rtl = rtl;
    out.push(item);
  }
  return out;
}

/**
 * Draws `body` in `box` ({ left, top, right, bottom }, points) on `canvas`: insets, vertical text,
 * wrapping, autofit and anchoring as PptxConverter.drawText. `inheritedLooks` are the body looks of
 * the placeholders it takes after, nearest first; `fill` the shape's fill (white text on dark).
 */
export async function drawText(conv, canvas, body, box, chain, inheritedLooks, styleFont, slide, fill) {
  let look = body.look;
  for (const l of inheritedLooks) look = bodyOver(look, l);
  const insets = [7.2, 3.6, 7.2, 3.6].map((d, i) => look.insets[i] ?? d);
  canvas.save();
  try {
    let area = { left: box.left + insets[0], top: box.top + insets[1], right: box.right - insets[2], bottom: box.bottom - insets[3] };
    // PowerPoint keeps stacked letters, and Chinese, Japanese and Korean characters, upright in
    // vertical text: they come closest across the box, wrapped to its width so they stand one
    // under the other in a narrow box.
    const upright = look.vertical === STACKED || (look.vertical === EAST_ASIAN && hasUprightText(body));
    let turn = 0;
    if (look.vertical === 1 || (look.vertical === EAST_ASIAN && !upright)) turn = 1;
    else if (look.vertical === -1) turn = -1;
    if (turn !== 0) {
      // Vertical text: drawn turned a quarter, in a box as tall as the shape is wide.
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const bw = box.right - box.left;
      const bh = box.bottom - box.top;
      rotateAbout(canvas, turn === 1 ? 90 : -90, cx, cy);
      area = { left: cx - bh / 2 + insets[0], top: cy - bw / 2 + insets[1], right: cx + bh / 2 - insets[2], bottom: cy + bw / 2 - insets[3] };
    }
    const areaWidth = area.right - area.left;
    const areaHeight = area.bottom - area.top;
    // In vertical text, wrap="none" keeps columns from breaking at the box's foot, not lines at its side.
    const wrap = upright || look.wrap !== false;
    const width = wrap ? Math.max(0.1, tenths(areaWidth)) : tenths(conv.slideWidth * 4);
    const main = Fill.mainColor(fill);
    const darkFill = main != null && OfficeColors.isDark(main);
    let scale = look.fontScale ?? 1;
    const reduction = look.lineReduction ?? 0;
    // Unless the text body asks for them, PowerPoint leaves out the first paragraph's space
    // before and the last one's space after.
    const edges = look.firstLastSpacing === true;
    const height = (blocks) => {
      let all = 0;
      for (const b of blocks) all += b.before + b.block.height + b.after;
      if (edges || !blocks.length) return all;
      return all - blocks[0].before - blocks[blocks.length - 1].after;
    };
    let blocks = await layoutText(conv, body, chain, width, scale, reduction, slide, styleFont, darkFill);
    // Text that overflows a box PowerPoint shrinks text in is shrunk until it fits.
    if (look.autofit === 1) {
      while (height(blocks) > areaHeight && scale > 0.3) {
        scale = f(scale * f(0.9));
        blocks = await layoutText(conv, body, chain, width, scale, Math.min(0.2, f(reduction + f(0.05))), slide, styleFont, darkFill);
      }
    }
    const anchor = look.anchor ?? 0;
    let y = area.top + ((areaHeight - height(blocks)) * anchor) / 2;
    blocks.forEach((item, i) => {
      if (i > 0 || edges) y += item.before;
      // Text that isn't wrapped is laid out wider than the box, and placed by its side.
      let x;
      if (wrap) x = area.left;
      else if (item.align === 'center') x = (area.left + area.right) / 2 - width / 2;
      else if ((item.align === 'end') !== item.rtl) x = area.right - width;
      else x = area.left;
      item.block.draw(canvas, x, y);
      y += item.block.height + item.after;
    });
    return scale;
  } finally {
    canvas.restore();
  }
}
