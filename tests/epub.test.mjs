// Tests for EPUB to PDF (site/app/js/engine/office/epub*.js): the app's EpubFormatsTest, the
// forgiving XML reader, the XHTML reader, and books converted to PDFs and read back (text, page
// sizes and order, fonts, positions, pictures and their pixels, bookmarks, metadata), ported from
// the app's EpubConverterDeviceTest with books of our own: EPUB 2 and 3, covers, fixed layout,
// styles, tables, right to left, Japanese written down the page, DRM, damaged and hostile books.
import { withPage, assert } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}
const near = (a, b, tol = 1.5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;

/** Loads the modules and the book-making and PDF-reading helpers into the page as window.E. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const at = (p) => import(base + 'app/js/' + p);
    const E = { base };
    E.fmt = await at('engine/office/epub-formats.js');
    E.xml = await at('engine/office/epub-xml.js');
    E.book = await at('engine/office/epub-book.js');
    E.html = await at('engine/office/epub-html.js');
    E.epubMod = await at('engine/office/epub.js');
    E.office = await at('engine/office/office-formats.js');
    E.zipMod = await at('engine/office/zip.js');
    E.index = await at('engine/office/index.js');
    E.pdfjs = await at('lib/pdfjs.js');
    E.lib = await at('lib/pdf-lib.js');
    E.fflate = await at('lib/fflate.js');

    const enc = new TextEncoder();
    E.u8 = (s) => (typeof s === 'string' ? enc.encode(s) : s);
    E.XHTML11 = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

    /** A book: { path: text or bytes }, the mimetype first and stored, as EPUB asks. */
    E.epub = (files, { mimetype = true } = {}) => {
      const entries = {};
      if (mimetype) entries.mimetype = [E.u8('application/epub+zip'), { level: 0 }];
      for (const [k, v] of Object.entries(files)) entries[k] = [E.u8(v), { level: 6 }];
      return E.fflate.zipSync(entries);
    };
    E.container = (opf = 'OEBPS/content.opf') =>
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      `<rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    E.xhtml = (body, head = '', doctype = E.XHTML11) =>
      `<?xml version="1.0" encoding="utf-8"?>${doctype}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
      `<head><title>Part</title>${head}</head><body>${body}</body></html>`;
    /** A PNG `w` × `h` of `color` with a yellow circle, as the app's test pictures. */
    E.png = async (w, h, color = [70, 130, 180], type = 'image/png') => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `rgb(${color.join(',')})`;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(w * 0.6, h * 0.4, Math.min(w, h) * 0.25, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
      return new Uint8Array(await blob.arrayBuffer());
    };
    E.paragraphs = (count, word) => Array.from({ length: count }, (_, i) =>
      `<p>${word} paragraph ${i + 1} goes on for a while, so that the chapter needs more than one page of text to hold it all.</p>`).join('');

    /** An EPUB 2 book with an NCX table of contents, a style sheet and three chapters, listed out of order in the manifest. */
    E.epub2Files = (extraChapter3 = '') => {
      const link = '<link rel="stylesheet" type="text/css" href="../styles/book.css"/>';
      return {
        'META-INF/container.xml': E.container(),
        'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
          <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Quiet Orchard</dc:title>
          <dc:creator>A. Made-Up Writer</dc:creator><dc:language>en</dc:language><dc:identifier id="id">urn:uuid:0001</dc:identifier></metadata>
          <manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="css" href="styles/book.css" media-type="text/css"/>
          <item id="c3" href="text/chapter3.xhtml" media-type="application/xhtml+xml"/>
          <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="text/chapter%202.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
          </package>`,
        'OEBPS/styles/book.css': 'h1 { text-align: center } .secret { display: none } p.newpage { page-break-before: always } p { margin: 0 0 0.4em }',
        'OEBPS/text/chapter1.xhtml': E.xhtml(
          `<h1 id="start">Chapter One: Apples</h1>
          <p>The caf&eacute; opened at dawn&nbsp;&mdash; nobody came.</p>
          <p class="secret">This sentence is hidden.</p>
          <script type="text/javascript">var note = "script text";</script>
          <ul><li>First apple</li><li>Second apple</li></ul>
          <ol><li>Step one</li><li>Step two</li></ol>
          <blockquote><p>A quoted line.</p></blockquote>
          <h2 id="later">Later that day</h2>
          <p>Line one<br/>Line two, with <b>bold</b>, <i>italic</i> and <u>underlined</u> words.</p>
          <table><tr><th>Fruit</th><th>Count</th></tr><tr><td>Plums</td><td>12</td></tr></table>`, link),
        'OEBPS/text/chapter 2.xhtml': E.xhtml(`<h1>Chapter Two: Plums</h1>${E.paragraphs(40, 'Plum')}<h2 id="deep">Deep section</h2><p>The end of chapter two.</p>`, link),
        'OEBPS/text/chapter3.xhtml': E.xhtml(`<h1>Chapter Three: Pears</h1><p>Before the break.</p><p class="newpage">After a break.</p>${extraChapter3}`, link),
        'OEBPS/toc.ncx': `<?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
          <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>The Quiet Orchard</text></docTitle>
          <navMap>
          <navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/chapter1.xhtml"/>
            <navPoint id="n1b" playOrder="2"><navLabel><text>Later that day</text></navLabel><content src="text/chapter1.xhtml#later"/></navPoint>
          </navPoint>
          <navPoint id="n2" playOrder="3"><navLabel><text>Chapter Two</text></navLabel><content src="text/chapter%202.xhtml"/>
            <navPoint id="n2b" playOrder="4"><navLabel><text>Deep section</text></navLabel><content src="text/chapter%202.xhtml#deep"/></navPoint>
          </navPoint>
          <navPoint id="n3" playOrder="5"><navLabel><text>Chapter Three</text></navLabel><content src="text/chapter3.xhtml"/></navPoint>
          </navMap></ncx>`,
      };
    };
    E.epub2 = (extraChapter3 = '') => E.epub(E.epub2Files(extraChapter3));

    /** An EPUB 3 book with a navigation document, a cover image and a chapter with a picture. */
    E.epub3 = async (coverPage = true) => {
      let manifest = `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
        <item id="pic" href="images/garden.png" media-type="image/png"/>
        <item id="drawing" href="images/drawing.svg" media-type="image/svg+xml"/>
        <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>`;
      if (coverPage) manifest += '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>';
      const spine = (coverPage ? '<itemref idref="cover"/>' : '') + '<itemref idref="ch1"/>';
      const files = {
        'META-INF/container.xml': E.container('content.opf'),
        'content.opf': `<?xml version="1.0" encoding="UTF-8"?>
          <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A Small Garden</dc:title><dc:language>en</dc:language>
          <dc:identifier id="id">urn:uuid:0002</dc:identifier><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
          <manifest>${manifest}</manifest><spine>${spine}</spine></package>`,
        'nav.xhtml': E.xhtml(`<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
          <li><a href="cover.xhtml">Cover</a></li>
          <li><a href="ch1.xhtml">Hello garden</a><ol><li><a href="ch1.xhtml#beds">The beds</a></li></ol></li>
          </ol></nav>
          <nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="ch1.xhtml">Start here</a></li></ol></nav>`, '', '<!DOCTYPE html>'),
        'images/cover.png': await E.png(600, 900, [120, 60, 140]),
        'images/garden.png': await E.png(320, 200),
        'images/drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        'ch1.xhtml': E.xhtml(`<section epub:type="chapter"><h1>Hello garden</h1><p>Some words before the picture.</p>
          <div class="figure"><img src="images/garden.png" alt="A garden"/></div>
          <p>Words after it, and a drawing Android can't show: <img src="images/drawing.svg" alt="A tiny drawing"/></p>
          <h2 id="beds">The beds</h2><p>Carrots and beans.</p></section>`, '', '<!DOCTYPE html>'),
      };
      if (coverPage) {
        files['cover.xhtml'] = E.xhtml(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" viewBox="0 0 600 900" width="100%" height="100%">
          <image width="600" height="900" xlink:href="images/cover.png"/></svg>`, '', '<!DOCTYPE html>');
      }
      return E.epub(files);
    };

    /**
     * An EPUB 3 book of one chapter, `body` with `css`, and `files` beside it; its navigation document
     * lists `toc` ([title, href] pairs). Every name in the zip starts with `root`.
     */
    E.oneChapterFiles = (body, { css = '', files = {}, toc = [['Chapter', 'ch.xhtml']], root = '', head = '', opfMeta = '', title = 'One chapter' } = {}) => {
      const all = {
        'META-INF/container.xml': E.container('book.opf'),
        'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:identifier id="id">x</dc:identifier>${opfMeta}</metadata>
          <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`,
        'nav.xhtml': E.xhtml(`<nav epub:type="toc"><ol>${toc.map(([t, h]) => `<li><a href="${h}">${t}</a></li>`).join('')}</ol></nav>`, '', '<!DOCTYPE html>'),
        'ch.xhtml': E.xhtml(body, (css ? `<style>${css}</style>` : '') + head, '<!DOCTYPE html>'),
        ...files,
      };
      return Object.fromEntries(Object.entries(all).map(([k, v]) => [root + k, v]));
    };
    E.oneChapter = (body, opts) => E.epub(E.oneChapterFiles(body, opts));

    /** Converts a book as the app does (checked, then converted): { name, bytes, pageCount }, or { error } with the message key. */
    E.convert = async (bytes, options = {}, hooks = {}) => {
      try {
        return await E.index.convertOffice('epub', { name: options.file ?? 'book.epub', bytes }, options, hooks);
      } catch (e) {
        return { error: e?.key ?? e?.name ?? String(e), name: e?.name, cause: String(e?.cause?.stack ?? e?.cause ?? e?.stack ?? '') };
      }
    };
    E.thrown = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return { name: e?.name, key: e?.key ?? null, manyKey: e?.manyKey ?? null, problem: e?.problem ?? null, message: String(e?.message ?? e) };
      }
    };

    /** Text items of a page: { str, x, y (from the top), size, width, font (its PDF name) }, and the page's text. */
    const join = (items) => {
      let s = '';
      let prev = null;
      for (const it of items) {
        if (!it.str) {
          if (it.eol) s += ' ';
          continue;
        }
        if (prev) {
          const sameLine = Math.abs(it.y - prev.y) < Math.max(2, prev.size * 0.3);
          const gap = it.x - (prev.x + prev.width);
          if (!sameLine || gap > prev.size * 0.12 || gap < -prev.size) s += ' ';
        }
        s += it.str;
        if (it.eol) s += ' ';
        prev = it;
      }
      return s.replace(/\s+/g, ' ').trim();
    };
    // pdf.js with the fonts' own names kept, to tell bold and italic type apart.
    const vendor = base + 'app/vendor/pdfjs/';
    E.openNamed = (bytes) => E.pdfjs.pdfjsLib.getDocument({
      data: bytes.slice(), cMapUrl: vendor + 'cmaps/', cMapPacked: true, standardFontDataUrl: vendor + 'standard_fonts/', wasmUrl: vendor + 'wasm/',
      iccUrl: vendor + 'iccs/', useWorkerFetch: true, isEvalSupported: false, fontExtraProperties: true,
    }).promise;
    E.pages = async (bytes) => {
      const pdf = await E.openNamed(bytes);
      const out = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n);
        const vp = p.getViewport({ scale: 1 });
        const tc = await p.getTextContent();
        await p.getOperatorList();
        const items = tc.items.filter((i) => i.str !== undefined).map((i) => {
          const [, , c, d, e, f] = i.transform;
          let font = null;
          try {
            font = p.commonObjs.get(i.fontName)?.name ?? null;
          } catch {
            font = null;
          }
          return { str: i.str, x: e, y: vp.height - f, size: Math.hypot(c, d), width: i.width, font, eol: i.hasEOL };
        });
        out.push({ width: vp.width, height: vp.height, items, text: join(items) });
      }
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return out;
    };
    /** The first item with `word` on page `p` (from E.pages), its x moved to where the word starts. */
    E.word = (p, word) => {
      const it = p.items.find((i) => i.str.includes(word));
      if (!it) return null;
      const at = it.str.indexOf(word);
      return { ...it, x: it.x + (it.str.length ? (it.width * at) / it.str.length : 0) };
    };
    /** The left and right ends of each line of text on page `p`, top to bottom. */
    E.lineEnds = (p) => {
      const glyphs = p.items.filter((i) => i.str.trim()).sort((a, b) => a.y - b.y);
      const lines = [];
      for (const g of glyphs) {
        const line = lines.length && Math.abs(lines[lines.length - 1][0].y - g.y) < 3 ? lines[lines.length - 1] : (lines.push([]), lines[lines.length - 1]);
        line.push(g);
      }
      return lines.map((l) => [Math.min(...l.map((g) => g.x)), Math.max(...l.map((g) => g.x + g.width))]);
    };
    /** The pictures drawn on page n: [{ x0, y0, x1, y1 }] in PDF points from the bottom-left, and the kind of drawing. */
    E.imagesOn = async (bytes, n) => {
      const { OPS } = E.pdfjs.pdfjsLib;
      const pdf = await E.pdfjs.openPdfJs(bytes);
      const p = await pdf.getPage(n);
      const ops = await p.getOperatorList();
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      let m = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
      const out = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push(m);
        else if (fn === OPS.restore) m = stack.pop() ?? m;
        else if (fn === OPS.transform) m = mul(m, args);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(m);
          if (args?.[0]) m = mul(m, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() ?? m;
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
          const pt = (u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
          const [x0, y0] = pt(0, 0);
          const [x1, y1] = pt(1, 1);
          out.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), mask: fn === OPS.paintImageMaskXObject });
        }
      }
      return out.filter((r) => !r.mask);
    };
    /** Bookmarks: [{ title, page (0-based), top, items }]. */
    E.outline = async (bytes) => {
      const pdf = await E.pdfjs.openPdfJs(bytes);
      const walk = async (items) => {
        const out = [];
        for (const it of items ?? []) {
          let page = null;
          let top = null;
          let dest = it.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest)) {
            page = await pdf.getPageIndex(dest[0]);
            top = dest[3];
          }
          out.push({ title: it.title, page, top, items: await walk(it.items) });
        }
        return out;
      };
      const outline = await walk(await pdf.getOutline());
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return outline;
    };
    E.info = async (bytes) => {
      const pdf = await E.pdfjs.openPdfJs(bytes);
      const { info } = await pdf.getMetadata();
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      const doc = await E.lib.PDFDocument.load(bytes, { updateMetadata: false });
      const lang = doc.catalog.lookup(E.lib.PDFName.of('Lang'));
      return { title: info.Title ?? null, author: info.Author ?? null, language: lang ? lang.decodeText() : null, producer: info.Producer ?? null };
    };
    E.sizes = async (bytes) => {
      const doc = await E.lib.PDFDocument.load(bytes, { updateMetadata: false });
      return doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    };
    /** The image XObjects of a PDF: [{ width, height, filter }]. */
    E.imageObjects = async (bytes) => {
      const doc = await E.lib.PDFDocument.load(bytes, { updateMetadata: false });
      const out = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        const dict = obj?.dict;
        if (!dict || dict.get(E.lib.PDFName.of('Subtype'))?.toString() !== '/Image') continue;
        if (dict.get(E.lib.PDFName.of('ImageMask'))?.toString() === 'true') continue;
        out.push({ width: dict.get(E.lib.PDFName.of('Width'))?.asNumber(), height: dict.get(E.lib.PDFName.of('Height'))?.asNumber(), filter: dict.get(E.lib.PDFName.of('Filter'))?.toString() ?? null });
      }
      return out;
    };
    /** Renders page n; px(x, y) gives [r, g, b] at (x, y) points from the top-left. */
    E.render = async (bytes, n = 1, scale = 2) => {
      const pdf = await E.pdfjs.openPdfJs(bytes);
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
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      const px = (x, y) => {
        const i = (Math.min(canvas.height - 1, Math.round(y * scale)) * canvas.width + Math.min(canvas.width - 1, Math.round(x * scale))) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      return { px, width: vp.width, height: vp.height };
    };
    E.near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

    /** What an XHTML document's `body`, styled with `css`, is read into (pictures it has can't be drawn). */
    E.readEntries = async (body, css = '', { head = '', sheets = {}, sizes = {}, base = 11, width = 332 } = {}) => {
      const entries = [];
      const sheetOf = async (p) => (sheets[p] != null ? E.fmt.SimpleCss.parse(sheets[p]) : null);
      const sizeOf = async (p) => sizes[p] ?? null;
      const reader = new E.html.XhtmlReader('ch.xhtml', base, width, sheetOf, sizeOf, null, () => {}, async (e) => { entries.push(e); });
      await reader.read(E.u8(E.xhtml(body, (css ? `<style>${css}</style>` : '') + head)));
      return entries;
    };
    E.plain = (entries) => entries.map((e) => {
      const it = e.item;
      const kind = it instanceof E.html.BookPara ? 'para' : it instanceof E.html.BookImage ? 'image' : it instanceof E.html.BookTable ? 'table' : it instanceof E.html.BookRule ? 'rule' : 'break';
      return {
        kind, before: e.before, ids: e.ids, text: kind === 'para' ? it.text.text : null, size: kind === 'para' ? it.base.size : null,
        bold: kind === 'para' ? it.base.bold : null, italic: kind === 'para' ? it.base.italic : null, label: kind === 'para' ? it.label?.[0] ?? null : null,
        heading: kind === 'para' ? it.heading : null, style: it.style ? { ...it.style } : null, font: kind === 'para' ? it.base.family : null,
        runs: kind === 'para' ? it.text.runs.map((r) => ({ text: it.text.text.slice(r.start, r.end), bold: r.style.bold, italic: r.style.italic, underline: r.style.underline, strike: r.style.strike, baseline: r.style.baseline, family: r.style.family, size: r.style.size, obj: !!r.obj })) : null,
        rows: kind === 'table' ? it.rows.map((r) => r.map((c) => ({ span: c.span, rowSpan: c.rowSpan, header: c.header, text: c.items.map((x) => x.item.text?.text ?? '').join('|') }))) : null,
        path: kind === 'image' ? it.path : null, width: kind === 'image' ? it.width : null, height: kind === 'image' ? it.height : null, share: kind === 'image' ? it.share : null,
      };
    });
    window.E = E;
  }, url);
}

// ---------------------------------------------------------------------------------------------
// EpubFormatsTest, ported

async function formats(page) {
  const r = await page.evaluate(() => {
    const { HtmlEntities, EpubPaths, EpubProtection, XmlPrefix, HtmlText, SimpleCss, CssSheet, CssNode, CssValues } = window.E.fmt;
    const { ListNumbering } = window.E.office;
    const F = ListNumbering.Format;
    const out = {};
    const e = HtmlEntities.all;
    out.entities = [e.get('nbsp'), e.get('eacute'), e.get('yuml'), e.get('times'), e.get('Omega'), e.get('sigmaf'), e.get('omega'), e.get('mdash'), e.get('hellip'), e.get('euro'), e.get('diams'), e.size];
    out.paths = [
      EpubPaths.resolve('OEBPS/text/ch1.xhtml', 'ch2.xhtml'), EpubPaths.resolve('OEBPS/text/ch1.xhtml', '../images/cover.jpg'),
      EpubPaths.resolve('OEBPS/text/ch1.xhtml', 'ch2.xhtml#sec%201'), EpubPaths.resolve('OEBPS/text/ch1.xhtml', '#note3'),
      EpubPaths.resolve('content.opf', 'text/My%20Chapter.xhtml'), EpubPaths.resolve('OEBPS/x.xhtml', '/images/a.png'),
      EpubPaths.resolve('a.opf', 'C++.xhtml'), EpubPaths.resolve('a.opf', '%C3%A9.xhtml'),
      EpubPaths.resolve('a.xhtml', 'https://example.com/'), EpubPaths.resolve('a.xhtml', 'mailto:someone@example.com'), EpubPaths.resolve('a.xhtml', '  '),
      EpubPaths.resolve('a/b/c.xhtml', '../../../../x.xhtml?query=1#'), EpubPaths.resolve('a.xhtml', 'data:image/png;base64,AAAA'),
    ];
    out.drm = [
      EpubProtection.isProtected(false, []),
      EpubProtection.isProtected(false, ['http://www.idpf.org/2008/embedding', ' http://ns.adobe.com/pdf/enc#RC ']),
      EpubProtection.isProtected(false, ['http://www.idpf.org/2008/embedding', 'http://www.w3.org/2001/04/xmlenc#aes128-cbc']),
      EpubProtection.isProtected(true, []),
    ];
    const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const cs = (s) => { const b = latin1(s); return XmlPrefix.charset(b, b.length); };
    out.charsets = [
      cs('<html/>'), cs('<?xml version="1.0" encoding="ISO-8859-1"?><html/>'), cs("<?xml version='1.0' encoding='no-such-charset'?><html/>"),
      XmlPrefix.charset(new Uint8Array([0xff, 0xfe, 0x3c, 0]), 4), XmlPrefix.charset(new Uint8Array([0, 0x3c, 0, 0x3f]), 4),
      XmlPrefix.charset(new Uint8Array([0xfe, 0xff, 0, 0x3c]), 4), XmlPrefix.charset(new Uint8Array([0x3c, 0, 0x3f, 0]), 4),
      cs('ï»¿<?xml version="1.0" encoding="Shift_JIS"?><html/>'),
    ];
    const xhtml = `<?xml version="1.0"?>
      <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
      <html><body/></html>`;
    const stripped = XmlPrefix.stripDoctype(xhtml);
    out.doctype = [
      !stripped.includes('DOCTYPE'), stripped.trimEnd().endsWith('<html><body/></html>'),
      XmlPrefix.stripDoctype('<!DOCTYPE html [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><html>&b;</html>'),
      XmlPrefix.stripDoctype('<!doctype html SYSTEM "a>b"><html/>'),
      XmlPrefix.stripDoctype('<!-- note --><html/>'),
      XmlPrefix.stripDoctype('<!DOCTYPE html [<!ENTITY a "x"> '),
      XmlPrefix.stripDoctype('<?xml version="1.0"?><!-- a long comment'),
      XmlPrefix.stripDoctype('just text, no element'),
      XmlPrefix.stripDoctype('<_root/>'),
    ];
    out.collapse = [
      HtmlText.collapse('one \n two\t\tthree  ', false), HtmlText.collapse('   word', true), HtmlText.collapse('   word', false),
      HtmlText.collapse('a  b', false), HtmlText.collapse(' \n ', true),
    ];
    out.wide = [
      HtmlText.collapse('引取り手の\nない死人を、\r\n  この門へ', false), HtmlText.collapse('鴉 は', false), HtmlText.collapse('日本\nJapan', false),
      HtmlText.collapse('한국어\n문장', false), HtmlText.collapse('\nを待って', false, 'み'.codePointAt(0)), HtmlText.collapse('\nJapan', false, 'み'.codePointAt(0)),
      HtmlText.endsInWideBreak('雨やみ\n', 0), HtmlText.endsInWideBreak(' \n ', 'み'.codePointAt(0)), HtmlText.endsInWideBreak('Japan\n', 'み'.codePointAt(0)),
      HtmlText.endsInWideBreak('雨やみ ', 0),
      HtmlText.isWide('ー'.codePointAt(0)), HtmlText.isWide('。'.codePointAt(0)), HtmlText.isWide('Ａ'.codePointAt(0)), HtmlText.isWide('ｶ'.codePointAt(0)),
      HtmlText.isWide('ﾡ'.codePointAt(0)), HtmlText.isWide('𠀋'.codePointAt(0)), HtmlText.isWide('ㄅ'.codePointAt(0)), HtmlText.isWide('a'.codePointAt(0)),
      HtmlText.collapse('𠀋\n𠀋', false),
    ];
    out.viewport = [HtmlText.viewport('width=1200, height=800'), HtmlText.viewport('height=900;width=600.5'), HtmlText.viewport('width=device-width, initial-scale=1'), HtmlText.viewport(null), HtmlText.viewport('width=0, height=10')];
    out.lists = [HtmlText.listFormat('lower-roman', true), HtmlText.listFormat('A', true), HtmlText.listFormat(null, true), HtmlText.listFormat(null, false), HtmlText.listFormat('none', true), HtmlText.listFormat('lower-greek', true), HtmlText.listFormat(' square ', true)];
    out.listNames = [F.LOWER_ROMAN, F.UPPER_LETTER, F.DECIMAL, F.BULLET, null, F.DECIMAL, F.BULLET];
    const widths = HtmlText.columnWidths([10, 30], 400);
    const skewed = HtmlText.columnWidths([1, 1, 5000], 300);
    out.columns = [widths[0] + widths[1], widths[1] > widths[0], skewed[0] >= (300 / 3) * 0.5 * 0.9, skewed.reduce((a, b) => a + b, 0), HtmlText.columnWidths([], 100).length];

    const node = (tag, classes = '', id = null, parent = null) => new CssNode(tag, id, new Set(classes.split(' ').filter((c) => c)), parent);
    const body = node('body');
    const chapter = node('div', 'chapter', null, body);
    const heading = node('h1', 'title', 'c1', chapter);
    const para = node('p', 'first', null, node('blockquote', '', null, chapter));
    const sel = (s) => SimpleCss.selector(s);
    out.selectors = [
      sel('h1').matches(heading), sel('h1.title').matches(heading), sel('#c1').matches(heading), sel('.chapter h1').matches(heading),
      sel('div > h1').matches(heading), sel('div p.first').matches(para), !sel('div > p').matches(para), !sel('h2').matches(heading),
      !sel('h1.other').matches(heading), sel('*').matches(para), sel(':root').matches(node('html')), !sel(':root').matches(body),
      sel('p:first-child') === null, sel('a[href]') === null, sel('h1 + p') === null, sel('div.chapter #c1').specificity,
      sel('> p') === null, sel('div >') === null, sel('div > > p') === null, sel('DIV.Chapter').parts[0].tag, sel('body   div  >  h1').matches(heading),
    ];

    const sheet = SimpleCss.parse(`/* comment { p { color: red } */
      @import url(other.css);
      @font-face { font-family: X; src: url(x.ttf) }
      @media print { p { text-align: right } }
      p { text-align: justify; text-indent: 1.5em; margin: 0 }
      p.center, .title { text-align: center !important }
      p:first-child { text-indent: 0 }
      #intro { font-style: italic }`);
    const p = node('p', 'center', 'intro', node('body'));
    const result = CssSheet.cascade(p, [sheet], 'font-weight: bold');
    const plain = CssSheet.cascade(node('p'), [sheet], null);
    const later = SimpleCss.parse('p { text-align: left }');
    out.cascade = [result['text-align'], result['text-indent'], result['font-style'], result['font-weight'], result['margin-top'], result['margin-left'],
      plain['text-align'], CssSheet.cascade(node('p'), [sheet, later], null)['text-align'], SimpleCss.parse('garbage { without end').isEmpty,
      SimpleCss.parse('p { __proto__: x; constructor: y }').isEmpty, CssSheet.cascade(node('p'), [SimpleCss.parse('p { __proto__: x; constructor: y }')], null).__proto__];

    const sheet2 = SimpleCss.parse(`h2 { margin-top: 3em; page-break-before: always }
      .title h2 { margin: 0 1em 2em; break-before: auto }
      ul { list-style-type: square }
      ul.plain { list-style: none inside }
      p { margin-left: 2em }`);
    const title = node('h2', '', null, node('div', 'title'));
    const r2 = CssSheet.cascade(title, [sheet2], null);
    out.shorthands = [r2['margin-top'], r2['margin-left'], r2['margin-right'], r2['margin-bottom'], r2['break-before'],
      CssSheet.cascade(node('h2'), [sheet2], null)['break-before'], CssSheet.cascade(node('ul', 'plain'), [sheet2], null)['list-style-type'],
      CssSheet.cascade(node('p'), [sheet2], 'margin: 0')['margin-left'],
      SimpleCss.declarations('margin: 1em; margin-top: 5px')['margin-top'], SimpleCss.declarations('margin: 1em; margin-top: 5px')['margin-bottom']];

    const t0 = performance.now();
    const crafted = [
      CssValues.length('1'.repeat(200000) + 'x', 11, 11), window.E.office.OfficeUnits.cssLength('1'.repeat(200000) + 'x'),
      SimpleCss.parse('/*a'.repeat(100000) + ' p { color: red }').isEmpty,
    ];
    const sheet3 = SimpleCss.parse('div' + ' '.repeat(200000) + '> p { color: red } /* a note */ em { color: blue }');
    crafted.push(CssSheet.cascade(new CssNode('p', null, new Set(), new CssNode('div', null, new Set(), null)), [sheet3], null).color);
    crafted.push(CssSheet.cascade(new CssNode('em', null, new Set(), null), [sheet3], null).color);
    // A million nested elements and a descendant selector: looked up only so far.
    let deep = new CssNode('html', null, new Set(), null);
    for (let i = 0; i < 200000; i++) deep = new CssNode('div', null, new Set(), deep);
    const sheet4 = SimpleCss.parse('section div { color: red }');
    let found = 0;
    for (let i = 0; i < 200; i++) if (sheet4.matching(deep).length) found++;
    crafted.push(found);
    crafted.push(performance.now() - t0);
    out.crafted = crafted;

    const base = 11;
    const rem = CssValues.rootSize('62.5%', base);
    out.lengths = [
      CssValues.length('2em', 11, base), CssValues.length('16px', 11, base), CssValues.length('12pt', 11, base), CssValues.length('10%', 11, base, 300),
      CssValues.length('10%', 11, base), CssValues.length('0', 11, base), CssValues.length('auto', 11, base), CssValues.fontSize('200%', 11, base),
      CssValues.fontSize('x-large', 20, base), CssValues.fontSize('100px', 11, base), CssValues.fontSize('1.6rem', 20, base, rem),
      CssValues.bold('700'), CssValues.bold('normal'), CssValues.bold('inherit'), CssValues.verticalMargins('1em 0 2em'), CssValues.horizontalMargins('0 1em 0 3em'),
      CssValues.fontFamily('"Libre Baskerville", serif'), CssValues.fontFamily('MyFont, sans-serif'), CssValues.fontFamily("'Courier New'"), CssValues.fontFamily('MyFont'),
      CssValues.pageBreak('always'), CssValues.pageBreak('page'), CssValues.pageBreak('avoid'),
      CssValues.length('1in', 11, 12), CssValues.length('-0.5em', 10, 11), CssValues.length('.5em', 10, 11), CssValues.length('3', 10, 11), CssValues.length('-0', 10, 11),
      CssValues.fontSize('smaller', 20, 11), CssValues.fontSize('1px', 11, 11), CssValues.rootSize('10px', 11), CssValues.verticalMargins(''), CssValues.horizontalMargins('1em 2em 3em'),
    ];

    const sheetV = SimpleCss.parse('html { -epub-writing-mode: vertical-rl } .main_text { margin-left: 12em } h2 { margin: 2em 3em 0 1em }');
    const mode = CssValues.writingMode(CssSheet.cascade(new CssNode('html', null, new Set(), null), [sheetV], null));
    const h2 = CssValues.acrossFromVertical(CssSheet.cascade(new CssNode('h2', null, new Set(), null), [sheetV], null), mode);
    out.vertical = [mode, { ...CssValues.acrossFromVertical({ 'margin-left': '12em' }, mode) }, { ...h2 }, { ...CssValues.acrossFromVertical({ 'margin-left': '12em' }, 'horizontal-tb') },
      { ...CssValues.acrossFromVertical({ 'margin-right': '1em', 'margin-top': '2em' }, 'vertical-lr') }];
    return out;
  });
  const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
  eq('HTML entities', r.entities, [' ', 'é', 'ÿ', '×', 'Ω', 'ς', 'ω', '—', '…', '€', '♦', 253]);
  eq('links inside the book', r.paths, [
    ['OEBPS/text/ch2.xhtml', null], ['OEBPS/images/cover.jpg', null], ['OEBPS/text/ch2.xhtml', 'sec 1'], ['OEBPS/text/ch1.xhtml', 'note3'],
    ['text/My Chapter.xhtml', null], ['images/a.png', null], ['C++.xhtml', null], ['é.xhtml', null], null, null, null, ['x.xhtml', null], null,
  ]);
  eq('font obfuscation is not DRM', r.drm, [false, false, true, true]);
  eq('character sets', r.charsets, ['UTF-8', 'ISO-8859-1', 'UTF-8', 'UTF-16LE', 'UTF-16BE', 'UTF-16BE', 'UTF-16LE', 'Shift_JIS']);
  eq('DOCTYPEs dropped, unfinished ones refused', r.doctype, [true, true, '<html>&b;</html>', '<html/>', '<!-- note --><html/>', null, null, null, '<_root/>']);
  eq('white space collapses as in HTML', r.collapse, ['one two three ', 'word', ' word', 'a  b', '']);
  eq('line breaks between Chinese or Japanese characters', r.wide, [
    '引取り手のない死人を、この門へ', '鴉 は', '日本 Japan', '한국어 문장', 'を待って', ' Japan', true, true, false, false,
    true, true, true, true, false, true, true, false, '𠀋𠀋',
  ]);
  eq('viewports', r.viewport, [[1200, 800], [600, 900], null, null, null]);
  eq('list styles', r.lists, r.listNames);
  check('columns share the width', near(r.columns[0], 400, 0.01) && r.columns[1] && r.columns[2] && near(r.columns[3], 300, 0.01) && r.columns[4] === 0, r.columns);
  eq('simple selectors', r.selectors, [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, 111, true, true, true, 'div', true]);
  eq('style sheets and style attributes cascade', r.cascade, ['center', '1.5em', 'italic', 'bold', '0', '0', 'justify', 'left', true, false, 'x']);
  eq('shorthands and their parts cascade together', r.shorthands, ['0', '1em', '1em', '2em', 'auto', 'always', 'none', '0', '5px', '1em']);
  check('crafted style sheets are read quickly', r.crafted[0] === null && r.crafted[1] === null && r.crafted[2] === true && r.crafted[3] === 'red' && r.crafted[4] === 'blue' && r.crafted[5] === 0 && r.crafted[6] < 10000, r.crafted);
  const L = r.lengths;
  const nums = [22, 11, 11, 30, null, 0, null, 22, 16.5, 33, 11];
  check('CSS lengths', nums.every((v, i) => (v === null ? L[i] === null : near(L[i], v, 0.001))), L.slice(0, 11));
  eq('CSS weights, margins, families, breaks', L.slice(11, 23), [true, false, null, ['1em', '2em'], ['3em', '1em'], 'serif', 'sans-serif', 'monospace', null, true, true, false]);
  check('more CSS lengths', near(L[23], 72, 0.001) && near(L[24], -5, 0.001) && near(L[25], 5, 0.001) && L[26] === null && L[27] === 0 &&
    near(L[28], 16.6, 0.001) && near(L[29], 6.6, 0.001) && near(L[30], 6.875, 0.001) && L[31] === null && JSON.stringify(L[32]) === '["2em","2em"]', L.slice(23));
  eq('margins of books written down the page', r.vertical, ['vertical-rl', { 'margin-bottom': '12em' },
    { 'margin-left': '2em', 'margin-right': '0', 'margin-top': '3em', 'margin-bottom': '1em' }, { 'margin-left': '12em' }, { 'margin-left': '2em', 'margin-bottom': '1em' }]);
}

