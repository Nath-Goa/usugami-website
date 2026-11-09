// Excel to PDF: a port of the app's XlsxConverter.kt. Workbooks (.xlsx, and .xlsm and templates,
// whose macros are left alone) are laid out the way Excel prints them: each visible sheet that has
// anything on it starts a page, and its print area (or everything on it, from A1) goes onto pages
// down and then across, with its title rows and columns repeated, at its own paper size,
// orientation, margins and scale or "Fit to".
//
// What converts: cell values as their number formats show them, and formulas' last values; fonts,
// sizes, bold, italic, underlined and struck-through text, colours, rich text; fills, borders of
// every style, alignment, indents, wrapped, shrunk and turned text; text running on into empty
// cells beside it; merged cells; column widths and row heights, hidden rows, columns and sheets;
// manual page breaks; pictures placed on the sheet. Headers and footers print with their page
// numbers, page counts, dates, and sheet and file names. Pages are numbered through the whole PDF.
//
// What is simplified: the bundled fonts stand in for the workbook's, drawn to their widths;
// patterned and gradient fills become a plain colour; wrapped and rich text underlined twice is
// underlined once. Charts, shapes, comments, conditional formatting, table styles, sparklines and
// header pictures are left out, but the values that data bars and icon sets hide stay hidden.
import { OfficePackage } from './ooxml.js';
import { OfficePdf, OfficeImages } from './office-pdf.js';
import { OfficeTheme } from './drawingml.js';
import { OfficeNothingToConvert } from './problems.js';
import { SheetRefs, SheetRange } from './xlsx-model.js';
import { CellNumbers } from './xlsx-numbers.js';
import { SheetStyles, SharedStrings } from './xlsx-styles.js';
import { CellTexts } from './xlsx-text.js';
import { RowReader, SheetPlanner } from './xlsx-sheet.js';
import { AreaLayout, PageCells, SheetPainter } from './xlsx-pages.js';
import { Pace } from './xlsx-pace.js';
import { checkCancelled } from '../../core/errors.js';

/** More pages than anyone would read on a phone, and about as many as it can make in a few minutes. */
export const MAX_PAGES = 5000;

const PAPERS = new Set(['a4', 'letter', 'legal', 'a3', 'a5']);

/** The options as the app's SheetOptions has them, anything else at its default. */
export function sheetOptions(options = {}) {
  const o = options ?? {};
  return {
    paper: PAPERS.has(o.paper) ? o.paper : null,
    landscape: o.landscape === true || o.landscape === false ? o.landscape : null,
    fitWidth: o.fitWidth !== false,
    gridlines: o.gridlines === true,
  };
}

/**
 * Converts an Excel workbook into a PDF.
 * @param {{ name: string, bytes: Uint8Array }} input   the workbook (checked already by index.js)
 * @param {{ paper?: 'a4'|'letter'|'legal'|'a3'|'a5'|null, landscape?: boolean|null, fitWidth?: boolean,
 *   gridlines?: boolean, locale?: string, now?: Date }} options   SheetOptions; `locale` is the
 *   language numbers and dates are written in (the device's by default), `now` the date and time
 *   headers and footers show (now by default)
 * @param {{ onProgress?: (done: number, total: number, info?: object) => void, signal?: AbortSignal }} hooks
 * @returns {Promise<{ bytes: Uint8Array, pageCount: number }>}
 * Throws OfficeNothingToConvert when no visible sheet has anything on it, OfficeTooLarge past
 * MAX_PAGES pages (or a crafted file's limits), CancelledError, and XmlError or ZipError for a
 * damaged part.
 */
