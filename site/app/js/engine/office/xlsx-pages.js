// A sheet's printed areas laid out on pages, and the pages drawn: a port of the app's XlsxPages.kt.
// Lengths are points, the origin is a page's top-left corner. A range of rows or columns is
// [first, last] (Kotlin's IntRange); a page is [row band, column band].
import { SheetPages, SheetRefs, SheetRange, SheetHeaders } from './xlsx-model.js';
import { paperSize } from './office-formats.js';
import { OfficeTooLarge } from './problems.js';
import { SheetMargins, binarySearch, pictureCells } from './xlsx-sheet.js';
import { SheetAlign, CellKind, BLACK } from './xlsx-styles.js';
import { PAD, intersect, rect } from './xlsx-text.js';
import { RichText, layoutParagraphSync, ensureFonts, lineScale } from '../text/index.js';

const f = Math.fround;

/** Excel's paper when a file doesn't say: US Letter. */
const LETTER = [612, 792];

/** The smallest Fit columns to page width shrinks a sheet to, in percent: half size. */
export const MIN_FIT_WIDTH = 50;

/** Gridlines are hairlines, a quarter of a point on paper at any scale, light grey. */
const GRID = 0xffc0c0c0;
const GRID_WIDTH = 0.25;
const MIN_LINE = 0.25;
const SEAM = 0.05;
const OPAQUE = 0xff000000;

/** `margins`, shrunk together if they leave less than a tenth of the paper (Kotlin's Float arithmetic). */
function shrinkMargins(m, width, height) {
  const across = Math.min(1, f(f(width * f(0.9)) / Math.max(f(0.01), f(m.left + m.right))));
  const down = Math.min(1, f(f(height * f(0.9)) / Math.max(f(0.01), f(m.top + m.bottom))));
  return new SheetMargins(
    f(m.left * across), f(m.right * across), f(m.top * down), f(m.bottom * down),
    Math.min(m.header, f(m.top * down)), Math.min(m.footer, f(m.bottom * down)),
  );
}

/** The band of `starts` (each band's first row or column) that `index` is in. */
function bandOf(starts, index) {
  const i = binarySearch(starts, index);
  return Math.max(0, i >= 0 ? i : -i - 2);
}

const sumRange = (range, size) => {
  let total = 0;
  for (let i = range[0]; i <= range[1]; i++) total += size(i);
  return total;
};

/**
 * One printed area of a sheet (its print area, or everything on it), laid out on pages: the
 * paper, the scale, and where the rows and columns break between pages. `pages` are the pages in
 * the order they print, as [row band, column band], those with nothing on them left out, as Excel
 * leaves them out.
 */
export class AreaLayout {
  constructor(plan, area, pageWidth, pageHeight, scale, rowStarts, columnStarts, titleRows, titleColumns, pages) {
    this.plan = plan;
    this.area = area;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    /** The share sizes on the sheet are printed at. */
    this.scale = scale;
    /** The first row (column) of each band of rows (columns), on the sheet. */
    this.rowStarts = rowStarts;
    this.columnStarts = columnStarts;
    this.titleRows = titleRows;
    this.titleColumns = titleColumns;
    this.pages = pages;
    /** The paper's margins, as laid out. */
    this.margins = shrinkMargins(plan.setup.margins, pageWidth, pageHeight);
  }

  rowEnd(band) {
    return band + 1 < this.rowStarts.length ? this.rowStarts[band + 1] - 1 : this.area.lastRow;
  }

  columnEnd(band) {
    return band + 1 < this.columnStarts.length ? this.columnStarts[band + 1] - 1 : this.area.lastColumn;
  }

  /** Whether page band `rowBand` repeats the title rows above its own, which it does once past them. */
  repeatsRows(rowBand) {
    return this.titleRows != null && this.rowStarts[rowBand] > this.titleRows[1];
  }

  repeatsColumns(columnBand) {
    return this.titleColumns != null && this.columnStarts[columnBand] > this.titleColumns[1];
  }

