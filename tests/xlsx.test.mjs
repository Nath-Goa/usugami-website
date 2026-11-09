// Tests for Excel to PDF (site/app/js/engine/office/xlsx.js and its xlsx-*.js helpers): the app's
// ExcelConverterDeviceTest workbooks, ported, and more of our own, written here with fflate and
// checked by reading the PDFs back: text and where it is (pdf.js), page sizes, and pixels.
import { withPage, assert } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}

/** Loads the modules and helpers into the page as window.X. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const at = (p) => import(base + 'app/js/' + p);
    const X = {};
    X.xlsx = await at('engine/office/xlsx.js');
    X.index = await at('engine/office/index.js');
    X.pdfjs = await at('lib/pdfjs.js');
    X.lib = await at('lib/pdf-lib.js');
    X.fflate = await at('lib/fflate.js');
    X.errors = await at('core/errors.js');
    const enc = new TextEncoder();
    const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    X.MAIN = MAIN;
    X.R = R;
    X.XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
    X.A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    X.zip = (files) => {
      const entries = {};
      for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? enc.encode(v) : v;
      return X.fflate.zipSync(entries);
    };
    X.rels = (...r) => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + r.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${R}/${type}" Target="${target}"/>`).join('') + '</Relationships>';
    // Formats 1 to 3 are #,##0.00, d-mmm-yy and 0.0%; 4 is centred, 5 wraps (the app's test STYLES).
    X.STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}">
      <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
      <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border/></borders>
      <cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="4"/><xf numFmtId="15"/><xf numFmtId="164"/>
      <xf numFmtId="0"><alignment horizontal="center"/></xf><xf numFmtId="0"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`;
    /**
     * A workbook of `sheets` ({ name, body, hidden, state, rels: { files }, extra }), with shared
     * `strings`, defined `names` (XML), `styles` (styles.xml) and `extra` parts.
     */
    X.workbook = (sheets, { strings = [], names = '', styles = X.STYLES, extra = {}, workbookPr = '' } = {}) => {
      const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
        '_rels/.rels': X.rels(['officeDocument', 'xl/workbook.xml']),
        'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${R}">${workbookPr}<sheets>`
          + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 3}"/>`).join('')
          + `</sheets>${names ? `<definedNames>${names}</definedNames>` : ''}</workbook>`,
        'xl/_rels/workbook.xml.rels': X.rels(['styles', 'styles.xml'], ['sharedStrings', 'sharedStrings.xml'], ...sheets.map((s, i) => ['worksheet', `worksheets/sheet${i + 1}.xml`])),
        'xl/styles.xml': styles,
        'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}">${strings.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}</sst>`,
        ...extra,
      };
      sheets.forEach((s, i) => {
        files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}" xmlns:r="${R}">${s.body}</worksheet>`;
        if (s.rels) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = s.rels;
      });
      return X.zip(files);
    };
    X.text = (ref, t, s = 0) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${t}</t></is></c>`;
    X.number = (ref, v, s = 0) => `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    X.row = (i, cells, attrs = '') => `<row r="${i}"${attrs}>${cells.join('')}</row>`;
    X.columnName = (i) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
    // As the tests read numbers: in American English, as the app's tests set the phone's locale.
    X.convert = (bytes, options = {}, hooks = {}, name = 'Book.xlsx') => X.xlsx.convertXlsx({ name, bytes }, { locale: 'en-US', ...options }, hooks);
    X.office = (bytes, options = {}, hooks = {}, name = 'Book.xlsx') => X.index.convertOffice('excel', { name, bytes }, { locale: 'en-US', ...options }, hooks);
    const open = async (bytes, fn) => {
      const pdf = await X.pdfjs.openPdfJs(bytes);
      try {
        return await fn(pdf);
      } finally {
        await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      }
    };
    /** Each page's text, runs of white space as one space. */
    X.pageTexts = (bytes) => open(bytes, async (pdf) => {
      const out = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const tc = await (await pdf.getPage(n)).getTextContent();
        out.push(tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
      }
      return out;
    });
    /** Each page's size in points. */
    X.pageSizes = (bytes) => open(bytes, async (pdf) => {
      const out = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const v = (await pdf.getPage(n)).view;
        out.push([v[2] - v[0], v[3] - v[1]]);
      }
      return out;
    });
    /** Page n's text runs: { str, x, y (baseline, from the top), w, size }. */
    X.runs = (bytes, n = 1) => open(bytes, async (pdf) => {
      const p = await pdf.getPage(n);
      const tc = await p.getTextContent();
      return tc.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: p.view[3] - i.transform[5], w: i.width, size: Math.hypot(i.transform[2], i.transform[3]) }));
    });
    /** Where `word` starts on page n: { x, y } (y the baseline from the top), or null. */
    X.word = async (bytes, n, word) => {
      for (const r of await X.runs(bytes, n)) {
        const i = r.str.indexOf(word);
        if (i >= 0) return { x: r.x + (r.w * i) / r.str.length, y: r.y, size: r.size, w: r.w, str: r.str };
      }
      return null;
    };
    /** Renders page n; px(x, y) is [r, g, b] at the point (x, y) from the top-left. */
    X.render = (bytes, n = 1, scale = 3) => open(bytes, async (pdf) => {
      const p = await pdf.getPage(n);
      const vp = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const px = (x, y) => {
        const i = (Math.round(y * scale) * canvas.width + Math.round(x * scale)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      // Whether anything in the rectangle (points) is darker than half.
      const dark = (l, t, r, b, limit = 0.5) => {
        for (let y = Math.round(t * scale); y < Math.round(b * scale); y++) {
          for (let x = Math.round(l * scale); x < Math.round(r * scale); x++) {
            const i = (y * canvas.width + x) * 4;
            if ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 < limit) return true;
          }
        }
        return false;
      };
      // How many pixels in the rectangle are near `rgb`.
      const count = (l, t, r, b, rgb, tol = 40) => {
        let k = 0;
        for (let y = Math.round(t * scale); y < Math.round(b * scale); y++) {
          for (let x = Math.round(l * scale); x < Math.round(r * scale); x++) {
            const i = (y * canvas.width + x) * 4;
            if (Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i + 1] - rgb[1]) <= tol && Math.abs(data[i + 2] - rgb[2]) <= tol) k++;
          }
        }
        return k;
      };
      return { px, dark, count };
    });
    X.thrown = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return { name: e?.name, key: e?.key ?? null, manyKey: e?.manyKey ?? null, problem: e?.problem ?? null, message: String(e?.message ?? e) };
      }
    };
    X.png = async (w, h, draw) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d'));
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    window.X = X;
  }, url);
}

// ---------------------------------------------------------------------------------------------
// The app's ExcelConverterDeviceTest, ported