export async function convertXlsx(input, options = {}, hooks = {}) {
  const { signal, onProgress } = hooks;
  const opts = sheetOptions(options);
  const pace = new Pace(signal);
  const pkg = await OfficePackage.open(input.bytes, { signal });
  try {
    const main = pkg.mainPart() ?? 'xl/workbook.xml';
    // A sheet as the workbook lists it: its name, whether it shows, and its part.
    const sheets = [];
    // Defined names by the sheet they belong to (its place in the workbook's list).
    const printAreas = new Map();
    const printTitles = new Map();
    let date1904 = false;
    const x = await pkg.xml(main);
    if (x) {
      for (const c of x.children()) {
        if (c.name === 'workbookPr') {
          date1904 = c.flag('date1904', false);
        } else if (c.name === 'sheets') {
          for (const s of c.children()) {
            if (s.name !== 'sheet') continue;
            const id = s.relId();
            const r = id == null ? null : pkg.relationships(main).get(id) ?? null;
            const relationship = r && !r.external ? r : null;
            const worksheet = relationship?.type?.endsWith('/worksheet') === true;
            const state = s.attr('state');
            sheets.push({ name: s.attr('name') ?? '', visible: state == null || state === 'visible', part: worksheet ? relationship.target : null });
          }
        } else if (c.name === 'definedNames') {
          for (const d of c.children()) {
            if (d.name !== 'definedName') continue;
            const name = d.attr('name');
            const sheet = d.intAttr('localSheetId');
            if (sheet == null) continue;
            if (name === '_xlnm.Print_Area') printAreas.set(sheet, d.text());
            else if (name === '_xlnm.Print_Titles') printTitles.set(sheet, d.text());
          }
        }
      }
    }
    const theme = await OfficeTheme.read(pkg, pkg.targetOfType(main, '/theme'));
    // Numbers and dates are written as the device's language writes them, as Excel writes them on a computer.
    const lang = options?.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
    const numbers = new CellNumbers(lang);
    const styles = await SheetStyles.read(pkg, pkg.targetOfType(main, '/styles'), theme, numbers);
    const strings = await SharedStrings.read(pkg, pkg.targetOfType(main, '/sharedStrings'), pace);
    const texts = new CellTexts(styles, theme, numbers, date1904);
    const pdf = await OfficePdf.create();
    const images = new OfficeImages(pkg, pdf.doc, { signal });
    const painter = new SheetPainter(styles, texts, images, opts.gridlines);
    const planner = new SheetPlanner(pkg, styles, strings, texts, theme, date1904, pace);

    // Every sheet is laid out before any is drawn: the page count is known, and checked, first.
    const laidOut = [];
    let total = 0;
    for (const [index, sheet] of sheets.entries()) {
      checkCancelled(signal);
      const part = sheet.part != null && sheet.visible && pkg.has(sheet.part) ? sheet.part : null;
      if (!part) continue;
      const plan = await planner.plan(sheet.name, part);
      const used = plan.used;
      if (!used) continue;
      const titles = titlesOf(printTitles.get(index));
      const layouts = [];
      for (const area of areasOf(printAreas.get(index), used)) {
        checkCancelled(signal);
        const layout = await AreaLayout.of(plan, area, titles, opts, MAX_PAGES - total, pace);
        total += layout.pages.length;
        if (layout.pages.length) layouts.push(layout);
      }
      if (layouts.length) laidOut.push(layouts);
    }
    if (total === 0) throw new OfficeNothingToConvert();

    // Headers and footers show the date and time the PDF is made, as the device writes them.
    const now = options?.now instanceof Date ? options.now : new Date();
    const date = formatNow(lang, now, { dateStyle: 'short' });
    const time = formatNow(lang, now, { timeStyle: 'short' });
    const work = { pkg, strings, date1904, painter, pdf, pace, signal, onProgress, total, drawn: 0 };
    let page = 0;
    for (const layouts of laidOut) {
      const plan = layouts[0].plan;
      const name = plan.name;
      const first = plan.setup.firstPageNumber ?? page + 1;
      let number = 0;
      // The sheet is read once more, for drawing its pages.
      const sheetXml = await pkg.xml(plan.part);
      for (const layout of layouts) {
        await drawLayout(work, layout, sheetXml, async (canvas) => {
          number++;
          page = first + number - 1;
          await painter.drawHeaderFooter(canvas, layout, number, page, total, (shown, count) => ({
            page: shown, pages: count, sheet: name, file: input.name ?? '', date, time,
          }));
        });
      }
    }
    return await pdf.finish({ onProgress, signal });
  } finally {
    pkg.close();
  }
}

/** `now` written the way `lang` writes it (Java's DateFormat.SHORT). */
function formatNow(lang, now, style) {
  try {
    return new Intl.DateTimeFormat(lang, style).format(now);
  } catch {
    return new Intl.DateTimeFormat(undefined, style).format(now);
  }
}

/**
 * The areas of a sheet that print: those of its print area (`printArea`, a defined name's
 * formula), each on pages of its own, or everything from A1 to the last cell `used` reaches. Whole
 * rows or columns stop where the sheet's cells do. An area named more than once prints once.
 */