  /**
   * Lays out `area` (a SheetRange) of `plan` with `titles` ([rows, columns], each [first, last] or
   * null) as `options` (paper, landscape, fitWidth) and the sheet's page setup say. Fit columns to
   * page width shrinks the columns to the page's width unless the file sets how to fit the sheet
   * itself, but not below MIN_FIT_WIDTH percent; nothing is ever enlarged. Throws OfficeTooLarge
   * once the pages with anything on them number more than `limit`.
   */
  static async of(plan, area, titles, options, limit, pace) {
    const setup = plan.setup;
    const chosen = options.paper ? paperSize(options.paper) : null;
    const paper = (chosen ? [chosen.width, chosen.height] : null) ?? setup.paper ?? LETTER;
    const landscape = options.landscape ?? setup.landscape ?? false;
    const width = f(landscape ? paper[1] : paper[0]);
    const height = f(landscape ? paper[0] : paper[1]);
    const margins = shrinkMargins(setup.margins, width, height);
    const bodyWidth = f(f(width - margins.left) - margins.right);
    const bodyHeight = f(f(height - margins.top) - margins.bottom);

    const widths = new Float64Array(area.lastColumn - area.firstColumn + 1);
    for (let i = 0; i < widths.length; i++) widths[i] = plan.columns.width(area.firstColumn + i);
    const heights = new Float64Array(area.lastRow - area.firstRow + 1);
    for (let i = 0; i < heights.length; i++) {
      if ((i & 0xffff) === 0 && pace.check()) await pace.breathe();
      heights[i] = plan.rows.height(area.firstRow + i);
    }
    const rowHeight = (r) => plan.rows.height(r);
    const columnWidth = (c) => plan.columns.width(c);
    // Titles taller (or wider) than half a page would leave too little room for the rest: they don't repeat.
    const titleRows = titles[0] && sumRange(titles[0], rowHeight) <= bodyHeight / 2 ? titles[0] : null;
    const titleColumns = titles[1] && sumRange(titles[1], columnWidth) <= bodyWidth / 2 ? titles[1] : null;
    const rowTitle = [titleRows ? sumRange(titleRows, rowHeight) : 0, titleRows ? titleRows[1] - area.firstRow : -2147483648];
    const columnTitle = [titleColumns ? sumRange(titleColumns, columnWidth) : 0, titleColumns ? titleColumns[1] - area.firstColumn : -2147483648];
    const rowBreaks = new Set();
    for (const b of plan.rowBreaks) if (b - area.firstRow > 0) rowBreaks.add(b - area.firstRow);
    const columnBreaks = new Set();
    for (const b of plan.columnBreaks) if (b - area.firstColumn > 0) columnBreaks.add(b - area.firstColumn);
    const none = new Set();

    const shrunk = options.fitWidth && !setup.fitToPage
      ? SheetPages.fitScale(widths, heights, bodyWidth, bodyHeight, 1, 0, { columnBreaks: none, rowBreaks, columnTitle, rowTitle, most: setup.scale })
      : null;
    // Smaller is too small to read on paper: a sheet wider still goes on more pages across.
    const floor = Math.min(MIN_FIT_WIDTH, setup.scale);
    let percent;
    if (setup.fitToPage) percent = SheetPages.fitScale(widths, heights, bodyWidth, bodyHeight, setup.fitWidth, setup.fitHeight, { columnBreaks: none, rowBreaks: none, columnTitle, rowTitle });
    else if (shrunk != null) percent = Math.max(shrunk, floor);
    else percent = setup.scale;
    const scale = percent / 100;
    const breaksApply = !setup.fitToPage;
    // Fitted to one page across, the sheet's own breaks between columns don't apply, as in Excel's "Fit to".
    const onePageAcross = shrunk != null && shrunk >= floor;
    const rowStarts = Int32Array.from(
      SheetPages.bands(heights, bodyHeight, { scale, breaks: breaksApply ? rowBreaks : none, titleSize: rowTitle[0], titleEnd: rowTitle[1] }),
      (i) => i + area.firstRow,
    );
    const columnStarts = Int32Array.from(
      SheetPages.bands(widths, bodyWidth, { scale, breaks: breaksApply && !onePageAcross ? columnBreaks : none, titleSize: columnTitle[0], titleEnd: columnTitle[1] }),
      (i) => i + area.firstColumn,
    );
    const layout = new AreaLayout(plan, area, width, height, f(scale), rowStarts, columnStarts, titleRows, titleColumns, []);
    layout.pages = await layout.pagesWithContent(setup.downThenOver, limit, pace);
    return layout;
  }