async function deviceTests(page, browser) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, convert, pageTexts, pageSizes, word, render, columnName } = window.X;
    const out = {};

    // cellsShowTheirValuesAsTheirFormatsSay
    {
      const data = [
        row(1, [text('A1', 'Shared:'), '<c r="B1" t="s"><v>0</v></c>']),
        row(2, [number('A2', 1234.5, 1), number('B2', 45366.0, 2), number('C2', 0.125, 3)]),
        row(3, ['<c r="A3" t="b"><v>1</v></c>', '<c r="B3" t="e"><v>#DIV/0!</v></c>']),
        // A formula with its last value, and one whose file kept none, which shows itself.
        row(4, ['<c r="A4"><f>SUM(A2:A2)</f><v>1234.5</v></c>', '<c r="B4"><f>A2*2</f></c>']),
      ];
      const columns = '<cols><col min="1" max="3" width="14" customWidth="1"/></cols>';
      const pdf = await convert(workbook([{ name: 'Values', body: `${columns}<sheetData>${data.join('')}</sheetData>` }], { strings: ['from the table'] }));
      out.values = { pages: await pageTexts(pdf.bytes), count: pdf.pageCount };
    }

    // textRunsOnIntoEmptyCellsAndNumbersTooWideShowHashes
    {
      const data = row(1, [text('A1', 'A sentence running on past its column'), number('E1', 123456789.123, 1)])
        + row(2, [text('A2', 'Stopped here by'), number('B2', 7.0)]);
      // Column B is wide, with B2's number on its right.
      const columns = '<col min="1" max="1" width="9.140625" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="5" width="9.140625" customWidth="1"/>';
      const pdf = await convert(workbook([{ name: 'Text', body: `<cols>${columns}</cols><sheetData>${data}</sheetData>` }]));
      const start = await word(pdf.bytes, 1, 'A sentence');
      const column = await word(pdf.bytes, 1, 'column');
      const stopped = await word(pdf.bytes, 1, 'Stopped');
      const b2 = 0.7 * 72 + 48;
      const img = await render(pdf.bytes, 1);
      out.overflow = {
        page: (await pageTexts(pdf.bytes))[0],
        start: start.x,
        column: column.x,
        a2InB2: img.dark(b2 + 1, stopped.y - 7, b2 + 100, stopped.y - 1),
        a2Shows: img.dark(0.7 * 72 + 2, stopped.y - 7, b2 - 2, stopped.y - 1),
      };
    }

    // mergedCellsShowTheirTextOnceAcrossThemAndWrappedTextGrowsItsRow
    {
      const data = row(1, [text('A1', 'Centred title', 4), '<c r="B1" s="4"/>', '<c r="C1" s="4"/>', '<c r="D1" s="4"/>'])
        + row(2, [text('A2', 'alpha bravo charlie delta echo golf', 5), text('B2', 'Beside'), text('E2', 'SELF-EMPLOYED', 5)]);
      const columns = '<col min="1" max="4" width="9.140625" customWidth="1"/><col min="5" max="5" width="12" customWidth="1"/>';
      const body = `<cols>${columns}</cols><sheetData>${data}</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>`;
      const pdf = await convert(workbook([{ name: 'Merged', body }]));
      out.merged = {
        title: (await word(pdf.bytes, 1, 'Centred')).x,
        alpha: (await word(pdf.bytes, 1, 'alpha')).y,
        golf: (await word(pdf.bytes, 1, 'golf')).y,
        self: (await word(pdf.bytes, 1, 'SELF')).y,
        employed: (await word(pdf.bytes, 1, 'EMPLOYED')).y,
        page: (await pageTexts(pdf.bytes))[0],
      };
    }

    // hiddenRowsColumnsAndSheetsAreLeftOut
    {
      // The hidden column's text has an empty cell beside it to run on into, and C3's value only a data bar.
      const data = row(1, [text('A1', 'Shown'), text('B1', 'HiddenColumn'), text('D1', 'AlsoShown')])
        + row(2, [text('A2', 'HiddenRow')], ' hidden="1"')
        + row(3, [text('A3', 'LastRow'), number('C3', 4321.0)]);
      const bar = '<conditionalFormatting sqref="C3"><cfRule type="dataBar" priority="1"><dataBar showValue="0"><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>';
      const body = `<cols><col min="2" max="2" width="20" hidden="1"/></cols><sheetData>${data}</sheetData>${bar}`;
      const pdf = await convert(workbook([
        { name: 'First', body },
        { name: 'Secret', body: `<sheetData>${row(1, [text('A1', 'HiddenSheet')])}</sheetData>`, hidden: true },
        { name: 'Second', body: `<sheetData>${row(1, [text('A1', 'SecondSheet')])}</sheetData>` },
        { name: 'Empty', body: '<sheetData/>' },
        { name: 'Deep', body: `<sheetData>${row(1, [text('A1', 'HiddenVery')])}</sheetData>`, state: 'veryHidden' },
      ]));
      out.hidden = await pageTexts(pdf.bytes);
    }

    // pagesAreNumberedThroughTheWholeWorkbook
    {
      const footer = '<headerFooter><oddFooter>&amp;CPage &amp;P of &amp;N</oddFooter></headerFooter>';
      const pdf = await convert(workbook([
        { name: 'One', body: `<sheetData>${row(1, [text('A1', 'First')])}</sheetData>${footer}` },
        { name: 'Two', body: `<sheetData>${row(1, [text('A1', 'Second')])}</sheetData>${footer}` },
      ]));
      out.numbered = await pageTexts(pdf.bytes);
    }

    // onlyPagesWithSomethingOnThemPrintHoweverFarTheSheetReaches
    {
      // A sentence running on from A1 onto the page beside, and a cell at the sheet's last row and column.
      const sentence = 'Quarterly figures for every branch are kept on this sheet, one row for each month, with totals for each region, Ending';
      const data = row(1, [text('A1', sentence)]) + row(1048576, [text('XFD1048576', 'Far')]);
      const t0 = performance.now();
      const pdf = await convert(workbook([{ name: 'Far', body: `<sheetData>${data}</sheetData>` }]), { fitWidth: false });
      out.far = { pages: await pageTexts(pdf.bytes), ms: performance.now() - t0 };
    }

    // pagesFollowTheFilesPaperOrientationAndPrintTitles
    {
      // 120 rows on landscape A4, with the first row repeated at the top of each page.
      let data = '';
      for (let r = 1; r <= 120; r++) data += row(r, [r === 1 ? text('A1', 'Heading') : text(`A${r}`, `Row${r}`)]);
      const body = `<sheetData>${data}</sheetData><pageSetup paperSize="9" orientation="landscape"/>`;
      const names = '<definedName name="_xlnm.Print_Titles" localSheetId="0">Long!$1:$1</definedName>';
      const pdf = await convert(workbook([{ name: 'Long', body }], { names }));
      const pages = await pageTexts(pdf.bytes);
      const once = [];
      for (let r = 2; r <= 120; r++) once.push(pages.filter((p) => new RegExp(`\\bRow${r}\\b`).test(p)).length);
      // A paper chosen for all of them goes over the file's.
      const letter = await convert(workbook([{ name: 'Long', body }]), { paper: 'letter', landscape: false });
      out.titles = { sizes: await pageSizes(pdf.bytes), allHeading: pages.every((p) => p.includes('Heading')), once, letter: (await pageSizes(letter.bytes))[0] };
    }

    // aWideSheetFitsThePageWidthUnlessAskedNotTo
    {
      // Columns of 48 points on portrait Letter: 15 fit one page across when shrunk, while 30 would
      // be too small to read, so they go on two pages at half size, or on three unshrunk.
      const sheet = (columns) => {
        let data = '';
        for (let r = 1; r <= 5; r++) {
          const cells = [];
          for (let c = 0; c < columns; c++) cells.push(number(`${columnName(c)}${r}`, r * 100 + c));
          data += row(r, cells);
        }
        return [{ name: 'Wide', body: `<sheetData>${data}</sheetData>` }];
      };
      const fitted = await pageTexts((await convert(workbook(sheet(15)))).bytes);
      const halved = await pageTexts((await convert(workbook(sheet(30)))).bytes);
      const split = await pageTexts((await convert(workbook(sheet(30)), { fitWidth: false })).bytes);
      const each = (pages) => {
        const counts = [];
        for (let c = 0; c < 30; c++) counts.push(pages.filter((p) => p.split(' ').includes(`${500 + c}`)).length);
        return counts;
      };
      out.wide = { fitted, halved: halved.length, split: split.length, halvedEach: each(halved), splitEach: each(split) };
    }
    return out;
  });

  const values = r.values.pages;
  check(`${browser}: one page of values`, values.length === 1 && r.values.count === 1, values);
  for (const shown of ['Shared:', 'from the table', '1,234.50', '15-Mar-24', '12.5%', 'TRUE', '#DIV/0!', '1234.5', '=A2*2']) {
    check(`${browser}: "${shown}" shows`, values[0].includes(shown), values[0]);
  }

  check(`${browser}: text runs on past column A`, r.overflow.column - r.overflow.start > 48, r.overflow);
  check(`${browser}: a number too wide shows as #`, r.overflow.page.includes('###') && !r.overflow.page.includes('123,456,789'), r.overflow.page);
  check(`${browser}: text stops where the next cell has something`, !r.overflow.a2InB2 && r.overflow.a2Shows, r.overflow);

  const margin = 0.7 * 72;
  check(`${browser}: merged title centred across the four columns`, r.merged.title > margin + 48 && r.merged.title < margin + 96, r.merged);
  check(`${browser}: wrapped words go under one another`, r.merged.golf - r.merged.alpha > 20, r.merged);
  check(`${browser}: merged text shows once`, r.merged.page.split('Centred').length - 1 === 1, r.merged.page);
  check(`${browser}: a long word breaks after its hyphen`, r.merged.employed - r.merged.self > 10, r.merged);

  const hidden = r.hidden;
  check(`${browser}: each visible sheet with something starts a page`, hidden.length === 2, hidden);
  check(`${browser}: visible cells show`, hidden[0].includes('Shown') && hidden[0].includes('AlsoShown') && hidden[0].includes('LastRow'), hidden[0]);
  check(`${browser}: the second sheet follows`, hidden[1].includes('SecondSheet'), hidden[1]);
  check(`${browser}: hidden rows, columns, sheets and a data bar's value are left out`, !hidden.some((p) => p.includes('Hidden') || p.includes('4321')), hidden);

  check(`${browser}: pages numbered through the workbook`, r.numbered[0].includes('Page 1 of 2') && r.numbered[1].includes('Page 2 of 2'), r.numbered);

  check(`${browser}: only pages with something print`, r.far.pages.length === 3, r.far.pages);
  check(`${browser}: the sentence ends on the page beside`, r.far.pages[1]?.includes('Ending'), r.far.pages);
  check(`${browser}: the far cell prints`, r.far.pages[2]?.includes('Far'), r.far.pages);
  check(`${browser}: a sheet reaching XFD1048576 is quick`, r.far.ms < 20000, r.far.ms);

  check(`${browser}: several landscape pages`, r.titles.sizes.length >= 3, r.titles.sizes);
  check(`${browser}: landscape A4 pages`, r.titles.sizes.every(([w, h]) => Math.abs(w - 842) <= 1 && Math.abs(h - 595) <= 1), r.titles.sizes);
  check(`${browser}: the title row on every page`, r.titles.allHeading);
  check(`${browser}: every row once`, r.titles.once.every((n) => n === 1), r.titles.once);
  check(`${browser}: a chosen paper goes over the file's`, r.titles.letter[0] === 612 && r.titles.letter[1] === 792, r.titles.letter);

  check(`${browser}: 15 columns fit one page`, r.wide.fitted.length === 1 && r.wide.fitted[0].includes('514'), r.wide.fitted);
  check(`${browser}: 30 columns at half size on two pages`, r.wide.halved === 2, r.wide);
  check(`${browser}: 30 columns unshrunk on three pages`, r.wide.split === 3, r.wide);
  check(`${browser}: every column on one page only`, r.wide.halvedEach.every((n) => n === 1) && r.wide.splitEach.every((n) => n === 1), r.wide);
}