// ---------------------------------------------------------------------------------------------
// The forgiving XML reader

async function lenientXml(page) {
  const r = await page.evaluate(() => {
    const { LenientXml, START_TAG, END_TAG, TEXT, END_DOCUMENT, lenientXml: open, decodeReferences } = window.E.xml;
    const u8 = window.E.u8;
    const events = (bytes, limit = 100000) => {
      const p = new LenientXml(bytes);
      const out = [];
      try {
        for (let i = 0; i < limit; i++) {
          const t = p.next();
          if (t === END_DOCUMENT) break;
          if (t === START_TAG) out.push(`<${p.name}${p.attrs.map(([n, v]) => ` ${n}=${v}`).join('')}@${p.depth}`);
          else if (t === END_TAG) out.push(`</${p.name}@${p.depth}`);
          else if (t === TEXT) out.push(`"${p.text}"`);
        }
      } catch (e) {
        out.push(`!${e.name}`);
      }
      return out.join(' ');
    };
    const out = {};
    out.basic = events(u8('<?xml version="1.0"?><!DOCTYPE html><html><body><p class="a b">Caf&eacute; &amp; <b>bold</b>&#x263A;&#65;</p></body></html>'));
    out.relaxed = events(u8('<html><p hidden id=x data-a = \'q"r\' >Tom & Jerry &unknown; &#0; 3 < 4</p><br><img src="a.png"/></html>'));
    out.mismatched = events(u8('<html><body><p>Unclosed <b>bold<br> text</body></html>'));
    out.coalesced = events(u8('<r>one<!-- c -->two<![CDATA[<three>&amp;]]><?pi x?>four</r>'));
    out.strayEnd = events(u8('<r></x></r></r><after/>'));
    out.namespaces = (() => {
      const p = new LenientXml(u8('<dc:title xlink:href="h" href="g" epub:type="toc chapter">T</dc:title>'));
      p.next();
      return [p.name, p.localName(), p.attr('href'), p.attr('type'), p.attr('missing')];
    })();
    out.broken = [events(u8('<r><p>text <b')), events(u8('<r>before<!-- never ends')), events(u8('<r a="unterminated>')), events(u8('<r><![CDATA[x'))];
    out.refused = [open(u8('')), open(u8('plain text')), open(u8('<!DOCTYPE html [<!ENTITY a "x">')), open(u8('<!--' + ' '.repeat(9000) + '--><r/>'))].map((p) => p === null);
    // Encodings: UTF-16 with and without a byte order mark, Latin-1 declared.
    const utf16 = (s, le, bom) => {
      const b = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
      let o = 0;
      if (bom) { b[0] = le ? 0xff : 0xfe; b[1] = le ? 0xfe : 0xff; o = 2; }
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[o + 2 * i + (le ? 0 : 1)] = c & 255; b[o + 2 * i + (le ? 1 : 0)] = c >> 8; }
      return b;
    };
    out.encodings = [
      events(utf16('<r>héllo 日本</r>', true, true)), events(utf16('<r>héllo</r>', false, false)), events(utf16('<?xml version="1.0"?><r>x</r>', true, false)),
      events(Uint8Array.from('<?xml version="1.0" encoding="ISO-8859-1"?><r>café</r>', (c) => c.charCodeAt(0))),
      events(new Uint8Array([0xef, 0xbb, 0xbf, ...u8('<r>bom</r>')])),
    ];
    // Text across the reader's megabyte chunks: references, characters of several bytes and line breaks kept whole.
    const unit = 'a&amp;b 日本語 &eacute;\r\n';
    const long = '<r>' + unit.repeat(120000) + '</r>';
    const p = new LenientXml(u8(long));
    let text = '';
    let parts = 0;
    for (;;) {
      const t = p.next();
      if (t === END_DOCUMENT) break;
      if (t === TEXT) { text += p.text; parts++; }
    }
    out.chunks = [text === 'a&b 日本語 é\r\n'.repeat(120000), parts > 1, parts];
    // A tag a megabyte long ends the document; what came before is read.
    out.longTag = events(u8('<r>kept<p ' + 'a="1" '.repeat(300000) + '>lost</p></r>'));
    out.references = [decodeReferences('&lt;&gt;&quot;&apos;&nbsp;&#128512;&#xD800;&#99999999999;&AMP;&'), decodeReferences('no refs')];
    return out;
  });
  check('XML events', r.basic === '<html@1 <body@2 <p class=a b@3 "Café & " <b@4 "bold" </b@4 "☺A" </p@3 </body@2 </html@1', r.basic);
  check('relaxed attributes, stray ampersands and unknown names', r.relaxed ===
    '<html@1 <p hidden=hidden id=x data-a=q"r@2 "Tom & Jerry &unknown; � 3 < 4" </p@2 <br@2 <img src=a.png@3 </img@3 </html@2', r.relaxed);
  check('mismatched and unclosed tags', r.mismatched === '<html@1 <body@2 <p@3 "Unclosed " <b@4 "bold" <br@5 " text" </body@5 </html@4', r.mismatched);
  check('text coalesced across comments, CDATA and instructions', r.coalesced === '<r@1 "onetwo<three>&amp;four" </r@1', r.coalesced);
  check('end tags with nothing open are left out', r.strayEnd === '<r@1 </x@1 <after@1 </after@1', r.strayEnd);
  check('local names and attributes by local name', JSON.stringify(r.namespaces) === '["dc:title","title","h","toc chapter",null]', r.namespaces);
  check('files ending inside markup stop the reading', r.broken[0] === '<r@1 <p@2 "text " !XmlReadError' && r.broken[1] === '<r@1 !XmlReadError' &&
    r.broken[2] === '!XmlReadError' && r.broken[3] === '<r@1 !XmlReadError', r.broken);
  check('no root element near the start is refused', r.refused.every((x) => x), r.refused);
  check('encodings', JSON.stringify(r.encodings) === JSON.stringify(['<r@1 "héllo 日本" </r@1', '<r@1 "héllo" </r@1', '<r@1 "x" </r@1', '<r@1 "café" </r@1', '<r@1 "bom" </r@1']), r.encodings);
  check('text across chunks', r.chunks[0] && r.chunks[1], r.chunks);
  check('a tag a megabyte long ends the document', r.longTag === '<r@1 "kept" !XmlReadError', r.longTag);
  check('references', r.references[0] === '<>"\' 😀��&AMP;&' && r.references[1] === 'no refs', r.references);
}