  /**
   * The pages with anything on them, in the order they print: a cell with something in it, a
   * format that shows or text running on from a cell, part of a merged block with something in it,
   * or a picture. They are found from what the sheet holds rather than by looking at each page, as
   * a sheet reaching far down and across has millions.
   */
  async pagesWithContent(downThenOver, limit, pace) {
    const plan = this.plan;
    const area = this.area;
    const found = new Set();
    const mark = (cells) => {
      const shown = cells.intersect(area);
      if (!shown) return;
      const c0 = bandOf(this.columnStarts, shown.firstColumn);
      const c1 = bandOf(this.columnStarts, shown.lastColumn);
      const r1 = bandOf(this.rowStarts, shown.lastRow);
      for (let r = bandOf(this.rowStarts, shown.firstRow); r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = SheetRefs.pack(r, c);
          if (!found.has(key)) {
            found.add(key);
            if (found.size > limit) throw new OfficeTooLarge();
          }
        }
      }
    };
    // The rows with something in them, the columns of each band of rows joined where they meet.
    const content = plan.content;
    let rowBand = -1;
    let from = -1;
    let to = -1;
    for (let i = content.start(area.firstRow); i < content.rows.length && content.rows[i] <= area.lastRow; i++) {
      const row = content.rows[i];
      const first = content.first[i];
      const last = content.last[i];
      const band = bandOf(this.rowStarts, row);
      if (band !== rowBand || first > to + 1 || last < from - 1) {
        if (rowBand >= 0) mark(new SheetRange(this.rowStarts[rowBand], from, this.rowStarts[rowBand], to));
        if (pace.check()) await pace.breathe();
        rowBand = band;
        from = first;
        to = last;
      } else {
        from = Math.min(from, first);
        to = Math.max(to, last);
      }
    }
    if (rowBand >= 0) mark(new SheetRange(this.rowStarts[rowBand], from, this.rowStarts[rowBand], to));
    for (const merge of plan.merges) {
      if (pace.check()) await pace.breathe();
      if (merge.intersect(area) != null && content.any(merge.firstRow, merge.lastRow, merge.firstColumn, merge.lastColumn)) mark(merge);
    }
    for (const picture of plan.pictures) mark(pictureCells(picture, plan.rows, plan.columns));
    return SheetPages.order([...found].map((k) => [SheetRefs.rowOf(k), SheetRefs.columnOf(k)]), downThenOver);
  }
}

/**
 * The cells of a page as read in the second pass: its rows (a Map of index to SheetRow), and every
 * merged block's first cell read so far (a block can start on an earlier page), by packed reference.
 */
export class PageCells {
  constructor(rows, anchors) {
    this.rows = rows;
    this.anchors = anchors;
  }

  cell(row, column) {
    const r = this.rows.get(row);
    if (r) {
      const cells = r.cells;
      let low = 0;
      let high = cells.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        const c = cells[mid].column;
        if (c < column) low = mid + 1;
        else if (c > column) high = mid - 1;
        else return cells[mid];
      }
    }
    return this.anchors.get(SheetRefs.pack(row, column)) ?? null;
  }
}

/** Where a cell's text goes: across the cells from `first` to `last` of its row. */
class Placed {
  constructor(cell, format, first, last) {
    this.cell = cell;
    this.format = format;
    this.first = first;
    this.last = last;
  }
}

/**
 * Draws the pages of a laid-out sheet area: fills, gridlines, borders, text and pictures, in that
 * order, as Excel prints them, and the sheet's header and footer. Text that doesn't wrap runs on
 * into empty cells beside it; numbers too wide for their cell show as ####. Sizes on the sheet are
 * points, drawn at the area's scale. Light gridlines show on the sheets set to print them, as in
 * Excel, and with `gridlines` also on those that show them on screen.
 */
export class SheetPainter {
  constructor(styles, texts, images, gridlines) {
    this.styles = styles;
    this.texts = texts;
    this.images = images;
    this.gridlines = gridlines;
  }

  /** The rows and columns page ([rowBand], [columnBand]) shows: the title ones first when it repeats them, then its own. */
  parts(layout, rowBand, columnBand) {
    const rowParts = [];
    if (layout.titleRows && layout.repeatsRows(rowBand)) rowParts.push(layout.titleRows);
    rowParts.push([layout.rowStarts[rowBand], layout.rowEnd(rowBand)]);
    const columnParts = [];
    if (layout.titleColumns && layout.repeatsColumns(columnBand)) columnParts.push(layout.titleColumns);
    columnParts.push([layout.columnStarts[columnBand], layout.columnEnd(columnBand)]);
    return [rowParts, columnParts];
  }