/** oldEncryptedAndOtherFilesAreRefusedWithTheirOwnMessage and cancellingLeavesNothingBehind. */
async function refusedAndCancelled(page, browser) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, zip, rels, office, thrown, convert } = window.X;
    const out = {};
    const compound = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const join = (...parts) => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let i = 0;
      for (const p of parts) { all.set(p, i); i += p.length; }
      return all;
    };
    out.legacy = await thrown(() => office(join(compound, new Uint8Array(2048)), {}, {}, 'old.xls'));
    const name = new Uint8Array([...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]));
    out.encrypted = await thrown(() => office(join(compound, new Uint8Array(1000), name, new Uint8Array(1000)), {}, {}, 'locked.xlsx'));
    out.notes = await thrown(() => office(new TextEncoder().encode('Not a workbook at all.'), {}, {}, 'notes.xlsx'));
    // A Word document picked in Excel to PDF.
    const document = zip({
      '_rels/.rels': rels(['officeDocument', 'word/document.xml']),
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    });
    out.word = await thrown(() => office(document, {}, {}, 'letter.xlsx'));
    // A workbook with nothing on its visible sheets converts to nothing, and says so.
    out.empty = await thrown(() => office(workbook([{ name: 'Empty', body: '<sheetData/>' }])));
    out.onlyHidden = await thrown(() => office(workbook([{ name: 'H', body: `<sheetData>${row(1, [text('A1', 'x')])}</sheetData>`, hidden: true }])));

    // cancellingLeavesNothingBehind: cancelled after the third page, nothing comes back.
    let data = '';
    for (let r = 1; r <= 2000; r++) data += row(r, [text(`A${r}`, `Line ${r}`), number(`B${r}`, r)]);
    const long = workbook([{ name: 'Long', body: `<sheetData>${data}</sheetData>` }]);
    const controller = new AbortController();
    const seen = [];
    out.cancelled = await thrown(() => office(long, { name: 'cancelled' }, {
      signal: controller.signal,
      onProgress: (done, total) => {
        seen.push([done, total]);
        if (done >= 3) controller.abort();
      },
    }));
    out.seen = seen.slice(0, 4);
    // The same workbook converted whole: progress counts every page up to the total, then saving.
    const progress = [];
    const whole = await convert(long, {}, { onProgress: (done, total, info) => progress.push([done, total, !!info?.compressing]) });
    out.whole = { pages: whole.pageCount, first: progress[0], last: progress[progress.length - 1], monotonic: progress.every((p, i) => i === 0 || p[0] >= progress[i - 1][0]) };
    return out;
  });
  check(`${browser}: an old .xls`, r.legacy?.key === 'office_legacy_excel' && r.legacy.manyKey === 'office_legacy_excel_many', r.legacy);
  check(`${browser}: a password-protected workbook`, r.encrypted?.key === 'office_encrypted_excel', r.encrypted);
  check(`${browser}: not a workbook`, r.notes?.key === 'office_not_excel', r.notes);
  check(`${browser}: a Word document as .xlsx`, r.word?.key === 'office_not_excel', r.word);
  check(`${browser}: nothing to convert`, r.empty?.key === 'office_no_sheets' && r.empty.manyKey === 'office_no_sheets_many', r.empty);
  check(`${browser}: only hidden sheets`, r.onlyHidden?.key === 'office_no_sheets', r.onlyHidden);
  check(`${browser}: cancelling stops the conversion`, r.cancelled?.name === 'CancelledError', r.cancelled);
  check(`${browser}: progress counts pages of the total`, r.seen[0][0] === 1 && r.seen[0][1] > 3, r.seen);
  check(`${browser}: progress up to the total, then saving`, r.whole.first[0] === 1 && r.whole.last[0] === r.whole.pages && r.whole.last[2] && r.whole.monotonic, r.whole);
}