export function areasOf(printArea, used) {
  const given = printArea != null ? SheetRefs.areas(printArea).map((a) => a.range) : [];
  if (!given.length) return [new SheetRange(0, 0, used.lastRow, used.lastColumn)];
  const out = [];
  const seen = new Set();
  for (const area of given) {
    const lastRow = area.lastRow === SheetRefs.MAX_ROWS - 1 ? used.lastRow : area.lastRow;
    const lastColumn = area.lastColumn === SheetRefs.MAX_COLUMNS - 1 ? used.lastColumn : area.lastColumn;
    const r = new SheetRange(area.firstRow, area.firstColumn, lastRow, lastColumn);
    const key = `${r.firstRow},${r.firstColumn},${r.lastRow},${r.lastColumn}`;
    if (r.firstRow <= r.lastRow && r.firstColumn <= r.lastColumn && !seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/** The rows and the columns repeated on each page, from a sheet's Print_Titles (`text`): [rows, columns], each [first, last] or null. */
export function titlesOf(text) {
  let rows = null;
  let columns = null;
  for (const { range } of text != null ? SheetRefs.areas(text) : []) {
    if (range.firstColumn === 0 && range.lastColumn === SheetRefs.MAX_COLUMNS - 1) rows = [range.firstRow, range.lastRow];
    else if (range.firstRow === 0 && range.lastRow === SheetRefs.MAX_ROWS - 1) columns = [range.firstColumn, range.lastColumn];
  }
  return [rows, columns];
}

/**
 * Draws `layout`'s pages, going through the sheet's rows once more for each run of pages that goes
 * down it (once for each band of columns when pages go down and then across), keeping only the
 * rows of the page being drawn, the title rows and the first cells of merged blocks.
 */
async function drawLayout(work, layout, sheetXml, headerFooter) {
  const runs = [];
  for (const page of layout.pages) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1][0] <= page[0]) run.push(page);
    else runs.push([page]);
  }
  const anchors = new Set(layout.plan.merges.map((m) => SheetRefs.pack(m.firstRow, m.firstColumn)));
  const titles = layout.titleRows;
  for (const run of runs) {
    const reader = new RowReader(work.strings, work.date1904);
    const kept = new Map();
    const titleRows = new Map();
    const bandRows = new Map();
    let next = 0;
    const drawUntil = async (row) => {
      while (next < run.length && layout.rowEnd(run[next][0]) < row) {
        const band = run[next][0];
        const rows = new Map(bandRows);
        for (const [k, v] of titleRows) rows.set(k, v);
        while (next < run.length && run[next][0] === band) {
          await drawPage(work, layout, run[next], new PageCells(rows, kept), headerFooter);
          next++;
        }
        bandRows.clear();
      }
    };
    for (const data of sheetXml ? sheetXml.children('sheetData') : []) {
      for (let el = data.el.firstElementChild; el; el = el.nextElementSibling) {
        if (el.localName !== 'row') continue;
        if (work.pace.check()) await work.pace.breathe();
        // The pages of the bands above this row are drawn before it is read.
        const index = reader.indexOf(el);
        await drawUntil(index);
        const isTitle = titles != null && index >= titles[0] && index <= titles[1];
        const inBand = next < run.length && index >= layout.rowStarts[run[next][0]] && index <= layout.rowEnd(run[next][0]);
        if (!isTitle && !inBand) {
          reader.skim(el, anchors, kept);
          continue;
        }
        const row = reader.read(el);
        for (const cell of row.cells) {
          const key = SheetRefs.pack(row.index, cell.column);
          if (anchors.has(key)) kept.set(key, cell);
        }
        if (isTitle) titleRows.set(row.index, row);
        if (inBand) bandRows.set(row.index, row);
      }
    }
    await drawUntil(Infinity);
  }
}

async function drawPage(work, layout, page, cells, headerFooter) {
  checkCancelled(work.signal);
  await work.painter.prepare(layout, page[0], page[1], cells);
  const canvas = work.pdf.startPage(layout.pageWidth, layout.pageHeight);
  work.painter.draw(canvas, layout, page[0], page[1], cells);
  await headerFooter(canvas);
  work.pdf.finishPage();
  work.onProgress?.(++work.drawn, work.total);
  await work.pace.breathe();
}