  /** The merged blocks of more than one cell over the page's rows. */
  pageMerges(plan, rowParts) {
    return plan.merges.filter((m) => (m.firstRow !== m.lastRow || m.firstColumn !== m.lastColumn) && rowParts.some((p) => m.firstRow <= p[1] && m.lastRow >= p[0]));
  }

  /**
   * Gets page ([rowBand], [columnBand]) ready to draw: the fonts its cells' text needs loaded, and
   * its pictures decoded (drawing itself can't wait).
   */
  async prepare(layout, rowBand, columnBand, cells) {
    const plan = layout.plan;
    const area = layout.area;
    const [rowParts, columnParts] = this.parts(layout, rowBand, columnBand);
    const showns = [];
    for (const [r0, r1] of rowParts) {
      for (let r = r0; r <= r1; r++) {
        const row = cells.rows.get(r);
        if (!row || plan.rows.height(r) <= 0) continue;
        for (const cell of row.cells) {
          if (cell.kind == null || cell.column < area.firstColumn || cell.column > area.lastColumn) continue;
          const width = plan.columns.width(cell.column);
          if (width <= 0) continue;
          showns.push(this.texts.shown(cell, this.styles.format(cell.format), width));
        }
      }
    }
    for (const merge of this.pageMerges(plan, rowParts)) {
      const anchor = cells.cell(merge.firstRow, merge.firstColumn);
      if (!anchor || anchor.kind == null) continue;
      const width = plan.columns.offset(merge.lastColumn + 1) - plan.columns.offset(merge.firstColumn);
      showns.push(this.texts.shown(anchor, this.styles.format(anchor.format), width));
    }
    await this.texts.ensure(showns);
    // Pictures over the page, decoded at the size they print.
    if (!plan.pictures.length) return;
    const loaded = layout.loadedPictures ?? (layout.loadedPictures = new Map());
    const rows = plan.rows;
    const columns = plan.columns;
    for (const [r0, r1] of rowParts) {
      const top = rows.offset(r0);
      const bottom = rows.offset(r1 + 1);
      for (const [c0, c1] of columnParts) {
        const left = columns.offset(c0);
        const right = columns.offset(c1 + 1);
        for (const [i, picture] of plan.pictures.entries()) {
          const p = picture.rect;
          if (loaded.has(i) || p.right <= left || p.left >= right || p.bottom <= top || p.top >= bottom) continue;
          loaded.set(i, await this.images.picture(picture.path, (p.right - p.left) * layout.scale, (p.bottom - p.top) * layout.scale, picture.crop));
        }
      }
    }
  }

  /**
   * Draws page ([rowBand], [columnBand]) of `layout` on `canvas` (a PdfCanvas), its cells from
   * `cells` (PageCells): the title rows and columns first when it repeats them, then its own.
   * prepare() it first.
   */
  draw(canvas, layout, rowBand, columnBand, cells) {
    const plan = layout.plan;
    const [rowParts, columnParts] = this.parts(layout, rowBand, columnBand);
    const height = (rows) => f(plan.rows.offset(rows[1] + 1) - plan.rows.offset(rows[0]));
    const width = (columns) => f(plan.columns.offset(columns[1] + 1) - plan.columns.offset(columns[0]));
    const regions = [];
    let y = 0;
    for (const rows of rowParts) {
      let x = 0;
      for (const columns of columnParts) {
        regions.push({ rows, columns, x, y, width: width(columns), height: height(rows) });
        x = f(x + width(columns));
      }
      y = f(y + height(rows));
    }
    let across = 0;
    for (const c of columnParts) across += width(c);
    let down = 0;
    for (const r of rowParts) down += height(r);
    const contentWidth = f(f(across) * layout.scale);
    const contentHeight = f(f(down) * layout.scale);
    const margins = layout.margins;
    const bodyWidth = layout.pageWidth - margins.left - margins.right;
    const bodyHeight = layout.pageHeight - margins.top - margins.bottom;
    const left = margins.left + (plan.setup.centerHorizontally ? Math.max(0, (bodyWidth - contentWidth) / 2) : 0);
    const top = margins.top + (plan.setup.centerVertically ? Math.max(0, (bodyHeight - contentHeight) / 2) : 0);
    const placed = new Map();
    const grid = plan.gridlinesPrinted || (this.gridlines && plan.gridlinesShown);
    const merges = this.pageMerges(plan, rowParts);
    canvas.save();
    canvas.translate(left, top);
    canvas.scale(layout.scale, layout.scale);
    for (const region of regions) this.drawRegion(canvas, layout, region, cells, merges, placed, grid);
    canvas.restore();
  }

