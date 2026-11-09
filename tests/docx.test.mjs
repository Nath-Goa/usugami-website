// Tests for Word to PDF (site/app/js/engine/office/docx.js and its docx-*.js helpers): the app's
// Word device tests (OfficeConverterDeviceTest.kt) ported, with the same small documents written
// here with fflate, plus links, tab leaders, first-page headers, colours, merged cells, list
// restarts, floating pictures, damaged files, cancelling and responsiveness. Every PDF is read back:
// page sizes, text and where it is (pdf.js), pictures and where they are drawn, links, and pixels.
import { withPage, assert, fixture, saveOutput } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail !== '' ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}
const near = (expected, actual, tolerance = 1.5) => typeof actual === 'number' && Math.abs(expected - actual) <= tolerance;

/** Loads the modules and the document builders into the page as window.D. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const at = (p) => import(base + 'app/js/' + p);
    const D = { base };
    D.index = await at('engine/office/index.js');
    D.docx = await at('engine/office/docx.js');
    D.styles = await at('engine/office/docx-styles.js');
    D.read = await at('engine/office/docx-read.js');
    D.ox = await at('engine/office/ooxml.js');
    D.fflate = await at('lib/fflate.js');
    D.pdfjs = await at('lib/pdfjs.js');
    D.lib = await at('lib/pdf-lib.js');

    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
    D.EMU = 12700;
    D.W = W;
    D.PICTURE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    D.GROUP_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
    D.SHAPE_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
    D.NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
      `xmlns:pic="${D.PICTURE_URI}" xmlns:wps="${D.SHAPE_URI}" xmlns:wpg="${D.GROUP_URI}" xmlns:v="urn:schemas-microsoft-com:vml" ` +
      'xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
    const enc = new TextEncoder();
    const u8 = (s) => (typeof s === 'string' ? enc.encode(s) : s);
    D.zip = (files) => {
      const entries = {};
      for (const [name, v] of Object.entries(files)) entries[name] = [u8(v), { level: 6 }];
      return D.fflate.zipSync(entries);
    };
    /** Relationships rId1, rId2... of [type, target, external?]. */
    D.rels = (...rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">` +
      rels.map(([type, target, external], i) => `<Relationship Id="rId${i + 1}" Type="${R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('') +
      '</Relationships>';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    D.para = (text, props = '', run = '') => `<w:p><w:pPr>${props}</w:pPr><w:r><w:rPr>${run}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
    D.listItem = (text, numId, level) => D.para(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
    /** numId 1 is numbered (1., then a.), numId 2 bulleted. */
    D.listNumbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}">
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      </w:numbering>`;
    D.stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
      <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
        <w:pPr><w:keepNext/><w:spacing w:before="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F3864"/></w:rPr></w:style>
      </w:styles>`;
    // A 300 × 200 picture: steel blue with a yellow circle, as the app's test draws it.
    D.png = async (w = 300, h = 200, color = 'rgb(70,130,180)') => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(255,255,0)';
      ctx.beginPath();
      ctx.arc(w * 0.7, h * 0.35, h * 0.2, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    };
    D.picturePng = await D.png();
    /**
     * A document with `body` (US Letter with one-inch margins when it has no section properties),
     * the styles and numbering above unless given, and `parts` linked from it by `rels`, whose ids
     * go on from rId4 (rId2 is the picture).
     */
    D.word = (body, { numbering = D.listNumbering, rels = [], parts = {}, styles = D.stylesXml } = {}) => D.zip({
      '[Content_Types].xml': types,
      '_rels/.rels': D.rels(['officeDocument', 'word/document.xml']),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${D.NS}><w:body>${body}</w:body></w:document>`,
      'word/_rels/document.xml.rels': D.rels(['styles', 'styles.xml'], ['image', 'media/picture.png'], ['numbering', 'numbering.xml'], ...rels),
      'word/styles.xml': styles,
      'word/numbering.xml': numbering,
      'word/media/picture.png': D.picturePng,
      ...parts,
    });
    /** A picture `w` × `h` points (pic:pic) from relationship `rel`, at (x, y) in a group. */
    D.picture = (w, h, { rel = 'rId2', x = 0, y = 0, xfrm = '', fill = '', hidden = false } = {}) =>
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="9" name="p"${hidden ? ' hidden="1"' : ''}/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${rel}"/>${fill}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm${xfrm}><a:off x="${x * D.EMU}" y="${y * D.EMU}"/><a:ext cx="${w * D.EMU}" cy="${h * D.EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`;
    D.inlineDrawing = (w, h, graphic, docPr = '', uri = D.PICTURE_URI) =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="${w * D.EMU}" cy="${h * D.EMU}"/><wp:docPr id="1" name="Drawing"${docPr}/>
      <a:graphic><a:graphicData uri="${uri}">${graphic}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    D.anchor = (w, h, graphic, { h: ph = '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>',
      v: pv = '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>', wrap = '<wp:wrapSquare wrapText="bothSides"/>',
      behind = 0, docPr = '', uri = D.PICTURE_URI } = {}) =>
      `<w:r><w:drawing><wp:anchor behindDoc="${behind}" simplePos="0" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">
      <wp:simplePos x="0" y="0"/>${ph}${pv}<wp:extent cx="${w * D.EMU}" cy="${h * D.EMU}"/>${wrap}<wp:docPr id="3" name="Float"${docPr}/>
      <a:graphic><a:graphicData uri="${uri}">${graphic}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
    D.defaultBody = () => {
      let b = D.para('Quarterly notes', '<w:pStyle w:val="Heading1"/>');
      b += D.para("Plain body text, in the document's own font.");
      b += D.listItem('First step', 1, 0) + D.listItem('Second step', 1, 0) + D.listItem('A detail', 1, 1) + D.listItem('A bullet', 2, 0);
      // A picture 150 × 100 points, in its own centred paragraph.
      b += `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="1270000"/><wp:docPr id="1" name="Picture 1"/>
        <a:graphic><a:graphicData uri="${D.PICTURE_URI}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>
        <pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
      const border = 'w:val="single" w:sz="4" w:color="000000"';
      b += `<w:tbl><w:tblPr><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders></w:tblPr>
        <w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="2000"/></w:tblGrid>`;
      b += `<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${D.para('Item name')}</w:tc><w:tc>${D.para('Amount')}</w:tc></w:tr>`;
      for (let row = 1; row <= 70; row++) b += `<w:tr><w:tc>${D.para(`Row ${row}`)}</w:tc><w:tc>${D.para(String(row * 3))}</w:tc></w:tr>`;
      b += '</w:tbl>';
      b += '<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>After the break</w:t></w:r></w:p>';
      // The first section, A5 portrait, ends with this paragraph; the last one is A5 landscape.
      const margins = '<w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720" w:header="360" w:footer="360"/>';
      b += `<w:p><w:pPr><w:sectPr><w:pgSz w:w="8391" w:h="11906"/>${margins}</w:sectPr></w:pPr></w:p>`;
      b += D.para('Wide page');
      b += `<w:sectPr><w:pgSz w:w="11906" w:h="8391" w:orient="landscape"/>${margins}</w:sectPr>`;
      return b;
    };

    D.kept = {};
    /** Converts with convertOffice: { name, bytes, pageCount, progress } or { error: { name, key, manyKey } }. */
    D.convert = async (bytes, options = {}, hooks = {}) => {
      const progress = [];
      try {
        const out = await D.index.convertOffice('word', { name: 'notes.docx', bytes }, options, {
          ...hooks,
          onProgress: (done, total, info) => { progress.push([done, total, !!info?.compressing]); hooks.onProgress?.(done, total, info); },
        });
        if (options.keep) D.kept[options.keep] = out.bytes;
        return { ...out, progress };
      } catch (e) {
        return { error: { name: e?.name, key: e?.key ?? null, manyKey: e?.manyKey ?? null, message: String(e?.message), cause: String(e?.cause?.stack ?? e?.cause ?? '') }, progress };
      }
    };
    D.open = (bytes) => D.pdfjs.pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true, isEvalSupported: false, useWorkerFetch: true,
      cMapUrl: new URL('app/vendor/pdfjs/cmaps/', base).href, cMapPacked: true, standardFontDataUrl: new URL('app/vendor/pdfjs/standard_fonts/', base).href }).promise;
    const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    /**
     * Everything about each page: size, text (as PDFTextStripper gives it, with runs of spaces as
     * one), text items { str, x, y (baseline from the top), w, size, font }, pictures { left, top,
     * right, bottom, width, height, mirrored } (from their transforms, in points from the top left),
     * links { url, dest, left, top, right, bottom }; and the named destinations { name: { page, top } }.
     */
    D.info = async (bytes) => {
      const pdf = await D.open(bytes);
      const OPS = D.pdfjs.pdfjsLib.OPS;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n);
        const [x0, y0, x1, y1] = p.view;
        const width = x1 - x0;
        const height = y1 - y0;
        const ops = await p.getOperatorList();
        const tc = await p.getTextContent();
        const items = tc.items.filter((i) => i.str !== '').map((i) => {
          let font = null;
          try { font = p.commonObjs.get(i.fontName)?.name ?? null; } catch { font = null; }
          return { str: i.str, x: i.transform[4], y: height - i.transform[5], w: i.width, size: Math.hypot(i.transform[2], i.transform[3]), font };
        });
        const images = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        for (let k = 0; k < ops.fnArray.length; k++) {
          const fn = ops.fnArray[k];
          const args = ops.argsArray[k];
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
          else if (fn === OPS.transform) ctm = mul(args, ctm);
          else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(Array.from(args[0]), ctm); }
          else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
          else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
            const corner = (u, v) => [u * ctm[0] + v * ctm[2] + ctm[4], height - (u * ctm[1] + v * ctm[3] + ctm[5])];
            const cs = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
            const xs = cs.map((c) => c[0]);
            const ys = cs.map((c) => c[1]);
            const b = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
            images.push({ ...b, width: b.right - b.left, height: b.bottom - b.top, mirrored: cs[1][0] < cs[0][0] });
          }
        }
        const links = (await p.getAnnotations()).filter((a) => a.subtype === 'Link').map((a) => ({
          url: a.url ?? null, dest: a.dest ?? null, left: a.rect[0], right: a.rect[2], top: height - a.rect[3], bottom: height - a.rect[1],
        }));
        const text = tc.items.map((i) => i.str + (i.hasEOL ? ' ' : '')).join(' ').replace(/\s+/g, ' ').trim();
        pages.push({ width, height, text, items, images, links });
      }
      // The named destinations the links go to.
      const dests = {};
      for (const name of new Set(pages.flatMap((p) => p.links.map((l) => l.dest)).filter((d) => typeof d === 'string'))) {
        const d = await pdf.getDestination(name);
        if (!d) continue;
        const pageIndex = await pdf.getPageIndex(d[0]);
        dests[name] = { page: pageIndex, top: pages[pageIndex].height - (d[3] ?? 0) };
      }
      await (pdf.destroy ? pdf.destroy() : pdf.loadingTask.destroy());
      return { pages, dests };
    };
    /** Renders page n: px(x, y) is [r, g, b] at (x, y) points from the top left. */
    D.render = async (bytes, n = 1, scale = 3) => {
      const pdf = await D.open(bytes);
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
        const i = (Math.round(y * scale) * canvas.width + Math.round(x * scale)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      return { px, scale, width: canvas.width, height: canvas.height };
    };
    D.isColor = (c, rgb, tol = 60) => c.every((v, i) => Math.abs(v - rgb[i]) < tol);
    /** The first text item on a page whose text contains `word`. */
    D.item = (page, word) => page.items.find((i) => i.str.includes(word)) ?? null;
    window.D = D;
  }, url);
}