// ---------------------------------------------------------------------------------------------
// Print setup

async function printSetup(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, convert, pageTexts, pageSizes, word, columnName } = window.X;
    const out = {};
    const grid = (rows, columns, fill = (r, c) => `${columnName(c)}${r}`) => {
      let data = '';
      for (let r = 1; r <= rows; r++) {
        const cells = [];
        for (let c = 0; c < columns; c++) cells.push(text(`${columnName(c)}${r}`, fill(r, c)));
        data += row(r, cells);
      }
      return data;
    };

    // A print area: only its cells print; two areas each on pages of their own; whole columns stop where the cells do.
    {
      const body = `<sheetData>${grid(6, 6)}</sheetData>`;
      const one = await convert(workbook([{ name: 'Data', body }], { names: '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$B$2:$C$3</definedName>' }));
      const two = await convert(workbook([{ name: 'Data', body }], { names: "<definedName name=\"_xlnm.Print_Area\" localSheetId=\"0\">'Data'!$A$1:$A$2,Data!$E$5:$F$6,Data!$A$1:$A$2</definedName>" }));
      const whole = await convert(workbook([{ name: 'Data', body }], { names: '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$D:$E</definedName>' }));
      const b2 = await word(one.bytes, 1, 'B2');
      out.area = { one: await pageTexts(one.bytes), two: await pageTexts(two.bytes), whole: await pageTexts(whole.bytes), b2 };
    }

    // Title columns repeated on each page across; manual breaks between rows and columns.
    {
      const body = `<cols><col min="1" max="20" width="20" customWidth="1"/></cols><sheetData>${grid(3, 20)}</sheetData>`;
      const titled = await convert(workbook([{ name: 'T', body }], { names: '<definedName name="_xlnm.Print_Titles" localSheetId="0">T!$A:$A</definedName>' }), { fitWidth: false });
      const breaks = `<sheetData>${grid(10, 4)}</sheetData><rowBreaks count="1" manualBreakCount="1"><brk id="4" max="16383" man="1"/></rowBreaks><colBreaks count="1"><brk id="2" max="1048575" man="1"/></colBreaks>`;
      const broken = await convert(workbook([{ name: 'B', body: breaks }]), { fitWidth: false });
      // Fitted to one page across, column breaks don't apply, as in Excel's Fit to; row breaks still do.
      const fitted = await convert(workbook([{ name: 'B', body: breaks }]));
      out.titles = { pages: await pageTexts(titled.bytes), broken: await pageTexts(broken.bytes), fitted: await pageTexts(fitted.bytes) };
    }

    // Fit to: a long sheet set to fit one page tall and wide; and a sheet at 50%.
    {
      const long = `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetData>${grid(200, 3)}</sheetData><pageSetup fitToWidth="1" fitToHeight="1"/>`;
      const fit = await convert(workbook([{ name: 'F', body: long }]));
      const wideFree = `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetData>${grid(200, 3)}</sheetData><pageSetup fitToWidth="1" fitToHeight="0"/>`;
      const free = await convert(workbook([{ name: 'F', body: wideFree }]));
      const half = `<sheetData>${grid(3, 3)}</sheetData><pageSetup scale="50"/>`;
      const halved = await convert(workbook([{ name: 'H', body: half }]), { fitWidth: false });
      const c1 = await word(halved.bytes, 1, 'C1');
      const a1 = await word(halved.bytes, 1, 'A1');
      out.fit = { fit: (await pageTexts(fit.bytes)), free: (await pageTexts(free.bytes)).length, c1: c1.x - a1.x, size: c1.size };
    }

    // Margins, centring, paper size, orientation from the file, and a paper and orientation chosen for every sheet.
    {
      const body = (extra) => `<sheetData>${row(1, [text('A1', 'Corner')])}</sheetData>${extra}`;
      const margins = await convert(workbook([{ name: 'M', body: body('<pageMargins left="2" right="0.5" top="1.5" bottom="0.5" header="0.3" footer="0.3"/>') }]));
      const centred = await convert(workbook([{ name: 'C', body: body('<printOptions horizontalCentered="1" verticalCentered="1"/>') }]));
      const legal = await convert(workbook([{ name: 'L', body: body('<pageSetup paperSize="5" orientation="landscape"/>') }]));
      const sized = await convert(workbook([{ name: 'S', body: body('<pageSetup paperWidth="210mm" paperHeight="99mm"/>') }]));
      const chosen = await convert(workbook([{ name: 'L', body: body('<pageSetup paperSize="5" orientation="landscape"/>') }, { name: 'P', body: body('') }]), { paper: 'a5', landscape: true });
      const portrait = await convert(workbook([{ name: 'L', body: body('<pageSetup paperSize="9" orientation="landscape"/>') }]), { landscape: false });
      out.page = {
        margins: await word(margins.bytes, 1, 'Corner'),
        centred: await word(centred.bytes, 1, 'Corner'),
        legal: (await pageSizes(legal.bytes))[0],
        sized: (await pageSizes(sized.bytes))[0],
        chosen: await pageSizes(chosen.bytes),
        portrait: (await pageSizes(portrait.bytes))[0],
      };
    }

    // Pages over then down; and a sheet's own first page number.
    {
      const body = `<cols><col min="1" max="30" width="20" customWidth="1"/></cols><sheetData>${grid(100, 30, (r, c) => `R${r}C${c}`)}</sheetData><pageSetup pageOrder="overThenDown"/>`;
      const over = await convert(workbook([{ name: 'O', body }]), { fitWidth: false });
      const pages = await pageTexts(over.bytes);
      const footer = '<headerFooter><oddFooter>&amp;CPage &amp;P</oddFooter></headerFooter>';
      const numbered = await convert(workbook([
        { name: 'One', body: `<sheetData>${row(1, [text('A1', 'One')])}</sheetData><pageSetup firstPageNumber="7" useFirstPageNumber="1"/>${footer}` },
        { name: 'Two', body: `<sheetData>${row(1, [text('A1', 'Two')])}</sheetData>${footer}` },
      ]));
      out.order = { second: pages[1].includes('R1C') && !pages[1].includes('R50C1 '), firstFirst: pages[0].includes('R1C0'), numbered: await pageTexts(numbered.bytes) };
    }
    return out;
  });
  check('print area: only its cells', r.area.one.length === 1 && r.area.one[0] === 'B2 C2 B3 C3', r.area.one);
  check('print area: starts at the margin', Math.abs(r.area.b2.x - (0.7 * 72 + 1.5)) < 2, r.area.b2);
  check('print area: each area on its own pages, once', r.area.two.length === 2 && r.area.two[0] === 'A1 A2' && r.area.two[1] === 'E5 F5 E6 F6', r.area.two);
  check('print area: whole columns stop at the last row', r.area.whole.length === 1 && r.area.whole[0] === 'D1 E1 D2 E2 D3 E3 D4 E4 D5 E5 D6 E6', r.area.whole);
  check('print titles: column A on every page across', r.titles.pages.length > 1 && r.titles.pages.every((p) => p.startsWith('A1 ')), r.titles.pages);
  check('print titles: the next columns after column A', r.titles.pages.length === 7 && r.titles.pages[1].startsWith('A1 A2 A3 E1 F1 G1'), r.titles.pages);
  check('breaks: rows and columns', r.titles.broken.length === 4 && r.titles.broken[0] === 'A1 B1 A2 B2 A3 B3 A4 B4' && r.titles.broken[1] === 'A5 B5 A6 B6 A7 B7 A8 B8 A9 B9 A10 B10' && r.titles.broken[2].startsWith('C1 D1'), r.titles.broken);
  check('breaks: fitted to the page width, only row breaks', r.titles.fitted.length === 2 && r.titles.fitted[0].startsWith('A1 B1 C1 D1') && r.titles.fitted[1].startsWith('A5 B5 C5 D5'), r.titles.fitted);
  check('fit to one page', r.fit.fit.length === 1 && r.fit.fit[0].includes('C200'), r.fit.fit.length);
  check('fit to one page wide, any number tall', r.fit.free > 1, r.fit.free);
  check('scale 50%: columns half as wide', Math.abs(r.fit.c1 - 48) < 1.5 && Math.abs(r.fit.size - 5.5) < 0.3, r.fit);
  check('margins from the file', Math.abs(r.page.margins.x - (144 + 1.5)) < 1 && r.page.margins.y > 108 && r.page.margins.y < 108 + 15, r.page.margins);
  check('centred on the page', r.page.centred.x > 250 && r.page.centred.y > 350, r.page.centred);
  check('legal landscape from the file', r.page.legal[0] === 1008 && r.page.legal[1] === 612, r.page.legal);
  check('paper width and height from the file', r.page.sized[0] === 281 && r.page.sized[1] === 595, r.page.sized);
  check('A5 landscape chosen for every sheet', r.page.chosen.length === 2 && r.page.chosen.every(([w, h]) => w === 595 && h === 420), r.page.chosen);
  check('portrait chosen over the file', r.page.portrait[0] === 595 && r.page.portrait[1] === 842, r.page.portrait);
  check('over then down', r.order.firstFirst && r.order.second, r.order);
  check('first page number of a sheet, and the next sheet goes on from it', r.order.numbered[0].includes('Page 7') && r.order.numbered[1].includes('Page 8'), r.order.numbered);
}