  drawRegion(canvas, layout, region, cells, pageMerges, placed, grid) {
    const plan = layout.plan;
    const styles = this.styles;
    const texts = this.texts;
    const columns = plan.columns;
    const rows = plan.rows;
    const [r0, r1] = region.rows;
    const [c0, c1] = region.columns;
    const firstX = columns.offset(c0);
    const firstY = rows.offset(r0);
    const x = (column) => f(region.x + columns.offset(column) - firstX);
    const y = (row) => f(region.y + rows.offset(row) - firstY);
    const clip = rect(region.x, region.y, f(region.x + region.width), f(region.y + region.height));
    const visibleRows = [];
    for (let r = r0; r <= r1; r++) if (rows.height(r) > 0) visibleRows.push(r);
    const n = c1 - c0 + 1;
    if (!visibleRows.length || n <= 0) return;
    const bounds = new SheetRange(r0, c0, r1, c1);
    const merges = pageMerges.filter((m) => m.intersect(bounds) != null);
    // Which merged block each cell of the region is in, or -1.
    const mergeOf = new Int32Array(visibleRows.length * n).fill(-1);
    const rowSlot = new Map();
    visibleRows.forEach((r, i) => rowSlot.set(r, i));
    merges.forEach((merge, m) => {
      for (let r = Math.max(merge.firstRow, r0); r <= Math.min(merge.lastRow, r1); r++) {
        const i = rowSlot.get(r);
        if (i === undefined) continue;
        for (let c = Math.max(merge.firstColumn, c0); c <= Math.min(merge.lastColumn, c1); c++) mergeOf[i * n + c - c0] = m;
      }
    });
    // Every cell's format: its own, else its row's, else its column's.
    const formats = new Int32Array(visibleRows.length * n);
    for (let i = 0; i < visibleRows.length; i++) {
      const row = cells.rows.get(visibleRows[i]);
      for (let j = 0; j < n; j++) {
        const cf = columns.format(c0 + j);
        formats[i * n + j] = row && row.format >= 0 ? row.format : cf >= 0 ? cf : 0;
      }
      if (row) for (const cell of row.cells) if (cell.column >= c0 && cell.column <= c1) formats[i * n + cell.column - c0] = cell.format;
    }
    const mergeRect = (merge) => rect(x(merge.firstColumn), y(merge.firstRow), x(merge.lastColumn + 1), y(merge.lastRow + 1));
    const rowPlaced = new Map();
    for (const r of visibleRows) {
      let p = placed.get(r);
      if (!p) {
        p = this.place(plan, cells.rows.get(r) ?? null, layout.area, pageMerges);
        placed.set(r, p);
      }
      rowPlaced.set(r, p);
    }

    canvas.save();
    clipTo(canvas, clip);
    // Fills, in runs of one colour along each row, so no seams show between cells.
    for (let i = 0; i < visibleRows.length; i++) {
      const r = visibleRows[i];
      let runStart = -1;
      let runColor = 0;
      const flush = (end) => {
        if (runStart >= 0) fillRect(canvas, x(c0 + runStart), y(r), x(c0 + end - 1 + 1), f(y(r) + rows.height(r)), runColor);
        runStart = -1;
      };
      for (let j = 0; j < n; j++) {
        const color = mergeOf[i * n + j] >= 0 ? null : styles.format(formats[i * n + j]).fill;
        if (color !== runColor || color == null) flush(j);
        if (color != null && runStart < 0) {
          runStart = j;
          runColor = color;
        }
      }
      flush(n);
    }
    for (const merge of merges) {
      const anchor = cells.cell(merge.firstRow, merge.firstColumn);
      const format = styles.format(anchor?.format ?? formatOfPage(plan, cells, merge.firstRow, merge.firstColumn));
      if (format.fill != null) {
        const m = mergeRect(merge);
        fillRect(canvas, m.left, m.top, m.right, m.bottom, format.fill);
      }
    }

    if (grid) this.drawGrid(canvas, layout, visibleRows, c0, n, mergeOf, rowPlaced, x, y);

    // Borders: each cell's own sides, but those inside a merged block.
    for (let i = 0; i < visibleRows.length; i++) {
      const r = visibleRows[i];
      for (let j = 0; j < n; j++) {
        const borders = styles.format(formats[i * n + j]).borders;
        if (!borders) continue;
        const c = c0 + j;
        const mi = mergeOf[i * n + j];
        const merge = mi >= 0 ? merges[mi] : null;
        const x0 = x(c);
        const x1 = x(c + 1);
        const y0 = y(r);
        const y1 = y(r + 1);
        const s = layout.scale;
        if ((!merge || r === merge.firstRow) && borders.top) line(canvas, borders.top, x0, y0, x1, y0, s);
        if ((!merge || r === merge.lastRow) && borders.bottom) line(canvas, borders.bottom, x0, y1, x1, y1, s);
        if ((!merge || c === merge.firstColumn) && borders.left) line(canvas, borders.left, x0, y0, x0, y1, s);
        if ((!merge || c === merge.lastColumn) && borders.right) line(canvas, borders.right, x1, y0, x1, y1, s);
        if (!merge) {
          if (borders.diagonalUp) line(canvas, borders.diagonalUp, x0, y1, x1, y0, s);
          if (borders.diagonalDown) line(canvas, borders.diagonalDown, x0, y0, x1, y1, s);
        }
      }
    }
    canvas.restore();

    // Text, each in the cells it takes, cut off at the region's edge.
    const hidden = plan.valuesHidden.filter((h) => h.firstRow <= r1 && h.lastRow >= r0);
    for (const r of visibleRows) {
      for (const p of rowPlaced.get(r)) {
        if (p.last < c0 || p.first > c1) continue;
        if (hidden.some((h) => h.contains(r, p.cell.column))) continue;
        const box = rect(x(p.first), y(r), x(p.last + 1), y(r + 1));
        const shown = texts.shown(p.cell, p.format, columns.width(p.cell.column));
        if (!shown) continue;
        if (shown.align === SheetAlign.CENTER && p.first !== p.last) {
          // Centred text running on stays centred on its own cell, cut off where the cells it runs into end.
          const centre = (x(p.cell.column) + x(p.cell.column + 1)) / 2;
          const half = Math.max(centre - box.left, box.right - centre);
          const cut = intersect(box, clip);
          if (cut) texts.draw(canvas, shown, p.format, rect(centre - half, box.top, centre + half, box.bottom), cut);
        } else {
          texts.draw(canvas, shown, p.format, box, clip);
        }
      }
    }
    for (const merge of merges) {
      if (hidden.some((h) => h.contains(merge.firstRow, merge.firstColumn))) continue;
      const anchor = cells.cell(merge.firstRow, merge.firstColumn);
      if (!anchor || anchor.kind == null) continue;
      const format = styles.format(anchor.format);
      const box = mergeRect(merge);
      const shown = texts.shown(anchor, format, box.right - box.left);
      if (!shown) continue;
      texts.draw(canvas, shown, format, box, clip);
    }

    // Pictures, over the cells.
    if (!plan.pictures.length) return;
    const sheetLeft = f(columns.offset(c0));
    const sheetTop = f(rows.offset(r0));
    const sheetRight = sheetLeft + region.width;
    const sheetBottom = sheetTop + region.height;
    canvas.save();
    clipTo(canvas, clip);
    for (const [i, picture] of plan.pictures.entries()) {
      const p = picture.rect;
      if (p.right <= sheetLeft || p.left >= sheetRight || p.bottom <= sheetTop || p.top >= sheetBottom) continue;
      const loaded = layout.loadedPictures?.get(i);
      if (!loaded) continue;
      loaded.draw(canvas, rect(region.x + p.left - sheetLeft, region.y + p.top - sheetTop, region.x + p.right - sheetLeft, region.y + p.bottom - sheetTop));
    }
    canvas.restore();
  }