// ---------------------------------------------------------------------------------------------
// The app's device tests

async function appWordTests(page, report) {
  // wordKeepsPageSizesTextListsTablesAndPictures
  let r = await page.evaluate(async () => {
    const { D } = window;
    const out = await D.convert(D.word(D.defaultBody()), { keep: 'notes' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    return { pageCount: out.pageCount, pages: info.pages.map((p) => ({ width: p.width, height: p.height, text: p.text, images: p.images })) };
  });
  check('notes: converts', !r.error, r.error);
  const notes = r.pages;
  check('notes: the table runs over several pages', notes.length >= 4, notes.length);
  notes.forEach((p, i) => {
    if (i < notes.length - 1) check(`notes: page ${i + 1} is A5`, near(419.55, p.width) && near(595.3, p.height), [p.width, p.height]);
    else check('notes: the last section is landscape', near(595.3, p.width) && near(419.55, p.height), [p.width, p.height]);
  });
  check('notes: one picture on page 1', notes[0].images.length === 1, notes[0].images);
  const pic = notes[0].images[0];
  check('notes: picture 150 × 100, centred between the margins', near(150, pic.width) && near(100, pic.height) && near(419.55 / 2, (pic.left + pic.right) / 2, 2), pic);
  const all = notes.map((p) => p.text).join('\n');
  check('notes: body text', all.includes("Plain body text, in the document's own font."));
  check('notes: numbered list', /1\.\s*First step/.test(all) && /2\.\s*Second step/.test(all), all.slice(0, 300));
  check('notes: second level', /a\.\s*A detail/.test(all));
  check('notes: bullet', /•\s*A bullet/.test(all));
  const rows = [...all.matchAll(/Row (\d+)/g)].map((m) => Number(m[1]));
  check('notes: every row once, in order', rows.length === 70 && rows.every((v, i) => v === i + 1), rows);
  notes.filter((p) => p.text.includes('Row ')).forEach((p, i) => check(`notes: header row repeated (${i + 1})`, p.text.includes('Item name')));
  const afterBreak = notes.findIndex((p) => p.text.includes('After the break'));
  check('notes: the page break starts a new page', afterBreak > 0 && !notes[afterBreak].text.includes('Row '));
  check('notes: the landscape section starts another', notes.findIndex((p) => p.text.includes('Wide page')) === notes.length - 1 && afterBreak < notes.length - 1);

  // wordHeadingsAreBoldAndLarger
  r = await page.evaluate(async () => {
    const { D } = window;
    const out = await D.convert(D.word(D.defaultBody()));
    const info = await D.info(out.bytes);
    return { heading: D.item(info.pages[0], 'Quarterly'), body: D.item(info.pages[0], 'Plain') };
  });
  check('headings: 18 points', near(18, r.heading?.size, 0.5), r.heading);
  check('headings: body 11 points', near(11, r.body?.size, 0.5), r.body);
  check('headings: heading bold', /Bold/.test(r.heading?.font ?? ''), r.heading?.font);
  check('headings: body not bold', !/Bold/.test(r.body?.font ?? 'Bold'), r.body?.font);
  check('headings: Times New Roman becomes the serif font', /NotoSerif/.test(r.body?.font ?? ''), r.body?.font);

  // wordReportFixture
  r = await page.evaluate(async (b64) => {
    const { D } = window;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out = await D.convert(bytes, { name: 'Garden report' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    // The pictures in the PDF: how they're stored.
    const doc = await D.lib.PDFDocument.load(out.bytes);
    const xobjects = [];
    const fonts = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj?.dict ?? obj;
      const get = (k) => dict?.get?.(D.lib.PDFName.of(k));
      if (get('Subtype')?.toString() === '/Image') xobjects.push({ width: get('Width')?.asNumber(), height: get('Height')?.asNumber(), filter: get('Filter')?.toString() ?? null });
      if (get('Type')?.toString() === '/Font' && get('BaseFont')) fonts.push(get('BaseFont').toString());
      if (get('Type')?.toString() === '/FontDescriptor') {
        const file = get('FontFile2') ?? get('FontFile3') ?? get('FontFile');
        if (file) fonts.push(`file:${doc.context.lookup(file).contents.length}`);
      }
    }
    return {
      name: out.name, pageCount: out.pageCount, size: out.bytes.length, progress: out.progress, xobjects, fonts,
      pages: info.pages.map((p) => ({ width: p.width, height: p.height, text: p.text, images: p.images.length, links: p.links, link: D.item(p, 'riverside-garden.example') })),
    };
  }, report.toString('base64'));
  check('report: converts', !r.error, r.error);
  check('report: named as typed', r.name === 'Garden report.pdf', r.name);
  check('report: five pages', r.pageCount === 5 && r.pages.length === 5, r.pageCount);
  const drawn = [...new Set(r.progress.filter((p) => !p[2]).map((p) => p[0]))];
  check('report: progress counts the pages', JSON.stringify(drawn) === '[1,2,3,4,5]', r.progress);
  check('report: progress has no total until the end', r.progress.filter((p) => !p[2]).every((p) => p[1] === null), r.progress);
  check('report: then compressing', JSON.stringify(r.progress[r.progress.length - 1]) === '[5,5,true]', r.progress);
  check('report: A4', near(595.3, r.pages[0].width) && near(841.9, r.pages[0].height));
  check('report: then landscape', near(841.9, r.pages[4].width) && near(595.3, r.pages[4].height));
  check('report: the garden picture', r.pages[0].images === 1, r.pages[0].images);
  check('report: title', r.pages[0].text.includes('Riverside Community Garden'));
  check('report: bold text', r.pages[0].text.includes('Forty-two members'));
  check('report: link text', r.pages[0].text.includes('riverside-garden.example'));
  check('report: footer page numbers', r.pages[0].text.includes('Page 1') && r.pages[4].text.includes('Page 5'));
  check('report: header on every page', r.pages.every((p) => p.text.includes('Annual report')));
  check('report: table text', r.pages.some((p) => p.text.includes('Strawberries') && p.text.includes('Mostly eaten on the spot')));
  check('report: watering rota on the landscape page', r.pages[4].text.includes('Watering rota'));
  const link = r.pages[0].links[0];
  check('report: the link is clickable', r.pages[0].links.length === 1 && link.url === 'https://riverside-garden.example/', r.pages[0].links);
  const line = r.pages[0].link;
  // Over the link's words only, on their line: after "More about the garden on ", before the full stop.
  check('report: over its text', link && line && link.top < line.y && link.bottom > line.y && link.left > line.x + 120 && link.right < line.x + line.w - 1 && link.right - link.left > 110, [link, line]);
  check('report: the picture is a JPEG no bigger than 150 dpi', r.xobjects.length === 1 && r.xobjects[0].filter === '/DCTDecode' && r.xobjects[0].width <= 675 && r.xobjects[0].height <= 450, r.xobjects);
  check('report: fonts are subsets', r.fonts.filter((f) => f.startsWith('/')).every((f) => /^\/[A-Z]{6}\+/.test(f)), r.fonts);
  check('report: only the letters used are embedded', r.fonts.filter((f) => f.startsWith('file:')).every((f) => Number(f.slice(5)) < 60000), r.fonts);
  check('report: small', r.size < 120000, r.size);

  // wordHeaderPicturesBehindTheTextTakeNoRoom
  r = await page.evaluate(async () => {
    const { D } = window;
    const letterhead = D.anchor(612, 792, D.picture(612, 792, { rel: 'rId1' }), {
      h: '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>',
      v: '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>', wrap: '<wp:wrapNone/>', behind: 1,
    });
    const watermark = `<w:r><w:pict><v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" path="m@4@5l@4@11@9@11@9@5xe"/>
      <v:shape id="WordPictureWatermark" o:spid="_x0000_s2049" type="#_x0000_t75"
        style="position:absolute;margin-left:0;margin-top:0;width:451.2pt;height:338.4pt;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin">
      <v:imagedata r:id="rId1" o:title="mark" gain="19661f" blacklevel="22938f"/></v:shape></w:pict></w:r>`;
    const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${D.NS}><w:p>${letterhead}${watermark}<w:r><w:t>Letterhead text</w:t></w:r></w:p></w:hdr>`;
    let body = '';
    for (let i = 1; i <= 40; i++) body += D.para(`Line ${i}`);
    body += '<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720"/></w:sectPr>';
    const out = await D.convert(D.word(body, { rels: [['header', 'header1.xml']], parts: { 'word/header1.xml': header, 'word/_rels/header1.xml.rels': D.rels(['image', 'media/picture.png']) } }), { keep: 'letterhead' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 2);
    return { texts: info.pages.map((p) => p.text), line1: D.item(info.pages[0], 'Line 1'), images: info.pages[0].images, outside: img.px(20, 20), veiled: img.px(150, 300) };
  });
  check('letterhead: converts', !r.error, r.error);
  check('letterhead: forty short lines fill two pages', r.texts.length === 2, r.texts.length);
  check('letterhead: header and body on page 1', r.texts[0].includes('Letterhead text') && r.texts[0].includes('Line 1 '));
  check('letterhead: the rest on page 2', r.texts[1].includes('Line 40'));
  check('letterhead: the body starts below the header, inside the margins', r.line1 && r.line1.y > 72 && r.line1.y < 140, r.line1);
  check('letterhead: two pictures', r.images.length === 2, r.images);
  const full = r.images.find((i) => i.width > 600);
  const mark = r.images.find((i) => i.width < 600);
  check('letterhead: over the whole page', full && near(0, full.left) && near(0, full.top) && near(612, full.right) && near(792, full.bottom), full);
  check('letterhead: watermark its own size', mark && near(451.2, mark.width) && near(338.4, mark.height), mark);
  check('letterhead: watermark in the middle of the margins', mark && near(306, (mark.left + mark.right) / 2) && near(396, (mark.top + mark.bottom) / 2), mark);
  check('letterhead: the letterhead is drawn', r.outside[2] > 140 && r.outside[0] < 110, r.outside);
  check('letterhead: the watermark is washed out', r.veiled[0] > 170 && r.veiled[0] < 235, r.veiled);

  // wordOldDrawingCanvasesStayInTheText
  r = await page.evaluate(async () => {
    const { D } = window;
    const canvas = `<w:r><w:pict><v:group id="Canvas" editas="canvas" coordorigin="1800,1440" coordsize="6000,3000"
        style="width:300pt;height:150pt;mso-position-horizontal-relative:char;mso-position-vertical-relative:line">
      <v:shape id="Screenshot" type="#_x0000_t75" style="position:absolute;left:3600;top:3000;width:2000;height:1500">
      <v:imagedata r:id="rId2" o:title="screenshot"/></v:shape></v:group></w:pict></w:r>`;
    const out = await D.convert(D.word(D.para('Before the canvas') + `<w:p>${canvas}</w:p>` + D.para('After the canvas')));
    const info = await D.info(out.bytes);
    return { images: info.pages[0].images, after: D.item(info.pages[0], 'After') };
  });
  check('canvas: one picture 300 × 150', r.images.length === 1 && near(300, r.images[0].width) && near(150, r.images[0].height), r.images);
  check('canvas: at the margin', near(72, r.images[0].left), r.images[0]);
  check('canvas: in the text, taking its room', r.after && r.after.y > r.images[0].bottom, [r.after, r.images[0]]);

  // wordPicturesTurnFlipAndKeepTheirShapeInCells
  r = await page.evaluate(async () => {
    const { D } = window;
    const turned = D.inlineDrawing(150, 100, D.picture(150, 100, { xfrm: ' rot="5400000"' }));
    const flipped = D.inlineDrawing(150, 100, D.picture(150, 100, { xfrm: ' flipH="1"' }));
    const floating = D.anchor(300, 200, D.picture(300, 200));
    const body = `<w:p>${turned}</w:p><w:p>${flipped}</w:p>
      <w:tbl><w:tblPr><w:tblW w:w="2000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr><w:tc><w:p>${floating}<w:r><w:t>In a cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const out = await D.convert(D.word(body), { keep: 'turned' });
    const info = await D.info(out.bytes);
    return info.pages[0].images.sort((a, b) => a.top - b.top);
  });
  check('turned: three pictures', r.length === 3, r);
  check('turned: a quarter turn stands up', near(100, r[0].width) && near(150, r[0].height), r[0]);
  check('turned: mirrored keeps its size', near(150, r[1].width) && near(100, r[1].height), r[1]);
  check('turned: drawn mirrored', r[1].mirrored, r[1]);
  check('turned: shrunk in its cell, not squashed', r[2].width <= 100 && near(1.5, r[2].width / r[2].height, 0.05), r[2]);

  // wordGroupsDrawEachPictureInItsPlace
  r = await page.evaluate(async () => {
    const { D } = window;
    const group = `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${300 * D.EMU}" cy="${100 * D.EMU}"/>
      <a:chOff x="0" y="0"/><a:chExt cx="${300 * D.EMU}" cy="${100 * D.EMU}"/></a:xfrm></wpg:grpSpPr>
      ${D.picture(150, 100)}${D.picture(150, 100, { x: 150, fill: '<a:srcRect l="25000" r="25000"/>' })}${D.picture(100, 100, { x: 100, hidden: true })}</wpg:wgp>`;
    const out = await D.convert(D.word(`<w:p>${D.inlineDrawing(300, 100, group, '', D.GROUP_URI)}</w:p>`));
    const info = await D.info(out.bytes);
    const images = info.pages[0].images.sort((a, b) => a.left - b.left);
    const img = await D.render(out.bytes, 1, 2);
    const top = images[0].top;
    // Across the pictures at the height of the circle's middle: yellow where each circle is.
    const row = [];
    for (let x = 60; x <= 390; x += 1) row.push(img.px(x, top + 35));
    const yellow = row.map((c, i) => (c[0] > 200 && c[1] > 200 && c[2] < 90 ? 60 + i : null)).filter((x) => x != null);
    const painted = row.map((c, i) => (c[0] + c[1] + c[2] < 720 ? 60 + i : null)).filter((x) => x != null);
    return { count: images.length, first: images[0], yellow, painted };
  });
  check('group: two pictures (the hidden one left out)', r.count === 2, r.count);
  check('group: the first in place', near(72, r.first.left) && near(150, r.first.width) && near(100, r.first.height), r.first);
  check('group: drawn from the margin to 300 points on', near(72, Math.min(...r.painted), 2) && near(372, Math.max(...r.painted), 2), [Math.min(...r.painted), Math.max(...r.painted)]);
  const yellowLeft = r.yellow.filter((x) => x < 222);
  const yellowRight = r.yellow.filter((x) => x >= 222);
  check('group: the first circle where it is in the picture', yellowLeft.length && near(177, (Math.min(...yellowLeft) + Math.max(...yellowLeft)) / 2, 3), yellowLeft);
  // Cropped to the middle half, the circle (at 70% across, a fifth of the height wide) is at 357 and
  // cut off by the picture's right edge at 372.
  check('group: the second cropped, its circle further right', yellowRight.length && near(317, Math.min(...yellowRight), 3) && near(372, Math.max(...yellowRight), 2), [Math.min(...yellowRight), Math.max(...yellowRight)]);

  // wordLeavesOutWhatTheAuthorHid
  r = await page.evaluate(async () => {
    const { D } = window;
    const hiddenPicture = D.inlineDrawing(150, 100, D.picture(150, 100), ' hidden="1"');
    const shownPicture = D.inlineDrawing(150, 100, D.picture(150, 100));
    const hiddenBox = D.anchor(200, 50, `<wps:wsp><wps:cNvSpPr txBox="1"/>
      <wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${200 * D.EMU}" cy="${50 * D.EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>
      <wps:txbx><w:txbxContent>${D.para('Secret note')}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`, { wrap: '<wp:wrapNone/>', docPr: ' hidden="1"', uri: D.SHAPE_URI });
    const body = `<w:p>${hiddenPicture}</w:p><w:p>${shownPicture}</w:p><w:p>${hiddenBox}<w:r><w:t>Visible text</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden run</w:t></w:r><w:r><w:t>Shown run</w:t></w:r></w:p>`;
    const out = await D.convert(D.word(body));
    const info = await D.info(out.bytes);
    return { text: info.pages.map((p) => p.text).join(' '), images: info.pages[0].images.length };
  });
  check('hidden: visible text', r.text.includes('Visible text') && r.text.includes('Shown run'));
  check('hidden: hidden text box and run left out', !r.text.includes('Secret note') && !r.text.includes('Hidden run'), r.text);
  check('hidden: only the picture not hidden', r.images === 1, r.images);

  // wordPageNumbersFollowTheirFormatAndOddPageSections
  r = await page.evaluate(async () => {
    const { D } = window;
    const footer = (field) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${D.NS}><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${field}</w:p></w:ftr>`;
    const complexField = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const romanField = '<w:fldSimple w:instr=" PAGE \\* ROMAN \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple>';
    const body = D.para('Preface') + '<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Preface continued</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgNumType w:fmt="lowerRoman" w:start="1"/></w:sectPr></w:pPr></w:p>' +
      D.para('Chapter one') + '<w:p><w:pPr><w:sectPr><w:pgNumType w:start="1"/></w:sectPr></w:pPr></w:p>' +
      D.para('Chapter two') + '<w:sectPr><w:footerReference w:type="default" r:id="rId5"/><w:type w:val="oddPage"/></w:sectPr>';
    const out = await D.convert(D.word(body, { rels: [['footer', 'footer1.xml'], ['footer', 'footer2.xml']], parts: { 'word/footer1.xml': footer(complexField), 'word/footer2.xml': footer(romanField) } }));
    const info = await D.info(out.bytes);
    return info.pages.map((p) => p.text);
  });
  check('page numbers: formats and restarts', JSON.stringify(r.map((t) => /Page (\S+)/.exec(t)?.[1] ?? null)) === JSON.stringify(['i', 'ii', '1', '2', 'III']), r);
  check('page numbers: chapter one', r[2].includes('Chapter one'));
  check('page numbers: the blank page', !r[3].includes('Chapter'));
  check('page numbers: chapter two on an odd page', r[4].includes('Chapter two'));

  // wordEvenPagesHaveTheirOwnHeaders
  r = await page.evaluate(async () => {
    const { D } = window;
    const header = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${D.NS}>${D.para(text)}</w:hdr>`;
    const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    const body = D.para('One') + pageBreak + D.para('Two') + pageBreak + D.para('Three') +
      '<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:headerReference w:type="even" r:id="rId5"/></w:sectPr>';
    const out = await D.convert(D.word(body, {
      rels: [['header', 'header1.xml'], ['header', 'header2.xml'], ['settings', 'settings.xml']],
      parts: {
        'word/header1.xml': header('Right-hand header'), 'word/header2.xml': header('Left-hand header'),
        'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${D.W}"><w:evenAndOddHeaders/></w:settings>`,
      },
    }));
    return (await D.info(out.bytes)).pages.map((p) => /(\S+)-hand header/.exec(p.text)?.[1] ?? null);
  });
  check('even pages: their own headers', JSON.stringify(r) === '["Right","Left","Right"]', r);

  // wordRightAndCentreTabStopsPlaceTheTextAfterThem
  for (const indent of ['', '<w:ind w:firstLine="720"/>']) {
    r = await page.evaluate(async (indent) => {
      const { D } = window;
      const tabs = '<w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs>';
      const header = `<w:p><w:pPr>${tabs}${indent}</w:pPr><w:r><w:t>Report</w:t><w:tab/><w:t>Middle</w:t><w:tab/><w:t xml:space="preserve">Page 1</w:t></w:r></w:p>`;
      const out = await D.convert(D.word(header));
      const info = await D.info(out.bytes);
      return info.pages[0].items;
    }, indent);
    const lines = new Set(r.map((i) => Math.round(i.y)));
    check(`tabs${indent ? ' (indented)' : ''}: all on one line`, lines.size === 1, r);
    const middle = r.find((i) => i.str.includes('Middle'));
    const mx = middle.x + (middle.w * (middle.str.indexOf('Middle') + 3)) / middle.str.length;
    check(`tabs${indent ? ' (indented)' : ''}: centred on the centre stop`, near(72 + 234, mx, 2), middle);
    const last = r[r.length - 1];
    check(`tabs${indent ? ' (indented)' : ''}: ending at the right stop`, near(72 + 468, last.x + last.w, 2), last);
  }

  // wordPageNumbersInTheTextAreTheirOwnPages
  r = await page.evaluate(async () => {
    const { D } = window;
    const field = '<w:fldSimple w:instr=" PAGE "><w:r><w:t>9</w:t></w:r></w:fldSimple>';
    const body = `<w:p><w:r><w:t xml:space="preserve">Opening page </w:t></w:r>${field}</w:p><w:p><w:pPr><w:sectPr/></w:pPr></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">Restarted page </w:t></w:r>${field}</w:p><w:sectPr><w:pgNumType w:start="5"/></w:sectPr>`;
    return (await D.info((await D.convert(D.word(body))).bytes)).pages.map((p) => p.text);
  });
  check('page fields: their own page', r[0].includes('Opening page 1'), r[0]);
  check('page fields: restarted', r[1].includes('Restarted page 5'), r[1]);

  // wordBodyKeptInAnotherFormatIsRefused
  r = await page.evaluate(async () => {
    const { D } = window;
    const bytes = D.word('<w:altChunk r:id="rId4"/><w:sectPr/>', { rels: [['aFChunk', 'afchunk.htm']], parts: { 'word/afchunk.htm': '<html><body><p>Hello chunk</p></body></html>' } });
    return D.convert(bytes);
  });
  check('alt chunk: refused with the app\'s message', r.error?.key === 'office_embedded_content' && r.error?.manyKey === 'office_embedded_content_many', r.error);

  // wordKeepsPhoneticGuidesSymbolsAndPageBreaksInLists
  r = await page.evaluate(async () => {
    const { D } = window;
    const ruby = `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>reading</w:t></w:r></w:rt>
      <w:rubyBase><w:r><w:t>BaseWord</w:t></w:r></w:rubyBase></w:ruby></w:r><w:r><w:t xml:space="preserve"> After</w:t></w:r></w:p>`;
    const symbols = `<w:p><w:r><w:t xml:space="preserve">Width 5 </w:t></w:r><w:r><w:sym w:font="Symbol" w:char="F06D"/></w:r><w:r><w:t xml:space="preserve">m </w:t></w:r>
      <w:r><w:sym w:font="Symbol" w:char="F0B1"/></w:r><w:r><w:t xml:space="preserve"> 2</w:t></w:r></w:p>`;
    const methods = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:br w:type="page"/></w:r><w:r><w:t>Methods</w:t></w:r></w:p>';
    const body = ruby + symbols + D.listItem('Introduction', 1, 0) + methods + D.listItem('Results', 1, 0);
    return (await D.info((await D.convert(D.word(body))).bytes)).pages.map((p) => p.text);
  });
  check('ruby: two pages', r.length === 2, r);
  check('ruby: the text without its guide', r[0].includes('Before BaseWord After') && !r[0].includes('reading'), r[0]);
  check('symbols: Symbol font characters', r[0].includes('Width 5 μm ± 2'), r[0]);
  check('lists: numbered', /1\.\s*Introduction/.test(r[0]), r[0]);
  check('lists: a numbered paragraph starting with a page break keeps its number', /2\.\s*Methods/.test(r[1]) && /3\.\s*Results/.test(r[1]), r[1]);

  // wordListsThroughAListStyleKeepTheirNumbers
  r = await page.evaluate(async () => {
    const { D } = window;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${D.W}">
      <w:abstractNum w:abstractNumId="0"><w:styleLink w:val="CurrentList1"/>
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="CurrentList1"/></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const info = await D.info((await D.convert(D.word(D.listItem('First clause', 2, 0) + D.listItem('Second clause', 2, 0), { numbering }))).bytes);
    return { text: info.pages[0].text, first: D.item(info.pages[0], 'First') };
  });
  check('list style: numbered', /1\.\s*First clause/.test(r.text) && /2\.\s*Second clause/.test(r.text), r.text);
  check('list style: text at the level\'s indent', near(72 + 36, r.first?.x), r.first);

  // wordLegalNumberingWritesEveryLevelInArabic
  r = await page.evaluate(async () => {
    const { D } = window;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${D.W}"><w:abstractNum w:abstractNumId="0">
      <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="Article %1"/><w:suff w:val="space"/></w:lvl>
      <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="Section %1.%2"/><w:suff w:val="space"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const body = D.listItem('Terms', 1, 0) + D.listItem('Scope', 1, 1) + D.listItem('Payment', 1, 0) + D.listItem('Fees', 1, 1);
    return (await D.info((await D.convert(D.word(body, { numbering }))).bytes)).pages[0].text;
  });
  check('legal numbering: every level in arabic', r.includes('Article I Terms Section 1.1 Scope Article II Payment Section 2.1 Fees'), r);

  // wordAutomaticTextIsWhiteOnDarkShading
  r = await page.evaluate(async () => {
    const { D } = window;
    const navy = '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F3864"/></w:tcPr>';
    const body = `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>
      <w:tc>${navy}${D.para('Header')}</w:tc><w:tc>${navy}${D.para('Control', '', '<w:color w:val="000000"/>')}</w:tc></w:tr></w:tbl>`;
    const out = await D.convert(D.word(body));
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 3);
    const light = (word) => {
      const g = D.item(info.pages[0], word);
      let count = 0;
      for (let x = g.x; x < g.x + 30; x += 1 / 3) for (let y = g.y - 6; y < g.y - 1; y += 1 / 3) {
        const c = img.px(x, y);
        if (c[0] > 200 && c[1] > 200 && c[2] > 200) count++;
      }
      return count;
    };
    return { header: light('Header'), control: light('Control'), shade: img.px(D.item(info.pages[0], 'Header').x - 3, D.item(info.pages[0], 'Header').y - 4) };
  });
  check('auto colour: white on dark shading', r.header > 20, r.header);
  check('auto colour: black text stays black', r.control === 0, r.control);
  check('auto colour: the cell is shaded', D_near(r.shade, [0x1f, 0x38, 0x64]), r.shade);

  // wordRightToLeftListsAndTablesAreMirrored
  r = await page.evaluate(async () => {
    const { D } = window;
    const list = `<w:p><w:pPr><w:bidi/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
      <w:r><w:rPr><w:rtl/></w:rPr><w:t>שלום עולם</w:t></w:r></w:p>`;
    const table = `<w:tbl><w:tblPr><w:bidiVisual/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
      <w:tr><w:tc>${D.para('Alpha')}</w:tc><w:tc>${D.para('Beta')}</w:tc></w:tr></w:tbl>`;
    const info = await D.info((await D.convert(D.word(list + table), { keep: 'rtl' })).bytes);
    const items = info.pages[0].items;
    const hebrew = items.filter((i) => /[א-ת]/.test(i.str));
    return { number: items.find((i) => /^\.?1\.?$/.test(i.str)), hebrewRight: Math.max(...hebrew.map((i) => i.x + i.w)), alpha: D.item(info.pages[0], 'Alpha'), beta: D.item(info.pages[0], 'Beta') };
  });
  check('rtl: the number 18 points in from the right margin', near(612 - 72 - 18, r.number?.x + r.number?.w), r.number);
  check('rtl: the text from the indent on the right', near(612 - 72 - 36, r.hebrewRight), r.hebrewRight);
  check('rtl: the table\'s first column on the right', r.alpha.x > r.beta.x + 100, [r.alpha, r.beta]);

  // wordParagraphsReadLeftToRightUnlessSetOtherwise
  r = await page.evaluate(async () => {
    const { D } = window;
    const info = await D.info((await D.convert(D.word(D.para('שלום world')))).bytes);
    return Math.min(...info.pages[0].items.filter((i) => /[א-ת]/.test(i.str)).map((i) => i.x));
  });
  check('ltr: Hebrew first, at the left margin', near(72, r), r);

  // wordComplexScriptTextHasItsOwnSize
  r = await page.evaluate(async () => {
    const { D } = window;
    const info = await D.info((await D.convert(D.word(D.para('שלום world', '', '<w:sz w:val="22"/><w:szCs w:val="32"/>')))).bytes);
    return { hebrew: info.pages[0].items.filter((i) => /[א-ת]/.test(i.str)).map((i) => i.size), world: D.item(info.pages[0], 'world')?.size };
  });
  check('complex script: Hebrew at w:szCs', r.hebrew.length && r.hebrew.every((s) => near(16, s, 0.3)), r.hebrew);
  check('complex script: Latin at w:sz', near(11, r.world, 0.3), r.world);

  // wordTablesSpanningCountlessOrNegativeColumnsStillConvert
  r = await page.evaluate(async () => {
    const { D } = window;
    const grid = '<w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>';
    const body = `<w:tbl>${grid}<w:tr><w:tc><w:tcPr><w:gridSpan w:val="20000000"/></w:tcPr>${D.para('Wide cell')}</w:tc></w:tr></w:tbl>` + D.para('Between') +
      `<w:tbl>${grid}<w:tr><w:trPr><w:gridBefore w:val="-3"/></w:trPr><w:tc>${D.para('Shifted cell')}</w:tc></w:tr></w:tbl>`;
    return (await D.info((await D.convert(D.word(body))).bytes)).pages[0].text;
  });
  check('spans: countless or negative columns still convert', r.includes('Wide cell') && r.includes('Shifted cell'), r);

  // wordSpaceBeforeTallerThanThePageLeavesTheTextOnIt
  r = await page.evaluate(async () => {
    const { D } = window;
    const info = await D.info((await D.convert(D.word(D.para('Cover title', '<w:spacing w:before="14000"/>')))).bytes);
    return { pages: info.pages.length, cover: D.item(info.pages[0], 'Cover') };
  });
  check('space before: the text stays on the page', r.pages === 1 && r.cover && r.cover.y >= 600 && r.cover.y <= 721, r);

  // deeplyNestedXmlDoesNotOverflowTheStack
  r = await page.evaluate(async () => {
    const { D } = window;
    const nested = (depth) => D.word('<w:customXml>'.repeat(depth) + D.para('Deep') + '</w:customXml>'.repeat(depth) + D.para('Shallow'));
    const ok = await D.convert(nested(10000));
    const t0 = performance.now();
    const deep = await D.convert(nested(100000));
    return { ok: ok.error ? ok.error : (await D.info(ok.bytes)).pages.map((p) => p.text).join(' '), deep: deep.error, ms: performance.now() - t0 };
  });
  check('nesting: 10,000 levels convert', typeof r.ok === 'string' && r.ok.includes('Shallow'), r.ok);
  check('nesting: 100,000 levels are refused as damaged', r.deep?.key === 'office_convert_failed', r.deep);
  check('nesting: quickly', r.ms < 20000, r.ms);

  // everyWayOfNestingHoldsInTheStack (the Word documents)
  r = await page.evaluate(async () => {
    const { D } = window;
    const depth = 1000;
    const files = {
      links: D.word('<w:p>' + '<w:hyperlink>'.repeat(depth) + '<w:r><w:t>Deep</w:t></w:r>' + '</w:hyperlink>'.repeat(depth) + '</w:p>' + D.para('Shallow')),
      tables: D.word('<w:tbl><w:tr><w:tc>'.repeat(depth) + D.para('Deep') + '</w:tc></w:tr></w:tbl>'.repeat(depth) + D.para('Shallow')),
      controls: D.word('<w:sdt><w:sdtContent>'.repeat(depth) + D.para('Deep') + '</w:sdtContent></w:sdt>'.repeat(depth) + D.para('Shallow')),
    };
    const out = {};
    for (const [name, bytes] of Object.entries(files)) {
      const c = await D.convert(bytes);
      out[name] = c.error ? JSON.stringify(c.error) : (await D.info(c.bytes)).pages.map((p) => p.text).join(' ');
    }
    return out;
  });
  for (const [name, text] of Object.entries(r)) check(`nesting ${name}: too deep is left out, the rest converts`, text.includes('Shallow') && !text.includes('Deep'), text.slice(0, 200));
}

function D_near(a, b, tol = 40) {
  return Array.isArray(a) && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

// ---------------------------------------------------------------------------------------------
// More of what converts

async function moreWordTests(page) {
  // Links: to web addresses (w:hyperlink and HYPERLINK fields) and to bookmarks (a table of
  // contents); none for a bookmark that isn't there or an address that isn't safe.
  let r = await page.evaluate(async () => {
    const { D } = window;
    const toc = '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr>' +
      '<w:hyperlink w:anchor="_Toc1"><w:r><w:t>Chapter one</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2</w:t></w:r></w:hyperlink></w:p>';
    const field = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:garden@example.org" \\o "Write to us" </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Write to us</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const bad = '<w:p><w:hyperlink r:id="rId5"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink w:anchor="_Missing"><w:r><w:t>missing bookmark</w:t></w:r></w:hyperlink></w:p>';
    const web = '<w:p><w:hyperlink r:id="rId4" w:history="1"><w:r><w:t>Usugami website</w:t></w:r></w:hyperlink></w:p>';
    const heading = '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:pageBreakBefore/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Chapter one</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>';
    // A contents line as fields write it: its page number a PAGEREF with \h.
    const pageref = '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t>Again</w:t></w:r><w:r><w:tab/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const body = toc + pageref + field + web + bad + heading + D.para('The first chapter.');
    const out = await D.convert(D.word(body, { rels: [['hyperlink', 'https://usugami.com/', true], ['hyperlink', 'javascript:alert(1)', true]] }), { keep: 'links' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    return { pages: info.pages.map((p) => ({ text: p.text, links: p.links, items: p.items })), dests: info.dests };
  });
  check('links: converts', !r.error, r.error);
  const p1 = r.pages[0];
  const urls = p1.links.map((l) => l.url).filter(Boolean);
  check('links: web and mail addresses are clickable', urls.includes('https://usugami.com/') && urls.includes('mailto:garden@example.org'), p1.links);
  check('links: unsafe addresses aren\'t', !urls.some((u) => u.startsWith('javascript')), urls);
  const internal = p1.links.filter((l) => l.dest);
  // The text and its page number (the leader between them isn't part of the link's areas).
  check('links: a contents line goes to its heading', internal.length >= 2 && internal.every((l) => l.dest === '_Toc1') && near(539.5, Math.max(...internal.map((l) => l.right)), 1), p1.links);
  const lineTops = [...new Set(internal.map((l) => Math.round(l.top)))];
  check('links: a page reference with \\h links too', lineTops.length === 2, internal);
  check('links: the bookmark is on the heading\'s page', r.dests._Toc1?.page === 1, r.dests);
  const headingItem = r.pages[1].items.find((i) => i.str.includes('Chapter one'));
  check('links: at the heading', headingItem && r.dests._Toc1.top <= headingItem.y && r.dests._Toc1.top > headingItem.y - 40, [r.dests._Toc1, headingItem]);
  check('links: none to a missing bookmark', !p1.links.some((l) => l.dest === '_Missing'));
  const leader = p1.items.find((i) => /\.{10,}/.test(i.str));
  check('tab leaders: dots up to the page number', !!leader, p1.items.map((i) => i.str));
  const number = p1.items.find((i) => i.str.trim() === '2' || /[.\s]2$/.test(i.str));
  check('tab leaders: the number at the right stop', number && near(72 + 467.5, number.x + number.w, 2), number);

  // First-page headers; text boxes and equations follow their paragraph; theme fonts and colours;
  // highlight, shading, borders; superscript, capitals.
  r = await page.evaluate(async () => {
    const { D } = window;
    const header = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${D.NS}>${D.para(text)}</w:hdr>`;
    const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
      <a:clrScheme name="C"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="C00000"/></a:accent1></a:clrScheme>
      <a:fontScheme name="F"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont><a:minorFont><a:latin typeface="Consolas"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const box = D.anchor(200, 50, `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${200 * D.EMU}" cy="${50 * D.EMU}"/></a:xfrm></wps:spPr>
      <wps:txbx><w:txbxContent>${D.para('Boxed words')}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`, { wrap: '<wp:wrapNone/>', uri: D.SHAPE_URI });
    const math = '<w:p><m:oMathPara><m:oMath><m:r><m:t>E=mc</m:t></m:r><m:sSup><m:e/><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>';
    const body = `<w:p>${box}<w:r><w:t>Anchor paragraph</w:t></w:r></w:p>` + math +
      D.para('Heading font', '', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>') +
      D.para('Body font') +
      D.para('Accent text', '', '<w:color w:val="FF0000" w:themeColor="accent1"/><w:sz w:val="48"/>') +
      D.para('Theme only', '', '<w:color w:themeColor="accent1" w:themeShade="80"/><w:sz w:val="48"/>') +
      D.para('Marked words', '', '<w:highlight w:val="yellow"/><w:sz w:val="48"/>') +
      D.para('Shaded paragraph', '<w:shd w:val="clear" w:color="auto" w:fill="CCFFCC"/>') +
      D.para('Ruled paragraph', '<w:pBdr><w:bottom w:val="single" w:sz="24" w:space="4" w:color="0000FF"/></w:pBdr>') +
      '<w:p><w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:rPr><w:caps/></w:rPr><w:t xml:space="preserve"> shout</w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve"> gone</w:t></w:r></w:p>' +
      '<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Second page</w:t></w:r></w:p>' +
      '<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:headerReference w:type="first" r:id="rId5"/><w:titlePg/></w:sectPr>';
    const out = await D.convert(D.word(body, {
      styles: D.stylesXml.replace('<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>', '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/>'),
      rels: [['header', 'header1.xml'], ['header', 'header2.xml'], ['theme', 'theme/theme1.xml']],
      parts: { 'word/header1.xml': header('Default header'), 'word/header2.xml': header('First header'), 'word/theme/theme1.xml': theme },
    }), { keep: 'formatting' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 2);
    const p = info.pages[0];
    const at = (word, dx = 0, dy = -4) => { const i = D.item(p, word); return i ? img.px(i.x + dx, i.y + dy) : null; };
    const inkOf = (word) => {
      const i = D.item(p, word);
      const seen = [];
      for (let x = i.x; x < i.x + i.w; x += 0.5) for (let y = i.y - i.size * 0.7; y < i.y; y += 0.5) {
        const c = img.px(x, y);
        if (c[0] + c[1] + c[2] < 600) seen.push(c);
      }
      // The darkest pixel: the text's own colour.
      return seen.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]))[0] ?? null;
    };
    const ruled = D.item(p, 'Ruled');
    let rule = null;
    for (let y = ruled.y; y < ruled.y + 20; y += 0.5) { const c = img.px(300, y); if (D.isColor(c, [0, 0, 255], 60)) { rule = y; break; } }
    return {
      texts: info.pages.map((q) => q.text),
      heading: D.item(p, 'Heading')?.font, body: D.item(p, 'Body')?.font,
      accent: inkOf('Accent'), shaded: inkOf('Theme'), highlight: at('Marked', 2, 3), green: (() => { const i = D.item(p, 'Shaded'); return img.px(i.x + i.w + 20, i.y - 3); })(),
      rule, ruledY: ruled.y,
      sup: p.items[p.items.findIndex((i) => i.str === 'x') + 1]?.size, x: p.items.find((i) => i.str === 'x')?.size, caps: p.text.includes('SHOUT'),
      strike: (() => { const i = D.item(p, 'gone'); let n = 0; for (let x = i.x; x < i.x + i.w; x += 0.5) { const c = img.px(x, i.y - i.size * 0.3); if (c[0] < 100) n++; } return n / (i.w * 2); })(),
    };
  });
  check('first page: converts', !r.error, r.error);
  check('first page: its own header', r.texts[0].includes('First header') && !r.texts[0].includes('Default header'), r.texts[0]);
  check('first page: then the default one', r.texts[1].includes('Default header') && !r.texts[1].includes('First header'), r.texts[1]);
  check('text box: its text follows its paragraph', /Anchor paragraph.*Boxed words/.test(r.texts[0]), r.texts[0]);
  check('equations: their text', r.texts[0].includes('E=mc2') || r.texts[0].includes('E=mc 2'), r.texts[0]);
  check('theme fonts: heading font (Cambria) is serif', /NotoSerif/.test(r.heading ?? ''), r.heading);
  check('theme fonts: body font (Consolas) is monospace', /NotoSansMono/.test(r.body ?? ''), String(r.body));
  check('colours: hex colour wins over the theme\'s', D_near(r.accent, [255, 0, 0], 60), r.accent);
  check('colours: theme colour with its shade', D_near(r.shaded, [0x60, 0, 0], 50), r.shaded);
  check('highlight: yellow behind the text', D_near(r.highlight, [255, 255, 0], 30), r.highlight);
  check('shading: the paragraph\'s', D_near(r.green, [0xcc, 0xff, 0xcc], 20), r.green);
  check('borders: a rule under the paragraph', r.rule != null && r.rule > r.ruledY, [r.rule, r.ruledY]);
  check('superscript: smaller', near(11 * 0.65, r.sup, 0.3) && near(11, r.x, 0.3), [r.sup, r.x]);
  check('capitals', r.caps);
  check('strike-through: a line through', r.strike > 0.6, r.strike);

  // Tables: merged cells, shading, borders, widths, an exact row; a list restarted by its own
  // numId and one continuing; keep with next; page break before.
  r = await page.evaluate(async () => {
    const { D } = window;
    const b = 'w:val="single" w:sz="8" w:color="000000"';
    const borders = `<w:tblBorders><w:top ${b}/><w:left ${b}/><w:bottom ${b}/><w:right ${b}/><w:insideH ${b}/><w:insideV ${b}/></w:tblBorders>`;
    const table = `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/>${borders}</w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="FFC000"/></w:tcPr>${D.para('Spanning two')}</w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${D.para('Merged down')}</w:tc></w:tr>
      <w:tr><w:tc>${D.para('A2')}</w:tc><w:tc>${D.para('B2')}</w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
      <w:tr><w:trPr><w:trHeight w:val="400" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:tcBorders><w:top w:val="nil"/></w:tcBorders></w:tcPr>${D.para('Exact row with far too much text to fit in its height at all, line after line after line')}</w:tc><w:tc>${D.para('B3')}</w:tc><w:tc>${D.para('C3')}</w:tc></w:tr></w:tbl>`;
    const numbering = D.listNumbering.replace('</w:numbering>',
      '<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num><w:num w:numId="4"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
    const lists = D.listItem('Alpha item', 1, 0) + D.listItem('Beta item', 1, 0) + D.para('Between lists') + D.listItem('Gamma item', 4, 0) + D.listItem('Restarted item', 3, 0) + D.listItem('Next item', 3, 0);
    let filler = '';
    for (let i = 0; i < 24; i++) filler += D.para(`Filler line ${i + 1}`);
    const keep = D.para('Kept heading', '<w:pStyle w:val="Heading1"/>') + D.para('Kept body');
    const breakBefore = D.para('Starts a page', '<w:pageBreakBefore/>');
    const out = await D.convert(D.word(table + lists + filler + keep + breakBefore, { numbering }), { keep: 'tables' });
    if (out.error) return out;
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 2);
    const p = info.pages[0];
    const span = D.item(p, 'Spanning');
    const a2 = D.item(p, 'A2');
    const b2 = D.item(p, 'B2');
    const merged = D.item(p, 'Merged');
    // The line between rows 1 and 2: in column 3 (merged) none, in column 1 a black one.
    const lineAt = (x) => { for (let y = span.y; y < a2.y; y += 0.5) { const c = img.px(x, y); if (c[0] < 80 && c[1] < 80 && c[2] < 80) return y; } return null; };
    return {
      texts: info.pages.map((q) => q.text),
      span, a2, b2, merged, fill: img.px(span.x + 80, span.y - 3),
      lineCol1: lineAt(72 + 50), lineCol3: lineAt(72 + 250),
      keptPage: info.pages.findIndex((q) => q.text.includes('Kept heading')), bodyPage: info.pages.findIndex((q) => q.text.includes('Kept body')),
      breakPage: info.pages.findIndex((q) => q.text.includes('Starts a page')), lastFillerPage: info.pages.findIndex((q) => q.text.includes('Filler line 24')),
    };
  });
  check('tables: converts', !r.error, r.error);
  check('tables: a cell spanning two columns', r.span && r.b2 && near(72 + 5.4, r.span.x) && near(72 + 100 + 5.4, r.b2.x), [r.span, r.b2]);
  check('tables: the merged cell in the third column', r.merged && near(72 + 200 + 5.4, r.merged.x), r.merged);
  check('tables: shading', D_near(r.fill, [0xff, 0xc0, 0], 30), r.fill);
  check('tables: borders between rows', r.lineCol1 != null, r.lineCol1);
  check('tables: none inside a merged cell', r.lineCol3 == null, r.lineCol3);
  const all = r.texts.join(' ');
  check('lists: one list counts on', /1\.\s*Alpha item/.test(all) && /2\.\s*Beta item/.test(all) && /3\.\s*Gamma item/.test(all), all.slice(0, 400));
  check('lists: one restarted', /1\.\s*Restarted item/.test(all) && /2\.\s*Next item/.test(all), all.slice(0, 400));
  check('keep with next: the heading goes with its text', r.keptPage >= 0 && r.keptPage === r.bodyPage, [r.keptPage, r.bodyPage]);
  check('page break before', r.breakPage > r.bodyPage || (r.breakPage > 0 && r.breakPage === r.texts.length - 1), [r.breakPage, r.bodyPage]);

  // Floating pictures: placed from the page in front of the text, or on a line of their own at the right.
  r = await page.evaluate(async () => {
    const { D } = window;
    const front = D.anchor(100, 50, D.picture(100, 50), {
      h: '<wp:positionH relativeFrom="page"><wp:posOffset>1270000</wp:posOffset></wp:positionH>',
      v: '<wp:positionV relativeFrom="page"><wp:posOffset>2540000</wp:posOffset></wp:positionV>', wrap: '<wp:wrapNone/>',
    });
    const right = D.anchor(120, 60, D.picture(120, 60), { h: '<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>' });
    const out = await D.convert(D.word(`<w:p>${front}<w:r><w:t>In front</w:t></w:r></w:p><w:p>${right}<w:r><w:t>At the right</w:t></w:r></w:p>`), { keep: 'floating' });
    const info = await D.info(out.bytes);
    return { images: info.pages[0].images.sort((a, b) => a.width - b.width), right: D.item(info.pages[0], 'At the right') };
  });
  check('floating: placed from the page', near(100, r.images[0].left) && near(200, r.images[0].top) && near(100, r.images[0].width), r.images[0]);
  check('floating: aligned right on a line of its own', near(540, r.images[1].right) && near(120, r.images[1].width), r.images[1]);
  check('floating: the text below it', r.right && r.right.y > r.images[1].bottom, [r.right, r.images[1]]);

  // A picture that can't be decoded is a light grey box; a chart a grey box with its title.
  r = await page.evaluate(async () => {
    const { D } = window;
    const chart = `<w:p>${D.inlineDrawing(200, 100, '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>', ' descr="Sales by region"', 'http://schemas.openxmlformats.org/drawingml/2006/chart')}</w:p>`;
    const broken = `<w:p>${D.inlineDrawing(150, 100, D.picture(150, 100, { rel: 'rId4' }))}</w:p>`;
    const out = await D.convert(D.word(chart + broken, { rels: [['image', 'media/broken.png']], parts: { 'word/media/broken.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) } }));
    if (out.error) return out;
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 2);
    return { text: info.pages[0].text, chart: img.px(72 + 20, 72 + 20), broken: img.px(72 + 20, 72 + 100 + 30) };
  });
  check('charts: converts', !r.error, r.error);
  check('charts: a grey box with the title',!r.error && r.text.includes('Sales by region') && D_near(r.chart, [0xf1, 0xf1, 0xf1], 8), r);
  check('broken pictures: a grey box', D_near(r.broken, [0xf1, 0xf1, 0xf1], 8), r.broken);

  // Chinese and Japanese: drawn, and kept as text.
  r = await page.evaluate(async () => {
    const { D } = window;
    const run = '<w:rFonts w:ascii="Century" w:eastAsia="MS Mincho"/><w:sz w:val="32"/>';
    const out = await D.convert(D.word(D.para('日本語のテキストです。', '', run) + D.para('中文文本', '', run)));
    if (out.error) return out;
    const info = await D.info(out.bytes);
    const img = await D.render(out.bytes, 1, 2);
    let ink = 0;
    for (let x = 72; x < 72 + 160; x += 1) for (let y = 72; y < 72 + 20; y += 1) { const c = img.px(x, y); if (c[0] < 128) ink++; }
    return { text: info.pages[0].text, ink };
  });
  const cjk = (r.text ?? '').replace(/\s+/g, '');
  check('Chinese and Japanese: kept as text', !r.error && cjk.includes('日本語のテキストです。') && cjk.includes('中文文本'), r);
  check('Chinese and Japanese: drawn', r.ink > 100, r.ink);
}

// ---------------------------------------------------------------------------------------------
// Damaged and hostile files, cancelling, progress and responsiveness

async function robustness(page) {
  const r = await page.evaluate(async () => {
    const { D } = window;
    const out = {};
    const word = D.word(D.para('Hello'));
    out.notZip = (await D.convert(new TextEncoder().encode('not a document any more at all'))).error;
    const compound = new Uint8Array(4096);
    compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    out.legacy = (await D.convert(compound)).error;
    const name = [...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]);
    const locked = new Uint8Array(8192);
    locked.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    locked.set(name, 3000);
    out.encrypted = (await D.convert(locked)).error;
    out.truncated = (await D.convert(word.subarray(0, word.length - 30))).error;
    // Well-formed at the start (so it is picked), broken further in: fails while converting.
    const brokenBody = D.zip({
      '_rels/.rels': D.rels(['officeDocument', 'word/document.xml']),
      'word/document.xml': `<?xml version="1.0"?><w:document ${D.NS}><w:body><w:p><w:r><w:t>Half</w:t></w:r></w:p><w:p></w:body></w:document>`,
    });
    out.brokenBody = (await D.convert(brokenBody)).error;
    out.brokenStyles = (await D.convert(D.word(D.para('Hello'), { styles: '<w:styles xmlns:w="x"><w:style>' }))).error;
    out.entities = (await D.convert(D.word(D.para('Hello'), { styles: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:styles xmlns:w="x"/>' }))).error;
    // Only the minimum: no styles, no numbering, an empty body.
    const bare = D.zip({
      '_rels/.rels': D.rels(['officeDocument', 'word/document.xml']),
      'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${D.W}"><w:body/></w:document>`,
    });
    const empty = await D.convert(bare);
    out.empty = empty.error ?? { pages: empty.pageCount, info: (await D.info(empty.bytes)).pages.map((p) => [p.width, p.height]) };
    // A picture part that is missing, and relationships pointing nowhere.
    const missing = await D.convert(D.word(`<w:p>${D.inlineDrawing(100, 100, D.picture(100, 100, { rel: 'rId99' }))}<w:r><w:t>After</w:t></w:r></w:p>`));
    out.missing = missing.error ?? (await D.info(missing.bytes)).pages[0].text;
    // Strict Open XML (ISO 29500 Strict), as some apps save: other namespaces, same document.
    const SW = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const SR = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
    const strictRels = (...rels) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([t, target], i) => `<Relationship Id="rId${i + 1}" Type="${SR}/${t}" Target="${target}"/>`).join('')}</Relationships>`;
    const strict = await D.convert(D.zip({
      '_rels/.rels': strictRels(['officeDocument', 'word/document.xml']),
      'word/_rels/document.xml.rels': strictRels(['styles', 'styles.xml']),
      'word/styles.xml': `<w:styles xmlns:w="${SW}"><w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
      'word/document.xml': `<w:document xmlns:w="${SW}" xmlns:r="${SR}"><w:body><w:p><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>Strict words</w:t></w:r></w:p>` +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
    }));
    out.strict = strict.error ?? (await D.info(strict.bytes)).pages.map((p) => ({ text: p.text, width: p.width, font: D.item(p, 'Strict')?.font }));
    // Wrong kind: a PowerPoint file.
    const pptx = D.zip({ '_rels/.rels': D.rels(['officeDocument', 'ppt/presentation.xml']), 'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>' });
    out.wrongKind = (await D.convert(pptx)).error;
    return out;
  });
  check('damaged: not a zip', r.notZip?.key === 'office_not_word' && r.notZip?.manyKey === 'office_not_word_many', r.notZip);
  check('damaged: an old .doc', r.legacy?.key === 'office_legacy_word', r.legacy);
  check('damaged: password-protected', r.encrypted?.key === 'office_encrypted', r.encrypted);
  check('damaged: a cut-off file', r.truncated?.key === 'office_not_word', r.truncated);
  check('damaged: a body broken further in', r.brokenBody?.key === 'office_convert_failed', r.brokenBody);
  check('damaged: broken styles', r.brokenStyles?.key === 'office_convert_failed', r.brokenStyles);
  check('hostile: entities are refused', r.entities?.key === 'office_convert_failed', r.entities);
  check('bare document: one blank Letter page', r.empty.pages === 1 && near(612, r.empty.info[0][0]) && near(792, r.empty.info[0][1]), r.empty);
  check('missing picture: the rest converts', typeof r.missing === 'string' && r.missing.includes('After'), r.missing);
  check('wrong kind: not a Word document', r.wrongKind?.key === 'office_not_word', r.wrongKind);
  check('strict: converts, A4, its style bold', Array.isArray(r.strict) && r.strict[0].text.includes('Strict words') && near(595, r.strict[0].width, 1.5) && /Bold/.test(r.strict[0].font ?? ''), r.strict);

  // Cancelling: at once, and once the second page has started.
  const c = await page.evaluate(async () => {
    const { D } = window;
    let body = '';
    for (let i = 0; i < 400; i++) body += D.para(`Paragraph ${i} with enough words in it to take a line or two on the page, as text does.`);
    const bytes = D.word(body);
    const now = new AbortController();
    now.abort();
    const atOnce = (await D.convert(bytes, {}, { signal: now.signal })).error;
    const later = new AbortController();
    const res = await D.convert(bytes, {}, { signal: later.signal, onProgress: (done) => { if (done >= 2) later.abort(); } });
    // Responsiveness: a long document converts while timers keep firing.
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => { const t = performance.now(); longest = Math.max(longest, t - last); last = t; }, 10);
    let big = '';
    for (let i = 0; i < 1500; i++) big += D.para(`Line ${i}: the quick brown fox jumps over the lazy dog, again and again, page after page.`);
    const t0 = performance.now();
    const done = await D.convert(D.word(big));
    clearInterval(timer);
    return { atOnce, later: res.error, progress: res.progress.length, pages: done.pageCount, ms: performance.now() - t0, longest };
  });
  check('cancel: at once', c.atOnce?.name === 'CancelledError', c.atOnce);
  check('cancel: while converting', c.later?.name === 'CancelledError' && c.progress <= 3, c);
  check('long document: converts', c.pages > 30, c.pages);
  check('long document: the page keeps answering', c.longest < 400, c.longest);
  check('long document: in reasonable time', c.ms < 60000, c.ms);
  console.log(`  long document: ${c.pages} pages in ${Math.round(c.ms)} ms, longest pause ${Math.round(c.longest)} ms`);
}