// ---------------------------------------------------------------------------------------------
// Cells: formats, fonts, colours, alignment

async function cells(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, convert, pageTexts, word, render, MAIN } = window.X;
    const out = {};
    const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}">
      <numFmts count="8">
        <numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/>
        <numFmt numFmtId="165" formatCode="# ?/?"/>
        <numFmt numFmtId="166" formatCode="[$€-x-euro2] #,##0.00"/>
        <numFmt numFmtId="167" formatCode="0.00E+00"/>
        <numFmt numFmtId="168" formatCode="&quot;Item: &quot;@"/>
        <numFmt numFmtId="169" formatCode="dddd, mmmm d, yyyy"/>
        <numFmt numFmtId="170" formatCode="[h]:mm"/>
        <numFmt numFmtId="171" formatCode="0;[Blue]-0;&quot;zero&quot;"/>
      </numFmts>
      <fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF00B050"/><name val="Calibri"/></font>
        <font><sz val="20"/><name val="Calibri"/></font><font><sz val="11"/><color theme="5"/><name val="Courier New"/></font><font><strike/><sz val="11"/><name val="Calibri"/></font></fonts>
      <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FF0000FF"/></patternFill></fill><fill><patternFill patternType="mediumGray"><fgColor rgb="FF000000"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></fills>
      <borders count="3"><border/><border><left style="thick"><color rgb="FFFF0000"/></left><right style="thin"/><top style="thin"/><bottom style="thin"/></border>
        <border diagonalDown="1"><diagonal style="thin"/></border></borders>
      <cellXfs count="20">
        <xf/>
        <xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="168"/><xf numFmtId="169"/><xf numFmtId="170"/><xf numFmtId="171"/>
        <xf fontId="1"/><xf fontId="2"/><xf fontId="3"/><xf fontId="4"/>
        <xf fillId="2"/><xf fillId="3"/><xf borderId="1"/><xf borderId="2"/>
        <xf><alignment horizontal="right" indent="2"/></xf>
        <xf><alignment horizontal="centerContinuous"/></xf>
        <xf><alignment horizontal="fill"/></xf>
      </cellXfs></styleSheet>`;
    const data = [
      row(1, [number('A1', -1234.5, 1), number('B1', 1.5, 2), number('C1', 1234.5, 3), number('D1', 12345.678, 4)]),
      row(2, [text('A2', 'apple', 5), number('B2', 45366, 6), number('C2', 1.5, 7), number('D2', 0, 8)]),
      row(3, [text('A3', 'Green bold', 9), text('B3', 'Big', 10), text('C3', 'Mono', 11), text('D3', 'Struck', 12)]),
      row(4, [text('A4', ' ', 13), '<c r="B4" s="14"/>', '<c r="C4" s="15"/>', '<c r="D4" s="16"/>'], ' ht="20" customHeight="1"'),
      row(5, [text('A5', 'Right', 17), text('B5', 'Across', 18), '<c r="C5" s="18"/>', '<c r="D5" s="18"/>']),
      row(6, [text('A6', 'ab', 19), number('B6', -5, 8)]),
      row(7, [`<c r="A7" t="d"><v>2024-03-15</v></c>`, '<c r="B7" s="6" t="d"><v>2024-03-15T00:00:00</v></c>']),
    ];
    const cols = '<cols><col min="1" max="4" width="24" customWidth="1"/></cols>';
    const pdf = await convert(workbook([{ name: 'Cells', body: `${cols}<sheetData>${data.join('')}</sheetData>` }], { styles }));
    const img = await render(pdf.bytes, 1);
    const page = (await pageTexts(pdf.bytes))[0];
    const left = 0.7 * 72;
    const col = (Math.floor((256 * 24 + Math.floor(128 / 7)) / 256 * 7)) * 0.75;
    const neg = await word(pdf.bytes, 1, '-1,234.50');
    const green = await word(pdf.bytes, 1, 'Green');
    const big = await word(pdf.bytes, 1, 'Big');
    const right = await word(pdf.bytes, 1, 'Right');
    const across = await word(pdf.bytes, 1, 'Across');
    // Row 3 grows to its 20-point font's line (20 × (1.22 + 0.14)); row 4 is 20 points high.
    const h3 = 20 * (1.22 + 0.14);
    const rowTop = (n) => (n <= 3 ? 54 + 15 * (n - 1) : n === 4 ? 54 + 30 + h3 : 54 + 30 + h3 + 20 + 15 * (n - 5));
    const struck = await word(pdf.bytes, 1, 'Struck');
    out.cells = {
      page, col,
      red: img.count(neg.x, neg.y - 8, neg.x + 40, neg.y, [255, 0, 0], 80),
      green: img.count(green.x, green.y - 8, green.x + 40, green.y, [0, 176, 80], 70),
      bigSize: big.size,
      right: right.x + right.w,
      rightEdge: left + col - 1.5 - 2 * 7.5,
      across: across.x + across.w / 2,
      acrossCentre: left + 2.5 * col,
      struck: struck.y,
      struckWanted: 54 + 30 + h3 - 0.75 - 0.293 * 11,
      fill: img.px(left + col / 2, rowTop(4) + 7),
      pattern: img.px(left + col * 1.5, rowTop(4) + 7),
      border: img.count(left + 2 * col - 2, rowTop(4) + 2, left + 2 * col + 2, rowTop(4) + 13, [255, 0, 0], 80),
      diagonal: img.dark(left + 3 * col + col / 2 - 1, rowTop(4) + 10 - 1, left + 3 * col + col / 2 + 1, rowTop(4) + 10 + 1),
      blueZero: img.count(left + col, rowTop(6), left + 2 * col, rowTop(6) + 15, [0, 0, 255], 80),
    };
    out.colPoints = col;
    return out;
  });
  const p = r.cells.page;
  for (const shown of ['-1,234.50', '1 1/2', '€ 1,234.50', '1.23E+04', 'Item: apple', 'Friday, March 15, 2024', '36:00', 'zero', 'Green bold', 'Big', 'Mono', 'Struck', 'Right', 'Across', '-5', '45366']) {
    check(`cells: "${shown}" shows`, p.includes(shown), p);
  }
  check('cells: fill repeats its text across the cell', /(ab){8,}/.test(p.replace(/ /g, '')), p);
  check('cells: red negative', r.cells.red > 10, r.cells);
  check('cells: coloured font', r.cells.green > 10, r.cells);
  check('cells: larger font', Math.abs(r.cells.bigSize - 20) < 0.5, r.cells);
  check('cells: a 20-point font grows its row', Math.abs(r.cells.struck - r.cells.struckWanted) < 1, r.cells);
  check('cells: right aligned with an indent', Math.abs(r.cells.right - r.cells.rightEdge) < 1.5, r.cells);
  check('cells: centred across the cells after it', Math.abs(r.cells.across - r.cells.acrossCentre) < 2, r.cells);
  check('cells: solid fill', r.cells.fill[2] > 200 && r.cells.fill[0] < 60, r.cells.fill);
  check('cells: a pattern shows as a blend', r.cells.pattern.every((v) => v > 90 && v < 170), r.cells.pattern);
  check('cells: thick red border', r.cells.border > 10, r.cells);
  check('cells: diagonal border', r.cells.diagonal, r.cells);
  check('cells: a negative in [Blue]', r.cells.blueZero > 5, r.cells);
}

async function alignment(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, row, convert, pageTexts, runs, MAIN } = window.X;
    const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}">
      <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
      <cellXfs count="6"><xf/>
      <xf><alignment textRotation="90"/></xf><xf><alignment textRotation="180"/></xf><xf><alignment textRotation="255"/></xf>
      <xf><alignment vertical="top"/></xf><xf><alignment vertical="center" horizontal="center"/></xf></cellXfs></styleSheet>`;
    const rich = '<c r="F1" s="1" t="inlineStr"><is><r><rPr><b/></rPr><t>All bold</t></r></is></c>';
    const data = row(1, [text('A1', 'Upward', 1), text('B1', 'Downward', 2), text('C1', 'Stack', 3), text('D1', 'Top', 4), text('E1', 'Mid', 5), rich], ' ht="80" customHeight="1"')
      + row(2, [text('A2', 'नमस्ते दुनिया'), text('B2', 'Ünïcödé çafé')]);
    const pdf = await convert(workbook([{ name: 'A', body: `<cols><col min="1" max="6" width="14" customWidth="1"/></cols><sheetData>${data}</sheetData>` }], { styles }));
    const angle = async (word) => {
      const p = await window.X.pdfjs.openPdfJs(pdf.bytes);
      const tc = await (await p.getPage(1)).getTextContent();
      await (p.destroy ? p.destroy() : p.loadingTask.destroy());
      const item = tc.items.find((i) => i.str.includes(word));
      return item ? Math.round((Math.atan2(item.transform[1], item.transform[0]) * 180) / Math.PI) : null;
    };
    const list = await runs(pdf.bytes, 1);
    const stack = ['S', 't', 'a', 'c', 'k'].map((ch) => list.find((i) => i.str === ch)?.y ?? null);
    return {
      page: (await pageTexts(pdf.bytes))[0],
      up: await angle('Upward'),
      down: await angle('Downward'),
      bold: await angle('All bold'),
      stack,
      top: list.find((i) => i.str === 'Top')?.y,
      mid: list.find((i) => i.str === 'Mid')?.y,
    };
  });
  check('turned text: up', r.up === 90, r);
  check('turned text: down', r.down === -90, r);
  check('turned rich text is drawn in the cell\'s font', r.bold === 90, r);
  check('stacked letters one under another', r.stack.every((y, i) => y != null && (i === 0 || y > r.stack[i - 1] + 8)), r.stack);
  check('top aligned', r.top > 54 + 8 && r.top < 54 + 16, r);
  check('centred down the row', r.mid > 54 + 40 && r.mid < 54 + 50, r);
  check('Hindi and accented text read back', r.page.includes('नमस्ते') && r.page.includes('Ünïcödé çafé'), r.page);
}