  /**
   * Where the text of each cell of `row` goes. Text that doesn't wrap and is wider than its cell
   * runs on into the empty cells beside it, the way it lines up: right of it, left of it, or both
   * ways when centred; Center Across Selection centres it over the empty cells after it that ask
   * for the same. Numbers never run on; nor does text in the merged blocks `merges` (those over the
   * page's rows), which drawRegion places in its block. A hidden column's text doesn't print.
   */
  place(plan, row, area, merges) {
    if (!row || !row.cells.length) return [];
    const styles = this.styles;
    const texts = this.texts;
    const filled = new Set();
    for (const c of row.cells) if (c.kind != null) filled.add(c.column);
    const merged = merges.filter((m) => row.index >= m.firstRow && row.index <= m.lastRow);
    const inMerge = (column) => merged.some((m) => column >= m.firstColumn && column <= m.lastColumn);
    const free = (column) => column >= area.firstColumn && column <= area.lastColumn && !filled.has(column) && !inMerge(column);
    const out = [];
    for (const cell of row.cells) {
      if (cell.kind == null || cell.column < area.firstColumn || cell.column > area.lastColumn || plan.columns.width(cell.column) <= 0 || inMerge(cell.column)) continue;
      const format = styles.format(cell.format);
      let first = cell.column;
      let last = cell.column;
      const runsOn = cell.kind === CellKind.TEXT || cell.kind === CellKind.FORMULA;
      if (format.horizontal === SheetAlign.CENTER_ACROSS) {
        while (free(last + 1) && styles.format(formatOfRow(plan, row, last + 1)).horizontal === SheetAlign.CENTER_ACROSS) last++;
      } else if (runsOn && !format.wraps && !format.shrink && format.rotation === 0 && format.horizontal !== SheetAlign.FILL) {
        const shown = texts.shown(cell, format, plan.columns.width(cell.column));
        const right = shown != null && shown.align !== SheetAlign.RIGHT && free(last + 1);
        const left = shown != null && (shown.align === SheetAlign.RIGHT || shown.align === SheetAlign.CENTER) && free(first - 1);
        // Measured only when it has somewhere to run on to: in a full table, most text has not.
        if (shown != null && (right || left)) {
          const need = texts.width(shown) + 2 * PAD + format.indent * texts.indentStep - plan.columns.width(cell.column);
          if (need > 0) {
            const side = shown.align === SheetAlign.CENTER ? need / 2 : need;
            if (right) {
              let gained = 0;
              while (gained < side && free(last + 1)) gained += plan.columns.width(++last);
            }
            if (left) {
              let gained = 0;
              while (gained < side && free(first - 1)) gained += plan.columns.width(--first);
            }
          }
        }
      }
      out.push(new Placed(cell, format, first, last));
    }
    return out;
  }