// ---------------------------------------------------------------------------------------------
// The styles module on its own

async function stylesUnits(page) {
  const r = await page.evaluate(async () => {
    const { D } = window;
    const { ComplexScript, hexInt } = D.styles;
    const parts = [];
    const last = ComplexScript.split('Hello שלום, world 123', null, (t, c) => parts.push([t, c]));
    const start = [];
    ComplexScript.split(' (שלום)', true, (t, c) => start.push([t, c]));
    return {
      parts, last, start, digits: (() => { const p = []; ComplexScript.split('123', null, (t, c) => p.push([t, c])); return p; })(),
      hex: [hexInt('F06D'), hexInt('zz'), hexInt('-1A'), hexInt('FFFFFFFFF')],
      page: [D.read.isPageField(' PAGE '), D.read.isPageField('PAGE \\* roman'), D.read.isPageField('PAGEREF _Toc1'), D.read.isPageField('NUMPAGES')],
      link: [
        D.read.fieldTarget(' HYPERLINK "https://a.example/x" \\o "tip" '), D.read.fieldTarget('HYPERLINK \\l "_Toc5"'), D.read.fieldTarget('PAGE'),
        D.read.fieldTarget(' PAGEREF _Toc7 \\h '), D.read.fieldTarget('PAGEREF _Toc7'), D.read.fieldTarget('HYPERLINK "https://b.example/" \\l "part"'),
      ],
    };
  });
  check('complex script: split by script, neutrals with the letters before', JSON.stringify(r.parts) === JSON.stringify([['Hello ', false], ['שלום, ', true], ['world 123', false]]), r.parts);
  check('complex script: the last kind', r.last === false);
  check('complex script: neutrals at the start go with the run before', JSON.stringify(r.start) === JSON.stringify([[' (שלום)', true]]), r.start);
  check('complex script: digits alone are not complex', JSON.stringify(r.digits) === JSON.stringify([['123', false]]), r.digits);
  check('hex numbers as Kotlin reads them', JSON.stringify(r.hex) === JSON.stringify([0xf06d, null, -26, null]), r.hex);
  check('page fields', JSON.stringify(r.page) === '[true,true,false,false]', r.page);
  check('hyperlink fields', r.link[0]?.url === 'https://a.example/x' && r.link[1]?.anchor === '_Toc5' && r.link[2] === null && r.link[5]?.url === 'https://b.example/#part', r.link);
  check('page reference fields link with \\h', r.link[3]?.anchor === '_Toc7' && r.link[4] === null, r.link);
}

