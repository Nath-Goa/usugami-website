// Tables on PowerPoint slides, styled as in PowerPoint (the presentation's table styles, or
// PowerPoint's default look), with cells merged across and down and right-to-left tables: a port of
// PptxConverter.kt's drawTable and defaultTableStyle, drawn with tables.js.
import { TableColumns, SlideTableStyles } from './office-formats.js';
import { OfficeColors } from './colors.js';
import { Fill, Outline } from './drawingml.js';
import { StackBlock } from './blocks.js';
import { Border, CellBox, RowBlock, TableBlock } from './tables.js';
import { levelLook, runLook, hasText, MAX_COLUMNS } from './pptx-model.js';
import { layoutText, tenths } from './pptx-text.js';

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

/** PowerPoint's default table look (Medium Style 2, Accent 1), for styles the file doesn't include. */
export function defaultTableStyle(ctx) {
  const accent = ctx.scheme('accent1') ?? 0xff4472c4;
  const light = ctx.scheme('lt1') ?? WHITE;
  const dark = ctx.scheme('dk1') ?? BLACK;
  const white = new Outline(light, 1, false);
  const grid = new Map(['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].map((side) => [side, white]));
  return {
    parts: new Map([
      ['wholeTbl', { fill: Fill.solid(OfficeColors.modify(accent, [['tint', 20000]])), borders: grid, bold: null, color: dark }],
      ['band1H', { fill: Fill.solid(OfficeColors.modify(accent, [['tint', 40000]])), borders: new Map(), bold: null, color: null }],
      ['firstRow', { fill: Fill.solid(accent), borders: new Map(), bold: true, color: light }],
      ['lastRow', { fill: Fill.solid(accent), borders: new Map(), bold: true, color: light }],
    ]),
  };
}

const lastOf = (list, pick) => {
  for (let i = list.length - 1; i >= 0; i--) {
    const v = pick(list[i]);
    if (v != null) return v;
  }
  return null;
};

/**
 * Draws `table` (pptx-model's readTable) with its top-left corner at `rect`'s. `style` is its
 * table style ({ parts }) or null; `chain` the list styles its text inherits; `slide` the slide's
 * number. `conv` gives slideWidth, themeFont and breathe (see pptx-text's layoutText).
 */
export async function drawTable(conv, canvas, table, rect, style, chain, slide) {
  // A column covered by a merged cell (hMerge) is counted once, with the cell spanning it.
  if (!table.rows.length) return;
  let spans = 0;
  for (const [, cells] of table.rows) {
    let s = 0;
    for (const c of cells) if (!c.hMerge) s += c.span;
    spans = Math.max(spans, s);
  }
  const columns = Math.min(Math.max(spans, table.grid.length), MAX_COLUMNS);
  // Without usable widths in its grid, the columns share the table's frame.
  const widths = TableColumns.widths(table.grid, columns, conv.slideWidth * 4, rect.width);
  const starts = [0];
  for (const w of widths) starts.push(starts[starts.length - 1] + w);
  const lastRow = table.rows.length - 1;
  // Cells merged down over the rows below (rowSpan): their text goes across those rows, once
  // their heights are known, and the rows they cover take their fill, with no line between.
  const tall = [];
  const coveredBy = new Map();
  const rows = [];
  for (let r = 0; r < table.rows.length; r++) {
    await conv.breathe();
    const [height, cells] = table.rows[r];
    let col = 0;
    const boxes = [];
    for (const cell of cells) {
      // Covered by the cell before it, which spans this column too.
      if (cell.hMerge) continue;
      const start = Math.min(col, columns - 1);
      const end = Math.min(col + cell.span, columns);
      col += cell.span;
      const partStyles = SlideTableStyles.parts(table.flags, r, table.rows.length, start, end, columns)
        .map((name) => [name, style?.parts?.get(name)])
        .filter(([, part]) => part != null);
      const fill = cell.fill ?? lastOf(partStyles, ([, part]) => part.fill);
      const bold = lastOf(partStyles, ([, part]) => part.bold);
      const color = lastOf(partStyles, ([, part]) => part.color);
      // The strongest part with a border for the edge draws it, or leaves it out.
      const border = (i, side, outer) => {
        let outline = cell.borders[i];
        if (outline == null) {
          for (let k = partStyles.length - 1; k >= 0 && outline == null; k--) {
            const [name, part] = partStyles[k];
            outline = part.borders.get(SlideTableStyles.border(name, side, outer)) ?? null;
          }
        }
        return outline?.color != null ? new Border(outline.width, outline.color) : null;
      };
      const margins = [7.2, 3.6, 7.2, 3.6].map((d, i) => tenths(cell.margins[i] ?? d));
      const width = starts[end] - starts[start];
      let content = null;
      const main = Fill.mainColor(fill);
      if (cell.body && !cell.vMerge && hasText(cell.body)) {
        const override = levelLook({ run: runLook({ bold, color }) });
        const all = new Map();
        for (let i = 0; i <= 8; i++) all.set(i, override);
        const levels = [cell.body.levels, all, ...chain];
        const dark = main != null && OfficeColors.isDark(main);
        content = new StackBlock(await layoutText(conv, cell.body, levels, Math.max(0.1, tenths(width - margins[0] - margins[2])), 1, 0, slide, null, dark));
      }
      const coverer = cell.vMerge ? coveredBy.get(start) : null;
      const over = coverer && r <= coverer.lastRow ? coverer : null;
      const spansDown = !cell.vMerge && cell.rowSpan > 1 && r < lastRow;
      // A right-to-left table's columns go from the right, each cell's left side (its start) on its right.
      const startSide = border(0, 'left', start === 0);
      const endSide = border(2, 'right', end >= columns);
      const box = new CellBox({
        x: table.rtl ? starts[columns] - starts[end] : starts[start],
        width,
        content,
        fill: over ? over.box.fill : main,
        top: cell.vMerge ? Border.NONE : border(1, 'top', r === 0),
        left: table.rtl ? endSide : startSide,
        bottom: spansDown || (over && r < over.lastRow) ? Border.NONE : border(3, 'bottom', r === lastRow),
        right: table.rtl ? startSide : endSide,
        verticalAlign: cell.anchor ?? 0,
        padLeft: margins[0], padTop: margins[1], padRight: margins[2], padBottom: margins[3],
      });
      if (spansDown) {
        const t = { row: r, lastRow: Math.min(lastRow, r + cell.rowSpan - 1), box };
        tall.push(t);
        coveredBy.set(start, t);
        boxes.push(box.copy({ content: null }));
      } else {
        boxes.push(box);
      }
    }
    rows.push([tenths(height), boxes]);
  }
  const blocks = rows.map(([height, boxes]) => new RowBlock(boxes, height, false));
  // A merged cell whose text needs more room than its rows have makes the last of them taller.
  for (const t of tall) {
    const need = (t.box.content?.height ?? 0) + t.box.padTop + t.box.padBottom;
    let have = 0;
    for (let i = t.row; i <= t.lastRow; i++) have += blocks[i].height;
    if (need > have) blocks[t.lastRow] = new RowBlock(rows[t.lastRow][1], blocks[t.lastRow].height + need - have, false);
  }
  const x = rect.x;
  const y = rect.y;
  new TableBlock(blocks, 0, 0).draw(canvas, x, y);
  const tops = [0];
  for (const b of blocks) tops.push(tops[tops.length - 1] + b.height);
  for (const t of tall) {
    const content = t.box.content;
    if (!content) continue;
    const free = tops[t.lastRow + 1] - tops[t.row] - t.box.padTop - t.box.padBottom - content.height;
    content.draw(canvas, x + t.box.x + t.box.padLeft, y + tops[t.row] + t.box.padTop + (free > 0 ? (free * t.box.verticalAlign) / 2 : 0));
  }
}