  /**
   * Light grey lines between all the cells, as Excel prints them with Gridlines on, except inside
   * merged blocks and where text runs on across a cell's side.
   */
  drawGrid(canvas, layout, visibleRows, c0, n, mergeOf, rowPlaced, x, y) {
    const columns = layout.plan.columns;
    canvas.strokeStyle = GRID;
    canvas.lineWidth = GRID_WIDTH / layout.scale;
    canvas.lineCap = 'butt';
    canvas.setLineDash([]);
    const stroke = (x0, y0, x1, y1) => {
      canvas.beginPath();
      canvas.moveTo(x0, y0);
      canvas.lineTo(x1, y1);
      canvas.stroke();
    };
    const rowsN = visibleRows.length;
    // Across, at the top of each row and the bottom of the last.
    for (let i = 0; i <= rowsN; i++) {
      const lineY = i < rowsN ? y(visibleRows[i]) : y(visibleRows[rowsN - 1] + 1);
      let from = -1;
      for (let j = 0; j <= n; j++) {
        const inside = j < n && i >= 1 && i < rowsN && mergeOf[i * n + j] >= 0 && mergeOf[i * n + j] === mergeOf[(i - 1) * n + j];
        const end = j === n || inside || columns.width(c0 + j) <= 0;
        if (end && from >= 0) {
          stroke(x(c0 + from), lineY, x(c0 + j - 1 + 1), lineY);
          from = -1;
        }
        if (!end && from < 0) from = j;
      }
    }
    // Down, at the left of each column and the right of the last.
    const runsOver = visibleRows.map((r) => (rowPlaced.get(r) ?? []).filter((p) => p.last > p.first));
    for (let j = 0; j <= n; j++) {
      if (j >= 1 && j < n && columns.width(c0 + j - 1) <= 0) continue;
      const column = c0 + j;
      const lineX = x(column);
      let from = -1;
      for (let i = 0; i <= rowsN; i++) {
        const inside = i < rowsN && j >= 1 && j < n
          && ((mergeOf[i * n + j] >= 0 && mergeOf[i * n + j] === mergeOf[i * n + j - 1]) || runsOver[i].some((p) => column > p.first && column <= p.last));
        const end = i === rowsN || inside;
        if (end && from >= 0) {
          stroke(lineX, y(visibleRows[from]), lineX, y(visibleRows[i - 1] + 1));
          from = -1;
        }
        if (!end && from < 0) from = i;
      }
    }
  }