// ---------------------------------------------------------------------------------------------

const report = await fixture('docx/report.docx');

await withPage(async (page, url) => {
  await setup(page, url);
  await stylesUnits(page);
  await appWordTests(page, report);
  await moreWordTests(page);
  await robustness(page);
  // A copy of the report's PDF to look at.
  const out = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await window.D.convert(bytes);
    let s = '';
    for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, report.toString('base64'));
  await saveOutput('docx-report.pdf', Buffer.from(out, 'base64'));
  const kept = await page.evaluate(() => Object.fromEntries(Object.entries(window.D.kept).map(([name, bytes]) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return [name, btoa(s)];
  })));
  for (const [name, b64] of Object.entries(kept)) await saveOutput(`docx-${name}.pdf`, Buffer.from(b64, 'base64'));
});
console.log(`Chromium: ${passed} checks passed`);

// The same documents in Firefox and Safari's engine.
for (const browser of ['firefox', 'webkit']) {
  const before = passed;
  await withPage(async (page, url) => {
    await setup(page, url);
    const r = await page.evaluate(async (b64) => {
      const { D } = window;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const out = await D.convert(bytes);
      if (out.error) return out;
      const info = await D.info(out.bytes);
      const notes = await D.convert(D.word(D.defaultBody()));
      const notesInfo = notes.error ? null : await D.info(notes.bytes);
      return {
        pages: info.pages.map((p) => ({ text: p.text, images: p.images.length, links: p.links.length, width: p.width })),
        notes: notesInfo ? { pages: notesInfo.pages.length, picture: notesInfo.pages[0].images[0], text: notesInfo.pages.map((p) => p.text).join(' ') } : notes.error,
      };
    }, report.toString('base64'));
    check(`${browser}: report converts`, !r.error && r.pages.length === 5, r.error ?? r.pages.length);
    check(`${browser}: header, footer, picture, link`, r.pages[0].text.includes('Annual report') && r.pages[0].text.includes('Page 1') && r.pages[0].images === 1 && r.pages[0].links === 1, r.pages[0]);
    check(`${browser}: landscape last page`, near(842, r.pages[4].width, 1.5), r.pages[4].width);
    check(`${browser}: notes`, r.notes.pages >= 4 && near(150, r.notes.picture?.width) && /1\.\s*First step/.test(r.notes.text), r.notes);
  }, { browser });
  console.log(`${browser}: ${passed - before} checks passed`);
}

console.log(`docx: all ${passed} checks passed`);