// ---------------------------------------------------------------------------------------------
// The XHTML reader (EpubConverterDeviceTest's reader checks, and more)

async function reader(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    // Lines split with line breaks, and a long preformatted text, as books made from plain text are.
    const huge = await E.readEntries('<p>' + 'word word word<br/>\n'.repeat(3000) + '</p><pre>' + 'code line\n'.repeat(6000) + '</pre>');
    out.huge = E.plain(huge).map((e) => e.text.length);
    out.hugeKept = E.plain(huge).filter((e) => e.text.includes('code line\ncode line')).length > 0 && E.plain(huge)[0].text.startsWith('word word word\nword');
    // A page that can't be made stops the book, rather than passing for a damaged chapter.
    const failing = new E.html.XhtmlReader('ch.xhtml', 11, 332, null, null, null, () => {}, async () => { throw new Error('No space left'); });
    out.sinkFailure = await E.thrown(() => failing.read(E.u8(E.xhtml('<p>a</p><p>b</p>'))));
    // Japanese lines split with line breaks past 12,000 characters: read on after the split (the app stops there).
    const jp = E.plain(await E.readEntries('<p>' + '山路を登りながら<br/>\n'.repeat(1500) + '</p><p>終わり</p>'));
    out.jpSplit = [jp.length, jp.reduce((n, e) => n + (e.text.match(/山路/g)?.length ?? 0), 0), jp[jp.length - 1].text];
    out.rems = E.plain(await E.readEntries('<p>Words</p>', 'html { font-size: 62.5% } body { font-size: 1.6rem }'));
    out.vertical = E.plain(await E.readEntries('<div class="main"><p>山路を登りながら</p></div><p>After</p>', '', {
      head: '<link rel="alternate stylesheet" href="horizontal.css"/><link rel="stylesheet" href="vertical.css"/>',
      sheets: { 'vertical.css': 'html { -epub-writing-mode: vertical-rl } p { margin: 0 } .main { margin-left: 2em }', 'horizontal.css': '.main p { display: none }' },
    }));
    out.japanese = E.plain(await E.readEntries('<p>門の下で<em>雨やみ</em>\nを待って<span>い\n</span>\n<a>た</a>\nJapan</p>')).map((e) => e.text);
    out.lists = E.plain(await E.readEntries('<p>Before</p><ul><li>Item<ul><li>Inner</li></ul></li></ul><p>After</p>', 'p { margin: 0 }'));
    out.anchor = E.plain(await E.readEntries('<div>Lead-in words<h1 id="two">Chapter Two</h1></div>'));
    out.dataPicture = E.plain(await E.readEntries('<p>Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="A drawn chart"/></p>')).map((e) => e.text);
    out.object = E.plain(await E.readEntries('<p>Sales: <object data="chart.svg" type="image/svg+xml"><img src="chart.png" alt="Sales chart"/></object></p>')).map((e) => e.text);
    out.objectPicture = E.plain(await E.readEntries('<p>Sales: <object data="chart.png" type="image/png"><img src="other.png" alt="Fallback words"/></object></p>', '', { sizes: { 'chart.png': [800, 400] } }));

    // Styles, from the user agent's defaults and the book's CSS.
    out.styles = E.plain(await E.readEntries(`
      <h1>Big</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>
      <p class="r">Right</p><p class="j">Justified</p><p style="text-align: left" dir="rtl">Physical</p><p class="i">Indented first line</p>
      <p><b>bold</b> <i>italic</i> <u>under</u> <s>struck</s> x<sup>2</sup> H<sub>2</sub>O <code>mono</code> <mark>marked</mark> <span class="big">big</span> <span class="sans">sans</span></p>
      <blockquote><p>Quoted</p></blockquote>
      <p>A <q>quote</q> here</p>
      <pre>  two
   lines</pre>
      <p class="secret">gone</p><p hidden="">gone too</p><p>Kept<script>gone()</script><button>gone</button></p>
      <dl><dt>Term</dt><dd>Definition</dd></dl>
      <p class="nounder"><u>not underlined</u></p>
      <center>Centred</center>`,
    `.r { text-align: right } .j { text-align: justify } .i { text-indent: 2em; margin-left: 10% } .big { font-size: x-large }
     .sans { font-family: Helvetica, Arial } .secret { display: none } .nounder u { text-decoration: none }`));

    out.listKinds = E.plain(await E.readEntries(`
      <ol start="3" type="i"><li>three</li><li value="10">ten</li><li>eleven</li></ol>
      <ul class="alpha"><li>a</li><li>b</li></ul>
      <ul><li>one<ul><li>two<ul><li>three<ul><li>four</li></ul></li></ul></li></ul></li></ul>
      <ul style="list-style: none"><li>none</li></ul>
      <ol><li style="list-style-type: disc">disc in ol</li></ol>`, '.alpha { list-style-type: upper-alpha }')).map((e) => [e.label, e.text]);

    out.breaks = E.plain(await E.readEntries('<p>one</p><h2 style="page-break-before: always">two</h2><p class="after">three</p><hr/><p>four</p>', '.after { break-after: page }'))
      .map((e) => [e.kind, e.text, e.before]);

    out.table = E.plain(await E.readEntries(`<p>Before</p><table id="t"><caption id="cap">The caption</caption>
      <tr><th colspan="2">Head</th><th>H3</th></tr>
      <tr><td rowspan="2">Tall</td><td>b<br/>c</td><td id="cell">d</td></tr>
      <tr><td>e</td><td>f</td></tr></table><p>After</p>`)).map((e) => [e.kind, e.text, e.ids, e.rows, e.before]);

    out.pictures = E.plain(await E.readEntries(`<p>Text <img src="s.png"/> inline</p>
      <img src="p.png"/><img src="p.png" width="50%"/><img src="p.png" style="width: 8em"/><img src="p.png" height="32"/>
      <div><img src="missing.png" alt="Missing words"/></div><p><img src="p.png"/> leads</p>`, '',
    { sizes: { 's.png': [16, 16], 'p.png': [400, 300] } })).map((e) => [e.kind, e.text, e.width, e.height, e.share, e.runs?.some((r) => r.obj) ?? null]);

    out.pageMargins = E.plain(await E.readEntries('<div style="margin: 20em 0 0 0"><p style="margin-top: -3em">x</p></div><p style="margin-left: 400pt; margin-right: 400pt">wide</p>'))
      .map((e) => [e.before, e.style.left, e.style.right]);

    out.htmlStyle = E.plain(await E.readEntries('<p>Alpha<br>Beta</p><p>One &amp; two</p>')).map((e) => e.text);
    out.firstHeading = await (async () => {
      const r = new E.html.XhtmlReader('ch.xhtml', 11, 332, null, null, null, () => {}, async () => {});
      await r.read(E.u8(E.xhtml('<h4>Small</h4><h2>  The\n real   one </h2><h1>Later</h1>', '<meta name="viewport" content="width=800, height=600"/>')));
      return [r.firstHeading, r.viewport];
    })();
    return out;
  });
  check('huge paragraphs are read in parts', r.huge.length >= 8 && r.huge.every((n) => n < 12100) && r.hugeKept, r.huge);
  check('Japanese text split into parts is all read', r.jpSplit[0] >= 3 && r.jpSplit[1] === 1500 && r.jpSplit[2] === '終わり', r.jpSplit);
  check('failures to make pages come through', r.sinkFailure?.message === 'No space left', r.sinkFailure);
  check('rems are of the root font size', r.rems.length === 1 && near(r.rems[0].size, 11, 0.01), r.rems);
  const v = (t) => r.vertical.find((e) => e.text === t);
  check('books written down the page keep the width without their alternate look', v('山路を登りながら') && near(v('山路を登りながら').style.left, 0, 0.01) && near(v('After').before, 22, 0.01), r.vertical);
  check('line breaks between Japanese characters next to inline elements', JSON.stringify(r.japanese) === '["門の下で雨やみを待っていた Japan"]', r.japanese);
  const l = (t) => r.lists.find((e) => e.text === t);
  check('lists have space around them unless in a list', near(l('Item').before, 5.5, 0.01) && near(l('After').before, 5.5, 0.01) && near(l('Inner').before, 1.65, 0.01) && l('Item').label === '•' && l('Inner').label === '◦', r.lists);
  check('a block after text keeps its own place for links', JSON.stringify(r.anchor.find((e) => e.text === 'Chapter Two')?.ids) === '["two"]' && r.anchor[0].ids.length === 0, r.anchor);
  check('a picture written into the page leaves its description', r.dataPicture.some((t) => t.includes('A drawn chart')), r.dataPicture);
  check('objects show what they hold in place of an SVG', r.object.some((t) => t.includes('Sales chart')), r.object);
  check('an object that is a picture shows it, not what it holds', r.objectPicture.some((e) => e.kind === 'image' && e.path === 'chart.png') && !JSON.stringify(r.objectPicture).includes('Fallback'), r.objectPicture);

  const s = (t) => r.styles.find((e) => e.text === t);
  check('heading sizes and levels', near(s('Big').size, 19.8, 0.01) && s('Big').bold && s('Big').heading === 1 && near(s('Two').size, 16.5, 0.01) &&
    near(s('Three').size, 13.75, 0.01) && near(s('Six').size, 9.9, 0.01) && s('Six').heading === 6 && near(s('Big').before, 0.8 * 19.8, 0.01), [s('Big'), s('Six')]);
  check('alignment', s('Right').style.align === 'end' && s('Justified').style.align === 'justify' && s('Physical').style.align === 'start' &&
    s('Physical').style.physical && s('Physical').style.rtl && s('Centred').style.align === 'center' && s('Right').style.physical, [s('Right').style, s('Physical').style]);
  check('text indent and side margins', near(s('Indented first line').style.textIndent, 22, 0.01) && near(s('Indented first line').style.left, 33.2, 0.01), s('Indented first line').style);
  const runs = r.styles.find((e) => e.text?.startsWith('bold')).runs;
  const run = (t) => runs.find((x) => x.text.includes(t));
  check('bold, italic, underlined, struck, raised and lowered text', run('bold').bold && run('italic').italic && run('under').underline && run('struck').strike &&
    run('2').baseline === 1 && runs.find((x) => x.text === '2' && x.baseline === -1) && run('mono').family === 'monospace' && near(run('mono').size, 10.12, 0.01) &&
    near(run('big').size, 16.5, 0.01) && run('sans').family === 'sans-serif' && run('bold').family === 'serif', runs);
  check('block quotes are indented on both sides', near(s('Quoted').style.left, 16.5, 0.01) && near(s('Quoted').style.right, 16.5, 0.01), s('Quoted').style);
  check('quotation marks', !!r.styles.find((e) => e.text === 'A “quote” here'), r.styles.map((e) => e.text));
  check('preformatted text keeps its spaces and lines', !!r.styles.find((e) => e.text === '  two\n   lines' && e.font === 'monospace'), r.styles.map((e) => e.text));
  check('hidden parts, scripts and forms are left out', !JSON.stringify(r.styles).includes('gone') && !!s('Kept'), r.styles.map((e) => e.text));
  check('definition lists', s('Term').bold && near(s('Definition').style.left, 19.8, 0.01), [s('Term'), s('Definition')]);
  check('text-decoration: none', r.styles.find((e) => e.text === 'not underlined').runs.every((x) => !x.underline), '');
  check('list numbers and bullets', JSON.stringify(r.listKinds) === JSON.stringify([
    ['iii.', 'three'], ['x.', 'ten'], ['xi.', 'eleven'], ['A.', 'a'], ['B.', 'b'], ['•', 'one'], ['◦', 'two'], ['▪', 'three'], ['▪', 'four'],
    [null, 'none'], ['•', 'disc in ol']]), r.listKinds);
  const wantBreaks = [['para', 'one', 5.5], ['break', null, 0], ['para', 'two', 13.2], ['para', 'three', 13.2], ['break', null, 0], ['rule', null, 5.5], ['para', 'four', 5.5]];
  check('page breaks and rules', r.breaks.length === wantBreaks.length && wantBreaks.every((w, i) => w[0] === r.breaks[i][0] && w[1] === r.breaks[i][1] && near(w[2], r.breaks[i][2], 0.01)), r.breaks);
  const t = r.table;
  check('tables, captions, spans and anchors in cells', t.length === 4 && t[1][1] === 'The caption' && JSON.stringify(t[1][2]) === '["t","cap"]' && t[2][0] === 'table' &&
    JSON.stringify(t[2][3]) === JSON.stringify([[{ span: 2, rowSpan: 1, header: true, text: 'Head' }, { span: 1, rowSpan: 1, header: true, text: 'H3' }],
      [{ span: 1, rowSpan: 2, header: false, text: 'Tall' }, { span: 1, rowSpan: 1, header: false, text: 'b\nc' }, { span: 1, rowSpan: 1, header: false, text: 'd' }],
      [{ span: 1, rowSpan: 1, header: false, text: 'e' }, { span: 1, rowSpan: 1, header: false, text: 'f' }]]) && near(t[1][4], 8.8, 0.01) && near(t[3][4], 8.8, 0.01), t);
  const p = r.pictures;
  check('pictures: in a line of text, on their own, sized by CSS', p[0][0] === 'para' && p[0][5] === true && p[1][0] === 'image' && near(p[1][2], 275, 0.01) && near(p[1][3], 206.25, 0.01) &&
    p[2][4] === 0.5 && near(p[3][2], 88, 0.01) && near(p[3][3], 66, 0.01) && near(p[4][3], 22, 0.01) && near(p[4][2], 29.33, 0.01) &&
    p.some((e) => e[1]?.includes('Missing words')) && p[p.length - 2][0] === 'image' && p[p.length - 1][1] === 'leads', p);
  check('margins are tamed', near(r.pageMargins[0][0], 88, 0.01) && near(r.pageMargins[1][1] + r.pageMargins[1][2], 166, 0.01), r.pageMargins);
  check('HTML-style line breaks', JSON.stringify(r.htmlStyle) === '["Alpha\\nBeta","One & two"]', r.htmlStyle);
  check('first main heading and viewport', JSON.stringify(r.firstHeading) === '["The real one",[800,600]]', r.firstHeading);
}