// ---------------------------------------------------------------------------------------------
// Pictures, headers and footers, gridlines

async function picturesAndHeaders(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, row, convert, pageTexts, render, rels, png, XDR, A, R } = window.X;
    const out = {};
    const picture = await png(100, 50, (g) => {
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 50, 50);
      g.fillStyle = '#0000ff';
      g.fillRect(50, 0, 50, 50);
    });
    const anchor = (kind, inner) => `<xdr:${kind}>${inner}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="P"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:${kind}>`;
    const marker = (tag, col, row, colOff = 0, rowOff = 0) => `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${tag}>`;
    const drawingXml = `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">`
      + anchor('twoCellAnchor', marker('from', 1, 2) + marker('to', 3, 6))
      + anchor('oneCellAnchor', marker('from', 0, 10) + '<xdr:ext cx="1270000" cy="635000"/>')
      + '</xdr:wsDr>';
    const sheet = {
      name: 'Pictures',
      body: `<sheetData>${row(1, [text('A1', 'Above the pictures')])}</sheetData><drawing r:id="rId1"/>`,
      rels: rels(['drawing', '../drawings/drawing1.xml']),
    };
    const extra = {
      'xl/drawings/drawing1.xml': drawingXml,
      'xl/drawings/_rels/drawing1.xml.rels': rels(['image', '../media/image1.png']),
      'xl/media/image1.png': picture,
    };
    const pdf = await convert(workbook([sheet], { extra }));
    const img = await render(pdf.bytes, 1);
    const left = 0.7 * 72;
    // B3:D7 (two cells across, four down): red on its left half, blue on its right.
    out.pictures = {
      red: img.px(left + 48 + 20, 54 + 30 + 30),
      blue: img.px(left + 48 + 96 - 20, 54 + 30 + 30),
      outside: img.px(left + 48 + 96 + 10, 54 + 30 + 30),
      second: img.px(left + 30, 54 + 150 + 25),
      secondBlue: img.px(left + 75, 54 + 150 + 25),
    };
    // A picture alone on a sheet still prints, and the sheet's area reaches it.
    const alone = { ...sheet, body: '<sheetData/><drawing r:id="rId1"/>' };
    out.pictures.alone = (await convert(workbook([alone], { extra }))).pageCount;

    // Headers and footers: sheet and file names, dates, a different first page, odd and even.
    const hf = '<headerFooter differentFirst="1" differentOddEven="1"><oddHeader>&amp;L&amp;A&amp;C&amp;F&amp;R&amp;D &amp;T</oddHeader><oddFooter>&amp;COdd &amp;P of &amp;N</oddFooter>'
      + '<evenHeader>&amp;L&amp;A&amp;C&amp;F&amp;R&amp;D &amp;T</evenHeader><evenFooter>&amp;CEven &amp;P</evenFooter><firstFooter>&amp;RFirst page&amp;L&amp;"Times New Roman,Italic"&amp;14&amp;KFF0000Red &amp;&amp; big</firstFooter></headerFooter>';
    let rows = '';
    for (let n = 1; n <= 100; n++) rows += row(n, [text(`A${n}`, `Line${n}`)]);
    const headed = await convert(workbook([{ name: 'Sales 2024', body: `<sheetData>${rows}</sheetData>${hf}` }]), { now: new Date(2026, 0, 2, 9, 30) }, {}, 'Report.xlsx');
    const texts = await pageTexts(headed.bytes);
    const first = await render(headed.bytes, 1);
    out.headers = { texts, red: first.count(54, 792 - 40, 200, 792 - 5, [255, 0, 0], 80) };
    return out;
  });
  const p = r.pictures;
  check('pictures: two-cell anchor, left half red', p.red[0] > 200 && p.red[2] < 60, p);
  check('pictures: two-cell anchor, right half blue', p.blue[2] > 200 && p.blue[0] < 60, p);
  check('pictures: nothing past its anchor', p.outside.every((v) => v > 240), p);
  check('pictures: one-cell anchor with a size', p.second[0] > 200 && p.secondBlue[2] > 200, p);
  check('pictures: a picture alone on a sheet prints', p.alone === 1, p);
  const t = r.headers.texts;
  check('headers: three pages', t.length === 3, t);
  check('headers: the first page has its own footer', t[0].includes('First page') && t[0].includes('Red & big') && !t[0].includes('Odd'), t[0]);
  check('headers: the first page has no header of its own', !t[0].includes('Report.xlsx'), t[0]);
  check('headers: even pages', t[1].includes('Even 2') && t[1].includes('Report.xlsx') && t[1].includes('Sales 2024') && t[1].includes('1/2/26') && t[1].includes('9:30'), t[1]);
  check('headers: odd pages', t[2].includes('Odd 3 of 3'), t[2]);
  check('headers: coloured text', r.headers.red > 10, r.headers);
}