  /**
   * Draws the sheet's header and footer on its page `number` (from 1), numbered `page` of the
   * PDF's `pages`, in the top and bottom margins, their left, centre and right parts lined up with
   * the paper's side margins. `fields(page, pages)` gives SheetHeaders' fields.
   */
  async drawHeaderFooter(canvas, layout, number, page, pages, fields) {
    const texts = layout.plan.setup.headerFooter;
    if (!texts) return;
    const first = texts.differentFirst && number === 1;
    const even = texts.differentOddEven && page % 2 === 0;
    const header = first ? texts.firstHeader : even ? texts.evenHeader : texts.oddHeader;
    const footer = first ? texts.firstFooter : even ? texts.evenFooter : texts.oddFooter;
    const shown = fields(page, pages);
    const scale = texts.scaleWithDoc ? layout.scale : 1;
    if (header != null) await this.drawHeaderParts(canvas, layout, SheetHeaders.parts(header, shown), scale, true);
    if (footer != null) await this.drawHeaderParts(canvas, layout, SheetHeaders.parts(footer, shown), scale, false);
  }

  async drawHeaderParts(canvas, layout, parts, scale, top) {
    const margins = layout.margins;
    const width = layout.pageWidth - margins.left - margins.right;
    const font = this.styles.defaultFont;
    const base = { ...font.style, size: f(font.size * scale) };
    for (const [i, runs] of parts.entries()) {
      if (!runs.length) continue;
      const styled = runs.map((run) => ({
        text: run.text,
        style: {
          font: run.font ?? font.name,
          size: f((run.size ?? font.size) * scale),
          bold: run.bold,
          italic: run.italic,
          underline: run.underline,
          strike: run.strike,
          color: run.color != null ? (run.color | OPAQUE) >>> 0 : BLACK,
          baseline: run.baseline,
        },
      }));
      await ensureFonts([...styled, { text: ' ', style: base }]);
      const rich = new RichText();
      for (const run of styled) rich.append(run.text, run.style);
      const block = layoutParagraphSync({
        text: rich,
        base,
        width: Math.max(1, Math.trunc(width * 10)) / 10,
        align: i === 0 ? 'start' : i === 1 ? 'center' : 'end',
        lineScale: lineScale(base),
        directionFromText: false,
        avoidSingleLines: false,
      });
      const yTop = top ? margins.header : layout.pageHeight - margins.footer - block.height;
      block.draw(canvas, margins.left, yTop);
    }
  }
}

/** The format a cell without one of its own takes: its row's, else its column's, else the Normal style. */
function formatOfPage(plan, cells, row, column) {
  const r = cells.rows.get(row);
  if (r && r.format >= 0) return r.format;
  const c = plan.columns.format(column);
  return c >= 0 ? c : 0;
}

function formatOfRow(plan, row, column) {
  const cell = row.cells.find((c) => c.column === column);
  if (cell) return cell.format;
  if (row.format >= 0) return row.format;
  const c = plan.columns.format(column);
  return c >= 0 ? c : 0;
}

function clipTo(canvas, r) {
  canvas.beginPath();
  canvas.rect(r.left, r.top, r.right - r.left, r.bottom - r.top);
  canvas.clip();
}

function fillRect(canvas, left, top, right, bottom, color) {
  canvas.fillStyle = color;
  // A hair over the bottom, so that the next row's fill leaves no seam between them.
  canvas.fillRect(left, top, right - left, bottom + SEAM - top);
}

/** A border line from (x0, y0) to (x1, y1), never printed finer than MIN_LINE at `scale`. */
function line(canvas, cellLine, x0, y0, x1, y1, scale) {
  const width = Math.max(cellLine.width, MIN_LINE / scale);
  canvas.strokeStyle = cellLine.color;
  canvas.lineCap = 'square';
  canvas.lineJoin = 'miter';
  canvas.setLineDash(cellLine.dashes ?? []);
  const stroke = (a, b, c, d) => {
    canvas.beginPath();
    canvas.moveTo(a, b);
    canvas.lineTo(c, d);
    canvas.stroke();
  };
  if (!cellLine.double) {
    canvas.lineWidth = width;
    stroke(x0, y0, x1, y1);
    return;
  }
  // Two thin lines, a line's width either side of the cell's edge.
  canvas.lineWidth = width / 3;
  const horizontal = y0 === y1;
  const dx = horizontal ? 0 : width / 3;
  const dy = horizontal ? width / 3 : 0;
  stroke(x0 - dx, y0 - dy, x1 - dx, y1 - dy);
  stroke(x0 + dx, y0 + dy, x1 + dx, y1 + dy);
}