// ---------------------------------------------------------------------------------------------
// Books converted (EpubConverterDeviceTest)

const pageWith = (texts, text) => texts.findIndex((t) => t.includes(text));

async function orchard(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const a5 = await E.convert(E.epub2(), { name: 'orchard-a5' });
    const a4 = await E.convert(E.epub2(), { bookPage: 'a4' });
    out.error = a5.error ?? a4.error ?? null;
    if (out.error) return { ...out, cause: a5.cause ?? a4.cause };
    out.name = a5.name;
    out.size = a5.bytes.length;
    out.pageCount = a5.pageCount;
    out.sizes = [(await E.sizes(a5.bytes))[0], (await E.sizes(a4.bytes))[0]];
    const direct = await E.epubMod.convertEpub({ name: 'Orchard.epub', bytes: E.epub2() }, { pageSize: 'a4' });
    out.direct = [direct.name, direct.type, direct.pageCount, (await E.sizes(direct.bytes))[0]];
    const pages = await E.pages(a5.bytes);
    out.texts = pages.map((p) => p.text);
    const p1 = pages[0];
    out.heading = E.word(p1, 'Chapter');
    out.body = E.word(p1, 'nobody');
    out.sub = E.word(p1, 'Later');
    out.width = p1.width;
    out.firstLines = E.lineEnds(p1);
    out.outline = await E.outline(a5.bytes);
    out.info = await E.info(a5.bytes);
    const a4pages = await E.pages(a4.bytes);
    out.a4Left = Math.min(...a4pages[0].items.filter((i) => i.str.trim()).map((i) => i.x));
    out.a4Size = E.word(a4pages[0], 'nobody')?.size;
    // Bold, italic and underlined words: their fonts, and the line under one.
    const bold = E.word(pages[out.texts.findIndex((t) => t.includes('Line two'))] ?? p1, 'bold');
    out.boldFont = bold?.font;
    out.italicFont = E.word(p1, 'italic')?.font;
    out.bodyFont = out.body?.font;
    // The table's header row is shaded and has borders.
    const tablePage = out.texts.findIndex((t) => t.includes('Fruit'));
    const fruit = E.word(pages[tablePage], 'Fruit');
    const shot = await E.render(a5.bytes, tablePage + 1, 2);
    out.headerFill = shot.px(fruit.x - 4, fruit.y - fruit.size * 0.3);
    out.pagePaper = shot.px(10, 10);
    return out;
  });
  check('the orchard converts', !r.error, r);
  check('the PDF is named after the choice', r.name === 'orchard-a5.pdf', r.name);
  check('pages are A5 unless A4 is chosen', near(r.sizes[0][0], 420, 1) && near(r.sizes[0][1], 595, 1) && near(r.sizes[1][0], 595, 1) && near(r.sizes[1][1], 842, 1), r.sizes);
  check('convertEpub on its own gives an OutputFile', r.direct[0] === 'Orchard.pdf' && r.direct[1] === 'application/pdf' && r.direct[2] >= 4 && near(r.direct[3][0], 595, 1), r.direct);
  const texts = r.texts;
  const one = pageWith(texts, 'Chapter One');
  const two = pageWith(texts, 'Chapter Two');
  const three = pageWith(texts, 'Chapter Three');
  check('chapters follow the reading order', one >= 0 && one < two && two < three, [one, two, three]);
  check('each chapter starts at the top of a page', texts[two].startsWith('Chapter Two') && texts[three].startsWith('Chapter Three'), [texts[two].slice(0, 30), texts[three].slice(0, 30)]);
  check('chapter two runs over pages', three - two >= 2, [two, three]);
  check("the style sheet's page break", texts[pageWith(texts, 'After a break')].startsWith('After a break') && pageWith(texts, 'Before the break') < pageWith(texts, 'After a break'), texts.slice(three));
  const all = texts.join(' ');
  check("HTML's named characters", all.includes('café opened at dawn — nobody came') || all.includes('café opened at dawn — nobody came'), all.slice(0, 120));
  for (const text of ['• First apple', '• Second apple', '1. Step one', '2. Step two', 'A quoted line.', 'Line one Line two', 'Fruit Count', 'Plums 12']) {
    check(`"${text}" is kept`, all.includes(text), all.slice(0, 600));
  }
  check('display:none and scripts are left out', !all.includes('hidden') && !all.includes('script text'), '');
  check('headings are bigger', r.heading.size > r.sub.size + 2 && r.sub.size > r.body.size + 1, [r.heading.size, r.sub.size, r.body.size]);
  check('headings are bold, the text not', /Bold/.test(r.heading.font ?? '') && !/Bold/.test(r.body.font ?? ''), [r.heading.font, r.body.font]);
  check('the book is set in serif type', /Serif/.test(r.body.font ?? ''), r.body.font);
  check('bold and italic words', /Bold/.test(r.boldFont ?? '') && /Italic/.test(r.italicFont ?? ''), [r.boldFont, r.italicFont]);
  check('centred by the style sheet', r.heading.x > 44 + 20 && r.heading.x < r.width / 2, r.heading.x);
  check("A5's text starts 44 points in, A4's 66, in a bigger type", near(r.firstLines[1][0], 44, 1) && near(r.a4Left, 66, 1) && r.a4Size > r.body.size, [r.firstLines[1], r.a4Left, r.a4Size, r.body.size]);
  check('the header row is shaded', r.headerFill.every((c) => c >= 225 && c <= 250) && r.pagePaper.every((c) => c === 255), [r.headerFill, r.pagePaper]);
  // Bookmarks from the NCX table of contents.
  const top = r.outline;
  check('bookmarks from the table of contents', JSON.stringify(top.map((o) => o.title)) === '["Chapter One","Chapter Two","Chapter Three"]', top.map((o) => o.title));
  check('bookmarks lead to their chapters', top[0].page === one && top[1].page === two && top[2].page === three, top.map((o) => o.page));
  check('bookmarks lead to the top of the page', near(top[1].top, 595, 1), top[1].top);
  check('sub-bookmarks', JSON.stringify(top[0].items.map((o) => o.title)) === '["Later that day"]' && top[1].items[0]?.title === 'Deep section', top.map((o) => o.items.map((x) => x.title)));
  const deep = top[1].items[0];
  check('a place further into a chapter: its own page', deep.page === pageWith(texts, 'Deep section') && deep.page > top[1].page, [deep.page, top[1].page]);
  const later = top[0].items[0];
  check('a place lower on a page: its own height', later.page === one && later.top < 595 - 100 && later.top > 52, later);
  check('title, author and language go into the PDF', r.info.title === 'The Quiet Orchard' && r.info.author === 'A. Made-Up Writer' && r.info.language === 'en' && r.info.producer === 'Usugami', r.info);
  check('only the glyphs drawn are embedded', r.size < 120000 && all.includes('Chapter Three: Pears'), r.size);
}