async function gridlines(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, row, convert, render } = window.X;
    const out = {};
    const data = `<sheetData>${row(1, [text('A1', 'a'), text('B1', 'b')])}${row(2, [text('A2', 'c'), text('B2', 'd')])}</sheetData>`;
    const left = 0.7 * 72;
    // The line between A1 and B1, at x = left + 48, halfway down row 1.
    const line = async (bytes) => {
      const img = await render(bytes, 1, 4);
      return img.count(left + 48 - 1, 54 + 3, left + 48 + 1, 54 + 12, [192, 192, 192], 50);
    };
    out.off = await line((await convert(workbook([{ name: 'S', body: data }]))).bytes);
    out.on = await line((await convert(workbook([{ name: 'S', body: data }]), { gridlines: true })).bytes);
    out.printed = await line((await convert(workbook([{ name: 'S', body: `${data}<printOptions gridLines="1"/>` }]))).bytes);
    out.hiddenOnScreen = await line((await convert(workbook([{ name: 'S', body: `<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>${data}` }]), { gridlines: true })).bytes);
    return out;
  });
  check('gridlines: off at first', r.off === 0, r);
  check('gridlines: on for sheets that show them', r.on > 5, r);
  check('gridlines: a sheet set to print them gets them', r.printed > 5, r);
  check('gridlines: not on a sheet that hides them', r.hiddenOnScreen === 0, r);
}

// ---------------------------------------------------------------------------------------------
// Odd, damaged and large files