async function gardens(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const garden = await E.convert(await E.epub3(true));
    if (garden.error) return { error: garden.error, cause: garden.cause };
    out.pages = garden.pageCount;
    out.texts = (await E.pages(garden.bytes)).map((p) => p.text);
    out.cover = await E.imagesOn(garden.bytes, 1);
    out.chapterImages = await E.imagesOn(garden.bytes, 2);
    out.outline = await E.outline(garden.bytes);
    out.info = await E.info(garden.bytes);
    const shot = await E.render(garden.bytes, 1, 1);
    out.coverPixels = [shot.px(210, 20), shot.px(5, 300), shot.px(415, 300)];
    const second = await E.render(garden.bytes, 2, 2);
    const img = out.chapterImages[0];
    out.picturePixel = img ? second.px((img.x0 + img.x1) / 2 - (img.x1 - img.x0) * 0.4, 595 - img.y1 + (img.y1 - img.y0) * 0.1) : null;
    out.objects = await E.imageObjects(garden.bytes);

    const noCover = await E.convert(await E.epub3(false));
    out.noCover = [noCover.pageCount, await E.imagesOn(noCover.bytes, 1), (await E.pages(noCover.bytes)).map((p) => p.text)];

    // A first document of pictures that aren't the cover (a title page) gets the cover before it, and
    // the cover page the book reads only when linked to isn't added at the end.
    const title = await E.convert(E.epub({
      'META-INF/container.xml': E.container('book.opf'),
      'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Title page</dc:title><dc:identifier id="id">x</dc:identifier></metadata>
        <manifest><item id="c" href="c.png" media-type="image/png" properties="cover-image"/><item id="t" href="t.png" media-type="image/png"/>
        <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="cover" linear="no"/><itemref idref="title"/><itemref idref="ch"/></spine></package>`,
      'c.png': await E.png(600, 900, [120, 60, 140]),
      't.png': await E.png(600, 300, [200, 90, 40]),
      'cover.xhtml': E.xhtml('<div><img src="c.png" alt="Cover"/></div>', '', '<!DOCTYPE html>'),
      'title.xhtml': E.xhtml('<div><img src="t.png" alt="Title"/></div>', '', '<!DOCTYPE html>'),
      'ch.xhtml': E.xhtml('<p>Hello reader.</p>', '', '<!DOCTYPE html>'),
    }));
    out.title = [title.pageCount, await E.imagesOn(title.bytes, 1), await E.imagesOn(title.bytes, 2), (await E.pages(title.bytes)).map((p) => p.text)];
    return out;
  });
  check('the garden converts', !r.error, r);
  check('the cover comes first, then the chapter', r.pages === 2 && r.texts[0] === '' && r.texts[1].includes('Hello garden'), [r.pages, r.texts]);
  const c = r.cover[0];
  check('the cover fills the page height, centred', r.cover.length === 1 && near(c.y1 - c.y0, 595, 2) && near(420 - c.x1, c.x0, 2), r.cover);
  check("the cover's pixels", E_near(r.coverPixels[0], [120, 60, 140]) && r.coverPixels[1].every((v) => v === 255) && r.coverPixels[2].every((v) => v === 255), r.coverPixels);
  check('the chapter has its picture', r.chapterImages.length === 1, r.chapterImages);
  const img = r.chapterImages[0];
  check('the picture is centred at its natural size (16 px to 11 points)', near(img.x1 - img.x0, 220, 1.5) && near(img.y1 - img.y0, 137.5, 1.5) && near((img.x0 + img.x1) / 2, 210, 1.5), img);
  check("the picture's pixels", E_near(r.picturePixel, [70, 130, 180]), r.picturePixel);
  check('the SVG drawing gives way to its description', r.texts[1].includes('A tiny drawing'), r.texts[1]);
  check('bookmarks from the EPUB 3 navigation document, not its hidden landmarks', JSON.stringify(r.outline.map((o) => o.title)) === '["Cover","Hello garden"]' &&
    r.outline[0].page === 0 && r.outline[1].page === 1 && JSON.stringify(r.outline[1].items.map((o) => o.title)) === '["The beds"]', r.outline);
  check('a book without an author has none in the PDF', r.info.title === 'A Small Garden' && !r.info.author && r.info.language === 'en', r.info);
  check('pictures are compressed: opaque ones as JPEG, no bigger than 150 pixels per inch', r.objects.length === 2 && r.objects.every((o) => o.filter === '/DCTDecode') &&
    r.objects.some((o) => o.width <= 600 && o.height <= 900) && r.objects.some((o) => o.width <= 459 && o.width >= 300), r.objects);
  const [pages, coverImgs, noCoverTexts] = r.noCover;
  check("a cover the book doesn't show is added first", pages === 2 && coverImgs.length === 1 && near(coverImgs[0].y1 - coverImgs[0].y0, 595, 2) && noCoverTexts[1].includes('Hello garden'), r.noCover);
  const [tPages, tCover, tTitle, tTexts] = r.title;
  check('the cover goes before a first page of other pictures', tPages === 3 && near(tCover[0].y1 - tCover[0].y0, 595, 2) && near(tTitle[0].y1 - tTitle[0].y0, 210, 2) &&
    near(tTitle[0].x1 - tTitle[0].x0, 420, 2) && tTexts[2].includes('Hello reader'), r.title);
}

function E_near(a, b, tol = 40) {
  return Array.isArray(a) && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

async function layouts(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    // Hidden pictures, formula sources, tables and wide pictures in text.
    const reader = await E.convert(E.oneChapter(`<div><img class="secret" src="p.png"/><h1>Chapter heading</h1><p>Plain words</p></div>
      <h2><br hidden=""/>Second title</h2><p>Body after</p>
      <p>Area <math><semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="application/x-tex">x^2</annotation></semantics></math> done</p>
      <epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML"><math><mi>casetext</mi></math></epub:case>
      <epub:default><p>fallback</p></epub:default></epub:switch>
      <p>Above</p><p>Next</p><p>Over</p><table><tr><td>Cell</td></tr></table>
      <p>Hence <img src="wide.png"/> holds.</p>`, { css: '.secret { display: none }', files: { 'p.png': await E.png(40, 40), 'wide.png': await E.png(1000, 32) } }));
    if (reader.error) return { error: reader.error, cause: reader.cause };
    const pages = await E.pages(reader.bytes);
    out.readerText = pages.map((p) => p.text).join(' ');
    const p1 = pages[0];
    out.sizes = [E.word(p1, 'Plain')?.size, E.word(p1, 'Body')?.size];
    out.gaps = [E.word(p1, 'Next').y - E.word(p1, 'Above').y, E.word(p1, 'Cell').y - E.word(p1, 'Over').y];
    out.wide = [];
    for (let n = 1; n <= reader.pageCount; n++) out.wide.push(...await E.imagesOn(reader.bytes, n));

    // In a paragraph that reads right to left, text-align: right and left stay on their side, and a
    // list's bullet and indent go on the right, where the paragraph starts. Left to right, as before.
    const rtl = await E.convert(E.oneChapter(`<p dir="rtl" class="r">Right side</p><p dir="rtl" class="l">Left side</p>
      <ul dir="rtl"><li>Item one</li></ul><p class="r">Plain right</p><ul><li>Item two</li></ul>`, { css: '.r { text-align: right } .l { text-align: left }' }));
    out.rtl = E.lineEnds((await E.pages(rtl.bytes))[0]);

    // Justified, right-aligned and indented text, block quotes and monospace from a style sheet.
    const words = 'The orchard keeper walked the rows each morning and counted the trees that had flowered overnight. ';
    const styled = await E.convert(E.oneChapter(`<p class="j">${words.repeat(4)}</p><p class="r">Short right line</p><p class="i">${words.repeat(2)}</p>
      <blockquote><p>${words.repeat(2)}</p></blockquote><pre>mono  spaced</pre><p class="sans">Sans words</p><p><span class="small">small</span> <span class="large">large</span></p>`,
    { css: '.j { text-align: justify } .r { text-align: right } .i { text-indent: 3em } .sans { font-family: Arial, sans-serif } .small { font-size: 0.5em } .large { font-size: 2em }' }));
    const sp = (await E.pages(styled.bytes))[0];
    out.styled = { lines: E.lineEnds(sp), mono: E.word(sp, 'mono')?.font, sans: E.word(sp, 'Sans')?.font, small: E.word(sp, 'small')?.size, large: E.word(sp, 'large')?.size, right: E.word(sp, 'Short') };
    return out;
  });
  check('the reader book converts', !r.error, r);
  for (const kept of ['Chapter heading', 'Plain words', 'Second title', 'Body after', 'Area', 'done', 'fallback']) check(`"${kept}" is kept`, r.readerText.includes(kept), r.readerText);
  check("a hidden picture doesn't change what follows", near(r.sizes[0], r.sizes[1], 0.1), r.sizes);
  check("a formula's TeX source and MathML with a fallback aren't printed", !r.readerText.includes('x^2') && !r.readerText.includes('casetext'), r.readerText);
  check('a table keeps the space above it', r.gaps[1] > r.gaps[0] + 4, r.gaps);
  check('a picture in a line of text, wider than the text, is shrunk to its width', r.wide.length === 1 && near(r.wide[0].x1, 420 - 44, 1.5) && near(r.wide[0].x0, 44, 1.5), r.wide);
  const L = r.rtl;
  check('right to left: five lines', L.length === 5, L);
  check('right to left: text-align right stays right', near(L[0][1], 376, 2), L[0]);
  check('right to left: text-align left stays left', near(L[1][0], 44, 2), L[1]);
  check("right to left: the list's bullet and indent on the right", L[2][0] > 210 && L[2][1] < 372, L[2]);
  check('left to right: right', near(L[3][1], 376, 2), L[3]);
  check('left to right: the bullet on the left', L[4][0] < 100, L[4]);
  const s = r.styled;
  const lines = s.lines;
  check('justified lines reach both margins', near(lines[0][0], 44, 1) && near(lines[0][1], 376, 1) && near(lines[1][1], 376, 1) && lines[3][1] < 376, lines.slice(0, 5));
  const right = lines.find((l) => near(l[0], s.right.x, 1));
  check('a right-aligned line ends at the right margin', right && near(right[1], 376, 1.5), [s.right, right]);
  const indented = lines.findIndex((l, i) => i > 0 && l[0] > 44 + 30 && l[0] < 44 + 40);
  check("text-indent moves a paragraph's first line in by 3 em", indented > 0 && near(lines[indented + 1][0], 44, 1), lines);
  check('a block quote is indented on both sides', lines.some((l) => near(l[0], 44 + 16.5, 1)) && lines.some((l) => l[1] <= 376 - 16 && l[1] > 300), lines);
  check('preformatted text is monospace, other families by the style sheet', /Mono/.test(s.mono ?? '') && /NotoSans-/.test(s.sans ?? ''), [s.mono, s.sans]);
  check("font sizes from the style sheet, kept within 0.6 and 3 times the book's", near(s.small, 6.6, 0.2) && near(s.large, 22, 0.2), [s.small, s.large]);
}

async function fixedLayouts(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const landscape = '<meta name="viewport" content="width=800, height=600"/>';
    const dense = await E.convert(E.epub({
      'META-INF/container.xml': E.container('book.opf'),
      'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Dense</dc:title><dc:identifier id="id">x</dc:identifier>
        <meta property="rendition:layout">pre-paginated</meta></metadata>
        <manifest><item id="c" href="c.png" media-type="image/png" properties="cover-image"/><item id="i2" href="p2.png" media-type="image/png"/>
        <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="d1" href="p1.xhtml" media-type="application/xhtml+xml"/>
        <item id="d2" href="p2.xhtml" media-type="application/xhtml+xml"/><item id="d3" href="after.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="cover" linear="no"/><itemref idref="d1"/><itemref idref="d2"/>
        <itemref idref="d3" properties="rendition:layout-reflowable"/></spine></package>`,
      'c.png': await E.png(600, 800),
      'p2.png': await E.png(800, 600, [200, 90, 40]),
      'cover.xhtml': E.xhtml('<div><img src="c.png" alt="Cover"/></div>', '', '<!DOCTYPE html>'),
      // Each line its own paragraph, as tools that make fixed-layout books write them.
      'p1.xhtml': E.xhtml(Array.from({ length: 60 }, (_, i) => `<p>line ${i + 1}</p>`).join(''), landscape, '<!DOCTYPE html>'),
      'p2.xhtml': E.xhtml('<div><img src="p2.png" alt="Page 2"/></div>', landscape, '<!DOCTYPE html>'),
      // An afterword the book lets flow onto pages as ordinary text does.
      'after.xhtml': E.xhtml(E.paragraphs(30, 'Afterword'), '', '<!DOCTYPE html>'),
    }));
    if (dense.error) return { error: dense.error, cause: dense.cause };
    out.dense = { sizes: await E.sizes(dense.bytes), texts: (await E.pages(dense.bytes)).map((p) => p.text) };
    const p1 = (await E.pages(dense.bytes))[1];
    out.dense.lineSize = E.word(p1, 'line 30')?.size;

    const pageDoc = (n) => E.xhtml(`<div><img src="p${n}.png" alt="Page ${n}"/></div>`, landscape, '<!DOCTYPE html>');
    const comic = await E.convert(E.epub({
      'META-INF/container.xml': E.container('book.opf'),
      'book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Comic</dc:title><dc:identifier id="id">x</dc:identifier>
        <meta property="rendition:layout">pre-paginated</meta></metadata>
        <manifest><item id="i1" href="p1.png" media-type="image/png" properties="cover-image"/><item id="i2" href="p2.png" media-type="image/png"/>
        <item id="d1" href="p1.xhtml" media-type="application/xhtml+xml"/><item id="d2" href="p2.xhtml" media-type="application/xhtml+xml"/>
        <item id="i3" href="p3.jpg" media-type="image/jpeg"/></manifest>
        <spine><itemref idref="d1"/><itemref idref="d2"/><itemref idref="i3"/></spine></package>`,
      'p1.png': await E.png(800, 600),
      'p2.png': await E.png(800, 600, [200, 90, 40]),
      'p3.jpg': await E.png(300, 900, [20, 160, 60], 'image/jpeg'),
      'p1.xhtml': pageDoc(1),
      'p2.xhtml': pageDoc(2),
    }));
    out.comic = { pages: comic.pageCount, sizes: await E.sizes(comic.bytes), images: [] };
    for (let n = 1; n <= comic.pageCount; n++) out.comic.images.push(await E.imagesOn(comic.bytes, n));
    const shot = await E.render(comic.bytes, 2, 1);
    out.comic.pixel = shot.px(100, 100);
    return out;
  });
  check('the fixed-layout book converts', !r.error, r);
  const d = r.dense;
  check('a fixed-layout page turns sideways for a landscape viewport', d.sizes[1][0] > d.sizes[1][1] && d.sizes[0][0] < d.sizes[0][1], d.sizes);
  check('the page of lines is shrunk onto one page', d.texts[1].includes('line 1 line 2') && d.texts[1].includes('line 60') && d.lineSize < 11, [d.texts[1].slice(0, 40), d.lineSize]);
  check('the afterword flows onto pages of its own', pageWith(d.texts, 'Afterword paragraph 1 goes') === 3 && pageWith(d.texts, 'Afterword paragraph 30 goes') === d.texts.length - 1 && d.texts.length > 4, d.texts.map((t) => t.slice(0, 30)));
  check("the cover page read only when linked to isn't added again", !d.texts.slice(4).some((t) => t === '') && d.sizes.length === d.texts.length, d.texts.length);
  const c = r.comic;
  check('a page per document: the cover is the first page itself', c.pages === 3, c.pages);
  for (let i = 0; i < 2; i++) {
    const [w, h] = c.sizes[i];
    const img = c.images[i][0];
    check(`comic page ${i + 1} is landscape, its picture filling the height, centred`, w > h && c.images[i].length === 1 && near(img.y1 - img.y0, h, 2) && near(w - img.x1, img.x0, 2), [c.sizes[i], c.images[i]]);
  }
  const tall = c.images[2][0];
  check('a picture straight in the reading order fills its page', c.sizes[2][0] < c.sizes[2][1] && near(tall.y1 - tall.y0, 595, 2) && near(tall.x1 - tall.x0, 595 / 3, 2), [c.sizes[2], tall]);
  check("the second comic page's pixels", E_near(c.pixel, [200, 90, 40]), c.pixel);
}

async function anchorsAndOdds(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const body = E.paragraphs(40, 'Filler') + '<p><a id="before"/></p><table id="table"><tr><td id="cell">Totals</td></tr></table>' +
      E.paragraphs(40, 'More') + '<p><a name="old"/>Old anchor here</p>';
    const toc = [['Start', 'ch.xhtml'], ['Before', 'ch.xhtml#before'], ['Table', 'ch.xhtml#table'], ['Cell', 'ch.xhtml#cell'], ['Old', 'ch.xhtml#old'], ['Nowhere', 'ch.xhtml#nowhere'], ['', 'ch.xhtml#cell']];
    const anchors = await E.convert(E.oneChapter(body, { toc }));
    if (anchors.error) return { error: anchors.error, cause: anchors.cause };
    out.anchors = { texts: (await E.pages(anchors.bytes)).map((p) => p.text), outline: await E.outline(anchors.bytes) };

    // Some tools write "/META-INF/container.xml".
    const rooted = await E.convert(E.oneChapter('<p>Rooted words</p>', { root: '/' }));
    out.rooted = rooted.error ?? (await E.pages(rooted.bytes)).map((p) => p.text).join(' ');

    // No container file: the first .opf file is used.
    const files = E.epub2Files();
    delete files['META-INF/container.xml'];
    const orphan = await E.convert(E.epub(files));
    out.orphan = orphan.error ?? (await E.pages(orphan.bytes)).map((p) => p.text).join(' ');

    // A container naming a package that isn't there: the first .opf file too.
    const wrong = E.epub2Files();
    wrong['META-INF/container.xml'] = E.container('nowhere/content.opf');
    const misnamed = await E.convert(E.epub(wrong));
    out.misnamed = misnamed.error ?? 'ok';

    // Links in the wrong case, as books made on Windows have; a spine item whose file is missing.
    const cased = E.epub2Files();
    cased['OEBPS/content.opf'] = cased['OEBPS/content.opf'].replace('href="text/chapter1.xhtml"', 'href="Text/Chapter1.XHTML"')
      .replace('<itemref idref="c3"/>', '<itemref idref="c3"/><itemref idref="gone"/>').replace('</manifest>', '<item id="gone" href="text/gone.xhtml" media-type="application/xhtml+xml"/></manifest>');
    const casedOut = await E.convert(E.epub(cased));
    out.cased = casedOut.error ?? (await E.pages(casedOut.bytes)).map((p) => p.text).join(' ');

    // Notes read only when linked to go after the main text; a damaged NCX gives the chapters' headings as bookmarks.
    const notes = E.epub2Files();
    notes['OEBPS/content.opf'] = notes['OEBPS/content.opf'].replace('<itemref idref="c1"/>', '<itemref idref="c1" linear="no"/>');
    notes['OEBPS/toc.ncx'] = 'not xml at all';
    const notesOut = await E.convert(E.epub(notes));
    out.notes = notesOut.error ?? { texts: (await E.pages(notesOut.bytes)).map((p) => p.text), outline: await E.outline(notesOut.bytes) };

    // A nav document damaged halfway: the entries before the damage.
    const halfNav = E.oneChapterFiles('<h1 id="a">First</h1><h1 id="b">Second</h1>', { toc: [] });
    halfNav['nav.xhtml'] = '<html><body><nav epub:type="toc"><ol><li><a href="ch.xhtml#a">First</a></li><li><a href="ch.xhtml#b">Second</a></li><li><a href="ch.xhtml#b" class="x';
    const half = await E.convert(E.epub(halfNav));
    out.halfNav = half.error ?? (await E.outline(half.bytes)).map((o) => o.title);

    // An NCX with a page list, which isn't the contents; nested points; spans as nav headings.
    const ncxFiles = E.epub2Files();
    ncxFiles['OEBPS/toc.ncx'] = ncxFiles['OEBPS/toc.ncx'].replace('</navMap>', '</navMap><pageList><pageTarget><navLabel><text>Page 1</text></navLabel><content src="text/chapter3.xhtml"/></pageTarget></pageList>');
    const ncxOut = await E.convert(E.epub(ncxFiles));
    out.pageList = (await E.outline(ncxOut.bytes)).map((o) => o.title);
    return out;
  });
  check('the anchors book converts', !r.error, r);
  const texts = r.anchors.texts;
  const pageOf = (title) => r.anchors.outline.find((o) => o.title === title)?.page;
  const totals = pageWith(texts, 'Totals');
  check('bookmarks into a table find its page', totals > 0 && pageOf('Before') === totals && pageOf('Table') === totals && pageOf('Cell') === totals, [totals, pageOf('Before'), pageOf('Table'), pageOf('Cell')]);
  check('old-style <a name> anchors find their page', pageOf('Old') === pageWith(texts, 'Old anchor here') && pageOf('Old') > totals, pageOf('Old'));
  check('a link to an id that isn\'t there leads to its document; untitled entries are left out', pageOf('Nowhere') === 0 && r.anchors.outline.length === 6, r.anchors.outline.map((o) => o.title));
  check('zip names starting with a slash still open', r.rooted.includes('Rooted words'), r.rooted);
  check('a book without a container file still opens', r.orphan.includes('Chapter Three'), r.orphan.slice(0, 80));
  check('a container naming a missing package: the .opf in the book', r.misnamed === 'ok', r.misnamed);
  check('links in the wrong case and missing documents', r.cased.includes('Chapter One') && r.cased.includes('Chapter Three'), r.cased.slice(0, 80));
  const n = r.notes;
  check('documents read only when linked to go after the main text', n.texts && pageWith(n.texts, 'Chapter One') > pageWith(n.texts, 'Chapter Three'), n);
  check("without a readable table of contents the chapters' headings are the bookmarks", JSON.stringify(n.outline.map((o) => o.title)) === '["Chapter Two: Plums","Chapter Three: Pears","Chapter One: Apples"]' &&
    n.outline[2].page === pageWith(n.texts, 'Chapter One') && n.outline[0].page === 0, n.outline);
  check('a damaged navigation document: the entries before the damage', JSON.stringify(r.halfNav) === '["First","Second"]', r.halfNav);
  check("an NCX's page list isn't the contents", JSON.stringify(r.pageList) === '["Chapter One","Chapter Two","Chapter Three"]', r.pageList);
}

async function damaged(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const orchardWith = (extra) => E.epub({ ...E.epub2Files(), ...extra });
    // Malformed documents don't stop the book.
    const broken = await E.convert(orchardWith({ 'OEBPS/text/chapter3.xhtml': '<?xml version="1.0"?><html><body><p>Unclosed <b>bold<br> text &unknown; Tom & Jerry<p>Second paragraph</body>' }));
    out.broken = broken.error ?? (await E.pages(broken.bytes)).map((p) => p.text).join(' ');
    // HTML-style empty elements, without their slash: the head ends, and so does the heading.
    const html = await E.convert(orchardWith({ 'OEBPS/text/chapter3.xhtml': '<html><head><meta charset="utf-8"><link rel="icon" href="x.png"><title>T</title></head><body><h1>Alpha<br>Beta</h1><p>Body text</p></body></html>' }));
    const last = (await E.pages(html.bytes)).pop();
    out.html = [E.word(last, 'Body')?.size, E.word(last, 'Beta')?.size, last.text];
    // A chapter that isn't XML at all, one that is empty, and one whose zip data is damaged: left out, the rest kept.
    const files = E.epub2Files();
    files['OEBPS/text/chapter1.xhtml'] = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9]);
    files['OEBPS/text/chapter3.xhtml'] = '';
    const junk = await E.convert(E.epub(files));
    out.junk = junk.error ?? (await E.pages(junk.bytes)).map((p) => p.text).join(' ');
    const zipped = E.epub(E.epub2Files());
    // Spoil the deflated data of chapter 1 (found by its local header's name).
    const name = new TextEncoder().encode('OEBPS/text/chapter1.xhtml');
    let at = -1;
    for (let i = 0; i < zipped.length - name.length; i++) {
      if (zipped[i] === 0x50 && zipped[i + 1] === 0x4b && zipped[i + 2] === 3 && zipped[i + 3] === 4 && name.every((b, k) => zipped[i + 30 + k] === b)) { at = i; break; }
    }
    const spoilt = zipped.slice();
    const dataAt = at + 30 + name.length + (spoilt[at + 28] | (spoilt[at + 29] << 8));
    for (let i = 0; i < 40; i++) spoilt[dataAt + 2 + i] = 0xff;
    const spoiltOut = await E.convert(spoilt);
    out.spoilt = spoiltOut.error ?? (await E.pages(spoiltOut.bytes)).map((p) => p.text).join(' ');
    // Deeply nested tables: may fail as a damaged book does, but mustn't hang or crash.
    const depth = 20000;
    const t0 = performance.now();
    const nested = await E.convert(orchardWith({ 'OEBPS/text/chapter3.xhtml': E.xhtml('<table><tr><td>'.repeat(depth) + 'Deep' + '</td></tr></table>'.repeat(depth)) }));
    out.nested = [nested.error ?? 'converted', performance.now() - t0];
    // A hundred thousand nested elements, and four megabytes of text without a tag.
    const t1 = performance.now();
    const divs = await E.convert(E.oneChapter('<div>'.repeat(100000) + 'Deep words' + '</div>'.repeat(100000) + '<p>After the divs</p>', { css: 'section div p { color: red } div { margin-left: 1px }' }));
    out.divs = [divs.error ?? (await E.pages(divs.bytes)).map((p) => p.text).join(' ').slice(0, 200), performance.now() - t1];
    const t2 = performance.now();
    const words = 'plain words without any markup at all to break them '.repeat(80000);
    const plain = await E.convert(E.oneChapter(`<p>${words}</p>`));
    out.plain = [plain.error ?? plain.pageCount, performance.now() - t2];
    return out;
  });
  check('a malformed chapter keeps what can be read', r.broken.includes('Unclosed') && r.broken.includes('Tom') && r.broken.includes('Chapter Two'), r.broken.slice(-200));
  check('HTML-style empty elements: the body text keeps its own size', r.html[0] < 0.9 * r.html[1] && r.html[2].includes('Body text'), r.html);
  check("chapters that can't be read are left out, the rest kept", r.junk.includes('Chapter Two') && !r.junk.includes('Chapter One'), r.junk.slice(0, 100));
  check('a chapter whose zip data is damaged is left out, the rest kept', r.spoilt.includes('Chapter Two') && !r.spoilt.includes('Chapter One'), String(r.spoilt).slice(0, 100));
  check('deeply nested tables fail or convert, quickly', (r.nested[0] === 'converted' || r.nested[0] === 'office_convert_failed') && r.nested[1] < 60000, r.nested);
  check('a hundred thousand nested elements', r.divs[0].includes('Deep words') && r.divs[0].includes('After the divs') && r.divs[1] < 60000, r.divs);
  check('four megabytes of text in one paragraph', r.plain[0] > 100 && r.plain[1] < 90000, r.plain);
}

async function refused(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const orchardWith = (extra) => E.epub({ ...E.epub2Files(), ...extra });
    const encryption = (algorithm) => `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/chapter1.xhtml"/></enc:CipherData></enc:EncryptedData>
      </encryption>`;
    const verify = (bytes) => E.thrown(() => E.index.verifyOfficeFile('epub', { name: 'x.epub', bytes }));
    out.adept = await verify(orchardWith({ 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc') }));
    out.rights = await verify(orchardWith({ 'META-INF/rights.xml': '<rights/>' }));
    out.lcp = await verify(orchardWith({ 'META-INF/license.lcpl': '{}' }));
    out.unreadable = await verify(orchardWith({ 'META-INF/encryption.xml': 'garbage' }));
    out.convertAdept = await E.convert(orchardWith({ 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc') }));
    const fonts = await E.convert(orchardWith({ 'META-INF/encryption.xml': encryption('http://www.idpf.org/2008/embedding') }));
    out.fonts = fonts.error ?? (await E.pages(fonts.bytes)).map((p) => p.text).join(' ').slice(0, 40);
    out.notes = await verify(new TextEncoder().encode('Just some text, not a book.'));
    out.word = await verify(E.epub({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' }, { mimetype: false }));
    out.tiny = await verify(new Uint8Array(3));
    out.empty = await verify(E.epub({
      'META-INF/container.xml': E.container('e.opf'),
      'e.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="x" href="x.xhtml" media-type="application/xhtml+xml"/></manifest><spine/></package>',
    }));
    out.onlySvg = await verify(E.epub({
      'META-INF/container.xml': E.container('e.opf'),
      'e.opf': '<package><manifest><item id="x" href="x.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="x"/></spine></package>',
      'x.svg': '<svg/>',
    }));
    out.garbageOpf = await verify(E.epub({ 'META-INF/container.xml': E.container('e.opf'), 'e.opf': 'this is not a package' }));
    out.noPackage = await verify(E.epub({ 'META-INF/container.xml': E.container('e.opf'), 'e.opf': '<other><item id="x" href="x.xhtml"/></other>', 'x.xhtml': '<html/>' }));
    // A zip whose names climb out of it is unreadable (as on Android 14).
    out.dotdot = await verify(E.epub({ ...E.epub2Files(), '../evil.xhtml': '<html/>' }));
    out.many = (await E.thrown(() => E.index.convertOffice('epub', { name: 'x.epub', bytes: orchardWith({ 'META-INF/rights.xml': '<rights/>' }) }))).manyKey;
    // A book whose documents show nothing.
    out.blank = await E.convert(E.oneChapter('<p> </p><div hidden="">x</div>', { toc: [] }));
    out.direct = await E.thrown(() => E.epubMod.convertEpub({ name: 'x.epub', bytes: orchardWith({ 'META-INF/rights.xml': '<rights/>' }) }));
    out.verifyDirect = await E.thrown(() => E.epubMod.verifyEpub({ name: 'x.epub', bytes: E.epub({ 'a.txt': 'x' }) }));
    return out;
  });
  check('books with DRM are refused', [r.adept, r.rights, r.lcp, r.unreadable].every((e) => e?.key === 'epub_protected'), [r.adept, r.rights, r.lcp, r.unreadable]);
  check('the DRM message for several books', r.many === 'epub_protected_many', r.many);
  check('converting a book with DRM gives the message too', r.convertAdept.error === 'epub_protected', r.convertAdept);
  check("fonts scrambled so they can't be copied aren't DRM", r.fonts.includes('Chapter One'), r.fonts);
  check('other files are not taken for books', [r.notes, r.word, r.tiny, r.garbageOpf, r.noPackage, r.dotdot].every((e) => e?.key === 'epub_not_recognized'), [r.notes, r.word, r.tiny, r.garbageOpf, r.noPackage, r.dotdot]);
  check('a package with nothing in its reading order', r.empty?.key === 'epub_empty' && r.onlySvg?.key === 'epub_empty', [r.empty, r.onlySvg]);
  check('a book whose documents show nothing', r.blank.error === 'epub_empty', r.blank);
  check('convertEpub and verifyEpub throw the problems', r.direct?.problem === 'protected' && r.verifyDirect?.problem === 'not-recognized', [r.direct, r.verifyDirect]);
}

async function progressAndCancel(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    const out = {};
    const seen = [];
    const done = await E.convert(E.epub2(), {}, { onProgress: (d, t, info) => seen.push([d, t, !!info?.compressing]) });
    out.seen = seen;
    out.pageCount = done.pageCount;
    // Cancelling after the second chapter; the same book converts afterwards.
    const controller = new AbortController();
    const book = E.epub2();
    out.cancelled = await E.thrown(() => E.index.convertOffice('epub', { name: 'c.epub', bytes: book }, {}, { signal: controller.signal, onProgress: (d) => { if (d >= 2) controller.abort(); } }));
    const again = await E.convert(book);
    out.again = again.pageCount;
    // Long books: more than 400 chapters, no table of contents: the chapters' headings become the bookmarks.
    const count = 405;
    const files = { 'META-INF/container.xml': E.container('long.opf') };
    let manifest = '';
    let spine = '';
    for (let i = 1; i <= count; i++) {
      files[`c${i}.xhtml`] = E.xhtml(`<h1>Part ${i}</h1><p>Text of part ${i}.</p>`);
      manifest += `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`;
      spine += `<itemref idref="c${i}"/>`;
    }
    files['long.opf'] = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Long</dc:title><dc:identifier id="id">x</dc:identifier></metadata>
      <manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
    let last = null;
    const t0 = performance.now();
    const long = await E.convert(E.epub(files), {}, { onProgress: (d, t, info) => { if (!info?.compressing) last = [d, t]; } });
    out.longMs = performance.now() - t0;
    out.long = { error: long.error, pages: long.pageCount, last, size: long.bytes?.length };
    const outline = await E.outline(long.bytes);
    out.long.bookmarks = [outline.length, outline[401]?.title, outline[401]?.page];
    const pdf = await E.pdfjs.openPdfJs(long.bytes);
    const p = await pdf.getPage(402);
    out.long.page402 = (await p.getTextContent()).items.map((i) => i.str).join(' ');
    await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
    return out;
  });
  const chapters = r.seen.filter((s) => !s[2]);
  check('progress counts chapters', JSON.stringify(chapters.map((s) => s[0])) === '[1,2,3]' && chapters.every((s) => s[1] === 3), r.seen);
  check('the last step is creating the PDF', r.seen[r.seen.length - 1][2] && r.seen[r.seen.length - 1][0] === r.pageCount, r.seen);
  check('cancelling stops the conversion', r.cancelled?.name === 'CancelledError', r.cancelled);
  check('the book converts again after cancelling', r.again >= 4, r.again);
  const L = r.long;
  check('a long book converts', !L.error && L.pages === 405 && L.last[0] === 405 && L.last[1] === 405, L);
  check("a long book's headings are its bookmarks", L.bookmarks[0] === 405 && L.bookmarks[1] === 'Part 402' && L.bookmarks[2] === 401, L.bookmarks);
  check('page 402 of the long book', L.page402.includes('Text of part 402'), L.page402);
  check('a long book is quick', r.longMs < 60000, r.longMs);
}

async function eastAsian(page) {
  const r = await page.evaluate(async () => {
    const E = window.E;
    // A Japanese novel written down the page, right to left, as Aozora Bunko books are, its lines
    // broken in the file; its margins are for columns. Laid out across, it fills the page.
    const text = '山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。意地を通せば窮屈だ。とかくに人の世は住みにくい。';
    const body = `<div class="main_text"><h2 class="o-midashi">一</h2><p>${text.split('。').join('。\n')}</p><p>${text.repeat(6)}</p></div>`;
    const css = 'html { -epub-writing-mode: vertical-rl; writing-mode: vertical-rl } .main_text { margin-left: 3em; margin-top: 2em } .o-midashi { margin-right: 4em }';
    const book = await E.convert(E.oneChapter(body, { css, title: '草枕', opfMeta: '<dc:language>ja</dc:language><dc:creator>夏目漱石</dc:creator>' }));
    if (book.error) return { error: book.error, cause: book.cause };
    const pages = await E.pages(book.bytes);
    const p = pages[0];
    const lines = E.lineEnds(p);
    return {
      text: p.text.replace(/ /g, ''),
      lines,
      info: await E.info(book.bytes),
      firstY: Math.min(...p.items.filter((i) => i.str.trim()).map((i) => i.y)),
      outline: await E.outline(book.bytes),
    };
  });
  check('the Japanese book converts', !r.error, r);
  check('lines broken in the file leave no spaces', r.text.includes('山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。'), r.text.slice(0, 80));
  const full = r.lines.filter((l) => l[1] > 360);
  check('the text runs across the page, filling the width', r.lines.length >= 6 && full.length >= 8, r.lines);
  // The space above the columns (2 em) becomes the space on the left of the lines; the space after them (3 em, on the left) goes below.
  check("the columns' margins are turned to suit lines across", r.lines.every((l) => near(l[0], 44 + 22, 1)), r.lines.slice(0, 4));
  check('the title and author in Japanese', r.info.title === '草枕' && r.info.author === '夏目漱石' && r.info.language === 'ja', r.info);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await withPage(async (page, url) => {
    await setup(page, url);
    await formats(page);
    await lenientXml(page);
    await reader(page);
    await orchard(page);
    await gardens(page);
    await layouts(page);
    await fixedLayouts(page);
    await anchorsAndOdds(page);
    await damaged(page);
    await refused(page);
    await progressAndCancel(page);
    await eastAsian(page);
  });
  const chromium = passed;
  // The same core in the other engines the site supports.
  for (const browser of ['firefox', 'webkit']) {
    await withPage(async (page, url) => {
      await setup(page, url);
      await formats(page);
      await lenientXml(page);
      await reader(page);
      await orchard(page);
      await gardens(page);
      await refused(page);
      await eastAsian(page);
    }, { browser });
  }
  console.log(`epub: ${chromium} checks in Chromium, ${passed - chromium} in Firefox and WebKit`);
}

await main();