async function oddFiles(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, convert, office, pageTexts, thrown, zip, rels, MAIN, R } = window.X;
    const out = {};
    // Shared formulas without values, rows and cells without references, out of order and repeated,
    // a column past XFD, a cell longer than Excel allows, rich text runs past the text's end.
    const long = 'x'.repeat(40000);
    const data = [
      '<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f></c><c r="B1"><v>1</v></c></row>',
      '<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>',
      '<row><c><f t="shared" si="0"/></c><c><v>3</v></c></row>',
      '<row r="5"><c r="C5" t="inlineStr"><is><t>third</t></is></c><c r="A5" t="inlineStr"><is><t>first</t></is></c><c r="A5" t="inlineStr"><is><t>again</t></is></c></row>',
      `<row r="6"><c r="A6" t="inlineStr"><is><t>${long}</t></is></c><c r="B6"><v>6</v></c></row>`,
      '<row r="7"><c r="A7" t="inlineStr"><is><r><rPr><b/></rPr><t>Rich</t></r><r><t> plain</t></r></is></c></row>',
      '<row r="8"><c r="A8" t="s"><v>99</v></c><c r="B8" t="n"><v>not a number</v></c><c r="C8" t="b"><v>true</v></c></row>',
    ];
    const odd = await convert(workbook([{ name: 'Odd', body: `<sheetData>${data.join('')}</sheetData>` }]), { fitWidth: false });
    out.odd = await pageTexts(odd.bytes);

    // A workbook in Strict Open XML, with the 1904 date system.
    const SMAIN = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
    const SR = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
    const srels = (...r) => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + r.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${SR}/${type}" Target="${target}"/>`).join('') + '</Relationships>';
    const strict = zip({
      '_rels/.rels': srels(['officeDocument', 'xl/workbook.xml']),
      'xl/workbook.xml': `<x:workbook xmlns:x="${SMAIN}" xmlns:r="${SR}"><x:workbookPr date1904="1"/><x:sheets><x:sheet name="S" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': srels(['worksheet', 'worksheets/sheet1.xml'], ['styles', 'styles.xml']),
      'xl/styles.xml': `<x:styleSheet xmlns:x="${SMAIN}"><x:cellXfs><x:xf/><x:xf numFmtId="14"/></x:cellXfs></x:styleSheet>`,
      'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="${SMAIN}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Strict</x:t></x:is></x:c><x:c r="B1" s="1"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    });
    out.strict = await pageTexts((await office(strict)).bytes);

    // Damaged parts: the app's messages.
    out.badSheet = await thrown(() => office(workbook([{ name: 'B', body: '<sheetData><row r="1"><c r="A1"><v>1</v></row></sheetData>' }])));
    out.badStyles = await thrown(() => office(workbook([{ name: 'B', body: `<sheetData>${row(1, [number('A1', 1)])}</sheetData>` }], { styles: '<styleSheet><oops></styleSheet>' })));
    out.entity = await thrown(() => office(workbook([{ name: 'B', body: `<sheetData>${row(1, [number('A1', 1)])}</sheetData>` }], { strings: [] , extra: { 'xl/sharedStrings.xml': '<!DOCTYPE sst [<!ENTITY a "aaaa">]><sst xmlns="x"><si><t>&a;</t></si></sst>' } })));
    out.noSheetPart = await thrown(() => office(zip({
      '_rels/.rels': rels(['officeDocument', 'xl/workbook.xml']),
      'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets><sheet name="Gone" sheetId="1" r:id="rId9"/></sheets></workbook>`,
    })));
    // More pages than the app makes: refused before any is drawn.
    let far = '';
    for (let k = 0; k <= 5000; k++) far += `<row r="${1 + 60 * k}"><c r="A${1 + 60 * k}"><v>${k}</v></c></row>`;
    const t0 = performance.now();
    out.tooMany = await thrown(() => office(workbook([{ name: 'Many', body: `<sheetData>${far}</sheetData>` }])));
    out.tooManyMs = performance.now() - t0;
    return out;
  });
  const o = r.odd.join(' ');
  check('odd: a shared formula without values shows moved to each cell', o.includes('=B1*2') && o.includes('=B2*2') && o.includes('=B3*2'), o.slice(0, 200));
  check('odd: cells put in order, a repeated column keeps its last cell', o.includes('again') && !o.includes('first') && o.indexOf('again') < o.indexOf('third'), o.slice(0, 300));
  // Only the letters of a long text that can show in its cell (and a few more) go into the PDF.
  check('odd: a long text cut off at its cell keeps only what shows', Math.max(...(o.match(/x+/g) ?? ['']).map((m) => m.length)) < 40, o.length);
  check('odd: rich text', o.includes('Rich plain'), o.slice(0, 300));
  check('odd: a value that isn\'t a number shows as text', o.includes('not a number') && o.includes('TRUE'), o.slice(-200));
  check('odd: strict workbook in the 1904 date system', r.strict.length === 1 && r.strict[0].includes('Strict') && r.strict[0].includes('1/1/1904'), r.strict);
  check('damaged: a sheet that isn\'t XML', r.badSheet?.key === 'office_convert_failed', r.badSheet);
  check('damaged: styles that aren\'t XML', r.badStyles?.key === 'office_convert_failed', r.badStyles);
  check('damaged: entities refused', r.entity?.key === 'office_convert_failed', r.entity);
  check('damaged: a sheet whose part is missing', r.noSheetPart?.key === 'office_no_sheets', r.noSheetPart);
  check('too large: more than 5,000 pages', r.tooMany?.key === 'office_too_large' && r.tooMany.manyKey === 'office_too_large_many', r.tooMany);
  check('too large: refused quickly', r.tooManyMs < 20000, r.tooManyMs);
}

async function large(page) {
  const r = await page.evaluate(async () => {
    const { workbook, text, number, row, convert, pageTexts } = window.X;
    // 20,000 rows of three cells: the page keeps answering while it converts.
    const rows = [];
    for (let n = 1; n <= 20000; n++) rows.push(row(n, [text(`A${n}`, `Item ${n}`), number(`B${n}`, n * 1.5), `<c r="C${n}"><f>B${n}*2</f><v>${n * 3}</v></c>`]));
    const bytes = workbook([{ name: 'Big', body: `<sheetData>${rows.join('')}</sheetData>` }]);
    // Frames keep coming (the progress dialog can paint) while it converts.
    let frames = 0;
    let longest = 0;
    let on = true;
    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      frames++;
      if (on) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const progress = [];
    const t0 = performance.now();
    const pdf = await convert(bytes, {}, { onProgress: (done) => progress.push(done) });
    const ms = performance.now() - t0;
    on = false;
    const pages = await pageTexts(pdf.bytes);
    return { ms, frames, longest, progress: progress.length, count: pdf.pageCount, size: pdf.bytes.length, last: pages[pages.length - 1].slice(-60), first: pages[0].slice(0, 60) };
  });
  check('large: 20,000 rows on many pages', r.count > 400, r);
  check('large: the last row prints', r.last.includes('Item 20000') && r.last.includes('30000') && r.last.includes('60000'), r.last);
  check('large: progress for every page', r.progress === r.count + 1, r);
  check('large: the page keeps painting', r.frames > 30 && r.longest < 2000, r);
  console.log(`  20,000 rows: ${r.count} pages in ${(r.ms / 1000).toFixed(1)} s, ${(r.size / 1024).toFixed(0)} KB, longest gap between frames ${r.longest.toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------------------------

await withPage(async (page, url) => {
  await setup(page, url);
  await deviceTests(page, 'chromium');
  await refusedAndCancelled(page, 'chromium');
  await printSetup(page);
  await cells(page);
  await alignment(page);
  await picturesAndHeaders(page);
  await gridlines(page);
  await oddFiles(page);
  await large(page);
});

for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await setup(page, url);
    await deviceTests(page, browser);
    await refusedAndCancelled(page, browser);
  }, { browser });
}

console.log(`xlsx: ${passed} checks passed`);
