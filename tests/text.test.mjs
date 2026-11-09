// Tests for the text engine (site/app/js/engine/text/): fonts, paragraph layout and PdfCanvas.
// Everything is drawn into real PDFs and read back with pdf.js: extracted text, positions and
// rendered pixels.
import { withPage, assert } from './harness.mjs';

let passed = 0;
function check(name, condition, detail = '') {
  assert(condition, `${name}${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  passed++;
}

/** Loads the engine and pdf.js into the page and defines helpers on window.T. */
async function setup(page, url) {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(async (base) => {
    const T = {};
    T.base = base;
    T.text = await import(base + 'app/js/engine/text/index.js');
    T.common = await import(base + 'app/js/engine/pdf-common.js');
    T.pdfjs = await import(base + 'app/js/lib/pdfjs.js');
    T.lib = await import(base + 'app/js/lib/pdf-lib.js');
    T.fontkit = (await import(base + 'app/js/lib/fontkit.js')).default;
    T.coverage = await import(base + 'app/js/engine/text/coverage.js');
    // Text of a page as pdf.js extracts it: items with their positions (PDF points, y up).
    T.items = async (bytes, n = 1) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const out = tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height, eol: i.hasEOL }));
      await pdf.loadingTask.destroy();
      return out;
    };
    // Lines joined with a space, except after a hyphen a line broke at.
    T.joined = (items) => items.map((i) => i.str + (i.eol && !/[-\u2010\u2013]$/.test(i.str) ? ' ' : '')).join('').replace(/\s+/g, ' ').trim();
    // Renders a page to pixels with pdf.js; px(x, y) gives [r, g, b] at PDF point (x, y) from the top-left.
    T.render = async (bytes, n = 1, scale = 2) => {
      const pdf = await T.pdfjs.openPdfJs(bytes);
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      await pdf.loadingTask.destroy();
      const px = (x, y) => {
        const i = (Math.round(y * scale) * canvas.width + Math.round(x * scale)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const ink = (x0, y0, x1, y1, dark = 128) => {
        let count = 0;
        for (let y = Math.round(y0 * scale); y < Math.round(y1 * scale); y++) {
          for (let x = Math.round(x0 * scale); x < Math.round(x1 * scale); x++) {
            const i = (y * canvas.width + x) * 4;
            if (data[i] < dark || data[i + 1] < dark || data[i + 2] < dark) count++;
          }
        }
        return count;
      };
      return { px, ink, width: canvas.width, height: canvas.height, data, scale };
    };
    T.near = (a, b, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    // A canvas element (WebKit builds without OffscreenCanvas still have these).
    T.canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
    window.T = T;
  }, url);
}

// ---------------------------------------------------------------------------------------------

async function fontsAndData(page) {
  const r = await page.evaluate(async () => {
    const { text, fontkit, coverage } = window.T;
    const out = { coverage: [], metrics: [] };
    for (const file of text.FONT_FILES) {
      const res = await fetch(new URL('app/fonts/' + file, window.T.base));
      const font = fontkit.create(new Uint8Array(await res.arrayBuffer()));
      // The coverage data must say exactly what the font's character map says.
      const cps = [...new Set(font.characterSet)].sort((a, b) => a - b);
      const wanted = coverage.encodeCodePoints(cps);
      const sample = [0x41, 0xe9, 0x915, 0x93f, 0x4e2d, 0x20b9, 0x2026];
      out.coverage.push({
        file,
        ok: wanted === coverage.encodedSet(file) && sample.every((cp) => coverage.fontHas(file, cp) === cps.includes(cp)),
        wanted,
      });
      const m = text.FONT_METRICS[file];
      const os2 = font['OS/2'];
      out.metrics.push({
        file,
        ok: m[0] === font.ascent && m[1] === -font.descent && m[2] === font.underlinePosition && m[3] === font.underlineThickness &&
          m[4] === os2.yStrikeoutPosition && m[5] === os2.yStrikeoutSize && m[8] === font.glyphForCodePoint(0x30).advanceWidth,
      });
    }
    // OfficeFonts, as the app's device test checks it.
    const f = text.officeFamily;
    out.families = [f('Century Gothic'), f('Monotype Corsiva'), f('Century Schoolbook'), f('Courier New'), f('Roboto Mono'), f('Noto Sans Mono'),
      ...['DejaVuSansMono', 'RobotoMono-Regular', 'SFMono-Regular', 'SourceCodePro-Regular'].map((n) => f(n)),
      f('Times New Roman'), f('Calibri'), f('Comic Sans MS'), f('Calibri Light'), f('Calibri Light', true), f('Arial Narrow'), f(null), f('Brush Script MT')];
    out.heights = ['Calibri', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Georgia', 'Garamond', 'Wingdings', null].map(text.officeLineHeight);
    out.scales = [text.lineScale({ font: 'Calibri' }), text.lineScale({ font: 'Cambria' }), text.lineScale({ family: 'serif' }, 3), text.lineScale({ family: 'serif' }, 0.1)];
    out.phone = [text.phoneLineHeight({}), text.phoneLineHeight({ family: 'serif' })];
    out.width = [text.widthScale(0.507, { font: 'Calibri' }), text.widthScale(null, {}), text.widthScale(2, {}), text.widthScale(0.1, {})];
    out.styles = [
      text.resolveStyle({ size: 10, baseline: 1 }).drawnSize, text.resolveStyle({ size: 10, smallCaps: true }).drawnSize,
      text.resolveStyle({ size: 10, baseline: 1 }).shift, text.resolveStyle({ size: 10, baseline: -1 }).shift,
      text.resolveStyle({ size: 10, spacing: 2, baseline: 1 }).letterSpacing,
      text.resolveStyle({ autoColor: true, background: '#000' }).color.r, text.resolveStyle({ autoColor: true }, 0xff202020).color.r,
      text.resolveStyle({ autoColor: true }, '#ffffff').color.r,
    ];
    out.stack = text.resolveStyle({ family: 'monospace', italic: true }).stack.map((e) => e.file + (e.slant ? '/' : ''));
    out.colors = [text.parseColor('#c00'), text.parseColor('rgba(0, 0, 255, 0.5)'), text.parseColor(0x80ff0000), text.parseColor('hsl(120 100% 25%)'), text.parseColor('rebeccapurple'), text.parseColor('nonsense')];
    return out;
  });
  for (const c of r.coverage) check(`coverage data matches ${c.file}`, c.ok, c.ok ? '' : `put this set for it in engine/text/coverage.js: '${c.wanted}'`);
  for (const m of r.metrics) check(`metrics table matches ${m.file}`, m.ok);
  check('Office fonts become the families the app uses', JSON.stringify(r.families) === JSON.stringify([
    'sans-serif', 'cursive', 'serif', 'monospace', 'monospace', 'monospace', 'monospace', 'monospace', 'monospace', 'monospace',
    'serif', 'sans-serif', 'casual', 'sans-serif-light', 'sans-serif', 'sans-serif-condensed', 'sans-serif', 'cursive']), r.families);
  check('Office line heights', JSON.stringify(r.heights) === JSON.stringify([1.22, 1.33, 1.21, 1.15, 1.14, 1.12, 1.17, 1.17]), r.heights);
  check('line scale is Office height over the font height, within 0.7 and 1.4',
    Math.abs(r.scales[0] - 1.22 / 1.362) < 1e-6 && Math.abs(r.scales[1] - 1.17 / 1.362) < 1e-6 && r.scales[2] === 1.4 && r.scales[3] === 0.7, r.scales);
  check('phone line height from the font metrics', Math.abs(r.phone[0] - 1.362) < 1e-9 && Math.abs(r.phone[1] - 1.362) < 1e-9, r.phone);
  check('width scale clamps to 0.75..1.25', Math.abs(r.width[0] - 0.507 / 0.572) < 1e-6 && r.width[1] === 1 && r.width[2] === 1.25 && r.width[3] === 0.75, r.width);
  check('superscript and small capitals are drawn smaller, raised and dropped as in the app',
    Math.abs(r.styles[0] - 6.5) < 1e-9 && Math.abs(r.styles[1] - 8) < 1e-9 && Math.abs(r.styles[2] + 3.3) < 1e-9 && Math.abs(r.styles[3] - 1.4) < 1e-9 && Math.abs(r.styles[4] - 1.3) < 1e-9, r.styles);
  check("Word's automatic colour turns white on dark shading", r.styles[5] === 1 && r.styles[6] === 1 && r.styles[7] === 0, r.styles);
  check('monospace italic is slanted, Hindi from Noto Sans Devanagari next', r.stack[0] === 'NotoSansMono-Regular.ttf/' && r.stack[1] === 'NotoSansDevanagari-Regular.ttf/', r.stack);
  const [c1, c2, c3, c4, c5, c6] = r.colors;
  check('CSS and ARGB colours parse', c1.r === 0.8 && c1.g === 0 && c2.b === 1 && c2.a === 0.5 && c3.r === 1 && Math.abs(c3.a - 128 / 255) < 1e-9 &&
    Math.abs(c4.g - 0.5) < 0.01 && Math.abs(c5.r - 0x66 / 255) < 1e-9 && c6 === null, r.colors);
}

async function languages(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const paragraphs = [
      { lang: 'en', text: 'The quick brown fox jumps over the lazy dog, while the office staff finish their coffee and file the reports before the long weekend begins.', base: { size: 12 } },
      { lang: 'fr', text: 'O\u00F9 est pass\u00E9e la cl\u00E9 ? \u00C7a co\u00FBte trente-cinq euros, s\u2019il vous pla\u00EEt. L\u2019\u00E9l\u00E8ve fran\u00E7ais \u00E9crit \u00E0 l\u2019\u00E9cole avec une plume l\u00E9g\u00E8re et pr\u00E9cise.', base: { size: 12, font: 'Times New Roman' } },
      { lang: 'es', text: '\u00BFD\u00F3nde est\u00E1 la estaci\u00F3n? El ni\u00F1o comi\u00F3 jalape\u00F1os con la se\u00F1orita Mu\u00F1oz en el peque\u00F1o caf\u00E9 de la ciudad. \u00A1Qu\u00E9 d\u00EDa tan bonito!', base: { size: 12, font: 'Calibri' } },
      { lang: 'hi', text: '\u0928\u092E\u0938\u094D\u0924\u0947 \u0926\u0941\u0928\u093F\u092F\u093E\u0964 \u092D\u093E\u0930\u0924 \u090F\u0915 \u0935\u093F\u0936\u093E\u0932 \u0926\u0947\u0936 \u0939\u0948 \u091C\u0939\u093E\u0901 \u0905\u0928\u0947\u0915 \u092D\u093E\u0937\u093E\u090F\u0901 \u092C\u094B\u0932\u0940 \u091C\u093E\u0924\u0940 \u0939\u0948\u0902\u0964 \u0939\u093F\u0928\u094D\u0926\u0940 \u092E\u0947\u0902 \u0932\u093F\u0916\u093E \u0917\u092F\u093E \u092F\u0939 \u0905\u0928\u0941\u091A\u094D\u091B\u0947\u0926 \u0915\u094D\u0937\u0924\u094D\u0930\u093F\u092F, \u092A\u094D\u0930\u0947\u092E, \u0915\u0943\u0937\u094D\u0923 \u0914\u0930 \u0926\u094D\u0935\u093E\u0930 \u091C\u0948\u0938\u0947 \u0936\u092C\u094D\u0926\u094B\u0902 \u0938\u0947 \u092D\u0930\u093E \u0939\u0948\u0964', base: { size: 13 } },
      { lang: 'mixed', text: '\u092D\u093E\u0930\u0924 (India) \u090F\u0915 \u0926\u0947\u0936 \u0939\u0948, and Hindi \u0939\u093F\u0928\u094D\u0926\u0940 is spoken by \u0915\u0930\u094B\u0921\u093C\u094B\u0902 \u0932\u094B\u0917 across the country; \u0926\u0941\u0928\u093F\u092F\u093E says hello to the world.', base: { size: 12, font: 'Georgia' } },
    ];
    const width = 220;
    const doc = await common.createPdf();
    const out = [];
    for (const p of paragraphs) {
      const pg = doc.addPage([300, 400]);
      const c = new text.PdfCanvas(pg);
      const layout = await text.layoutParagraph({ text: p.text, base: p.base, width });
      layout.draw(c, 40, 40);
      out.push({ lang: p.lang, text: p.text, lines: layout.lineCount, widths: layout.lines.map((l) => l.width) });
    }
    const bytes = await common.savePdf(doc);
    for (let i = 0; i < out.length; i++) {
      const items = await window.T.items(bytes, i + 1);
      out[i].extracted = window.T.joined(items);
      out[i].maxRight = Math.max(...items.filter((it) => it.str.trim()).map((it) => it.x + it.w));
      out[i].minLeft = Math.min(...items.filter((it) => it.str.trim()).map((it) => it.x));
    }
    return { out, size: bytes.length };
  });
  for (const p of r.out) {
    check(`${p.lang}: wraps to the width`, p.lines >= 2 && p.widths.every((w) => w <= 220 + 1e-6), p.widths);
    check(`${p.lang}: extracts as written`, p.extracted === p.text, p.extracted);
    check(`${p.lang}: stays inside its box`, p.minLeft >= 39.9 && p.maxRight <= 40 + 220 + 1, [p.minLeft, p.maxRight]);
  }
  check('"\u0926\u0941\u0928\u093F\u092F\u093E" extracts in order', r.out[3].extracted.includes('\u0926\u0941\u0928\u093F\u092F\u093E') && !r.out[3].extracted.includes('\u0926\u0941 \u093F\u0928\u092F\u093E'));
  check('five pages of text in five languages stay small (subset fonts)', r.size < 60000, r.size);
}

async function hindiMatchesPreview(page) {
  // As the app's PageEditsDeviceTest.hindiTextIsShaped: the PDF's Hindi matches the preview's shaping and place.
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const words = '\u0939\u093F\u0928\u094D\u0926\u0940 \u092E\u0947\u0902 \u0932\u093F\u0916\u093E \u0917\u092F\u093E';
    const layout = await text.layoutText(words, { size: 28 });
    const doc = await common.createPdf();
    const pg = doc.addPage([400, 200]);
    layout.draw(new text.PdfCanvas(pg), 60, 40);
    const bytes = await common.savePdf(doc);
    const shot = await window.T.render(bytes, 1, 2);
    const canvas = window.T.canvas(shot.width, shot.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(2, 2);
    text.paintLayout(ctx, layout, 60, 40);
    const mine = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let both = 0;
    let either = 0;
    let wanted = 0;
    for (let i = 0; i < mine.length; i += 4) {
      const a = shot.data[i] < 100;
      const b = mine[i] < 100;
      if (a && b) both++;
      if (a || b) either++;
      if (b) wanted++;
    }
    return { overlap: both / either, wanted, extracted: window.T.joined(await window.T.items(bytes)) };
  });
  check('Hindi preview draws ink', r.wanted > 1000, r.wanted);
  check('the PDF matches the preview drawn with the same glyphs', r.overlap > 0.8, r.overlap);
  check('Hindi edit text extracts', r.extracted === '\u0939\u093F\u0928\u094D\u0926\u0940 \u092E\u0947\u0902 \u0932\u093F\u0916\u093E \u0917\u092F\u093E', r.extracted);
}

async function tabsAndJustification(page) {
  const r = await page.evaluate(async () => {
    const { text } = window.T;
    const runsOf = (layout) => layout.items(0, 0).filter((i) => i.kind === 'glyphs');
    const end = (run) => run.x + run.width;
    const tabs = await text.layoutParagraph({
      text: 'Left\tA\tMiddle\tRight\t12.75',
      base: { size: 10 },
      width: 500,
      tabs: [{ pos: 100 }, { pos: 200, align: 'center' }, { pos: 300, align: 'right' }, { pos: 400, align: 'decimal' }],
    });
    const runs = runsOf(tabs);
    const find = (s) => runs.find((r) => r.gtext.join('') .startsWith(s));
    const dotRun = find('12');
    const dotIndex = dotRun.gtext.indexOf('.');
    const leaders = await text.layoutParagraph({ text: 'Chapter one\t5', base: { size: 10 }, width: 300, tabs: [{ pos: 300, align: 'right', leader: 'dot' }] });
    const lr = runsOf(leaders);
    const defaults = await text.layoutParagraph({ text: 'a\tb', base: { size: 10 }, width: 300, defaultTab: 36 });
    const just = await text.layoutParagraph({ text: 'Justified text fills each line from edge to edge, except the last line of the paragraph, which stays as it is.', base: { size: 11 }, width: 180, align: 'justify' });
    const byLine = new Map();
    for (const run of runsOf(just)) byLine.set(run.y, Math.max(byLine.get(run.y) ?? 0, end(run)));
    const rights = [...byLine.values()];
    const center = await text.layoutParagraph({ text: 'Centred', base: { size: 11 }, width: 200, align: 'center' });
    const right = await text.layoutParagraph({ text: 'Right', base: { size: 11 }, width: 200, align: 'end' });
    return {
      left: find('A').x, center: (find('Middle').x + end(find('Middle'))) / 2, right: end(find('Right')),
      decimal: dotRun.x + dotRun.gx[dotIndex], leaderCount: lr.find((x) => x.gtext[0] === '.')?.gid.length ?? 0, leaderEnd: end(lr[lr.length - 1]),
      defaultTab: runsOf(defaults).find((x) => x.gtext[0] === 'b').x,
      rights, lines: just.lineCount,
      centred: center.lines[0].x + center.lines[0].width / 2, endAligned: right.lines[0].x + right.lines[0].width,
    };
  });
  check('left tab stop', Math.abs(r.left - 100) < 0.01, r.left);
  check('centre tab stop', Math.abs(r.center - 200) < 0.01, r.center);
  check('right tab stop', Math.abs(r.right - 300) < 0.01, r.right);
  check('decimal tab stop lines up the decimal point', Math.abs(r.decimal - 400) < 0.01, r.decimal);
  check('dot leaders fill a tab up to its stop', r.leaderCount > 20 && Math.abs(r.leaderEnd - 300) < 0.01, [r.leaderCount, r.leaderEnd]);
  check('default tab stops every 36 points', Math.abs(r.defaultTab - 36) < 0.01, r.defaultTab);
  check('justified lines reach the right edge, the last does not', r.lines >= 3 && r.rights.slice(0, -1).every((x) => Math.abs(x - 180) < 0.01) && r.rights[r.rights.length - 1] < 170, r.rights);
  check('centred and end alignment', Math.abs(r.centred - 100) < 0.01 && Math.abs(r.endAligned - 200) < 0.01, [r.centred, r.endAligned]);
}

async function lineSpacing(page) {
  const r = await page.evaluate(async () => {
    const { text } = window.T;
    const pitch = async (spacing, extra = {}) => {
      const l = await text.layoutParagraph({ text: 'one\ntwo\nthree', base: { size: 10 }, width: 300, spacing, ...extra });
      const lines = l.lines;
      return { pitch: lines[1].baseline - lines[0].baseline, first: lines[0].baseline, height: l.height };
    };
    const natural = 13.62;
    return {
      natural,
      single: await pitch(text.LineSpacing.SINGLE),
      double: await pitch(text.LineSpacing.multiple(2)),
      exact: await pitch(text.LineSpacing.exact(20)),
      atLeast: await pitch(text.LineSpacing.atLeast(30)),
      atLeastLess: await pitch(text.LineSpacing.atLeast(5)),
      scaled: await pitch(text.LineSpacing.SINGLE, { lineScale: 0.9 }),
      hindi: (await text.layoutParagraph({ text: '\u0939\u093F\u0928\u094D\u0926\u0940', base: { size: 10, family: 'serif' }, width: 300 })).height,
      empty: (await text.layoutParagraph({ text: '', base: { size: 20 }, width: 300 })).height,
      trailing: (await text.layoutParagraph({ text: 'one\n', base: { size: 10 }, width: 300 })).lineCount,
    };
  });
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check('single spacing is the font height', near(r.single.pitch, r.natural) && near(r.single.height, 3 * r.natural), r.single);
  check('double spacing, the extra above each line', near(r.double.pitch, 2 * r.natural) && near(r.double.first, 2 * r.natural - 2.93), r.double);
  check('exact spacing', near(r.exact.pitch, 20), r.exact);
  check('at least spacing', near(r.atLeast.pitch, 30) && near(r.atLeastLess.pitch, r.natural), [r.atLeast, r.atLeastLess]);
  check('line scale shrinks multiple spacing', near(r.scaled.pitch, 0.9 * r.natural), r.scaled);
  check('Hindi in serif: the Devanagari font deepens the line, the style font sets its top', near(r.hindi, 16.94), r.hindi);
  check('an empty paragraph is one line of its mark', near(r.empty, 27.24), r.empty);
  check('a text ending with a line break has an empty line after it, as on Android', r.trailing === 2, r.trailing);
}

async function paragraphBlocks(page) {
  const r = await page.evaluate(async () => {
    const { text } = window.T;
    // OfficeConverterDeviceTest.aParagraphSplitAfterALineBreakFitsItsSpace
    const block = await text.layoutParagraph({ text: 'one\ntwo\nthree\nfour', base: {}, width: 200, avoidSingleLines: false });
    const space = block.lineBottoms()[1];
    const [head, tail] = block.split(space, false);
    // A lone line isn't stranded: with 3 of 4 fitting, only 2 go.
    const widow = (await text.layoutParagraph({ text: 'one\ntwo\nthree\nfour', base: {}, width: 200 })).split(3 * 15.1, false);
    // OfficeConverterDeviceTest.aSuperscriptParagraphMarkLeavesItsTextWhereItIs
    const drawn = async (mark) => {
      const rich = new text.RichText().append('H', {}).append('2', { baseline: -1 }).append('O', {});
      const l = await text.layoutParagraph({ text: rich, base: mark, width: 200 });
      return JSON.stringify(l.items(10, 6).map((i) => [i.kind, i.x, i.y, i.gid]));
    };
    const same = (await drawn({})) === (await drawn({ baseline: 1, spacing: 3 }));
    const ell = await text.layoutParagraph({ text: 'A caption much too long for the little grey box it has to fit inside, so it is cut.', base: { size: 10 }, width: 120, maxLines: 2 });
    const longWord = await text.layoutParagraph({ text: 'Pneumonoultramicroscopicsilicovolcanoconiosis', base: { size: 12 }, width: 60 });
    const tiny = await text.layoutParagraph({ text: 'abc', base: { size: 12 }, width: 0.5 });
    const label = await text.layoutParagraph({ text: 'Item text', base: { size: 10 }, width: 200, firstIndent: 18, indent: 18, label: { text: '\u2022', x: 4, style: { size: 10 } } });
    const labelRun = label.items(0, 0).find((i) => i.kind === 'glyphs' && i.gtext.join('') === '\u2022');
    const mirrored = await text.layoutParagraph({ text: 'Mirrored', base: { size: 10 }, width: 200, firstIndent: 30, indent: 30, mirrored: true, align: 'end' });
    const rules = await text.layoutParagraph({ text: 'Ruled', base: { size: 10 }, width: 200, background: '#eee', ruleAbove: { width: 1, color: '#f00', gap: 2 }, ruleBelow: { width: 2, color: '#00f', gap: 3 } });
    const ri = rules.items(0, 0);
    return {
      fits: head.height <= space + 1e-6, tail: !!tail, headLines: head.lineCount, tailText: tail.text,
      widow: widow[0].lineCount, same,
      ellLines: ell.lineCount, ellText: ell.items(0, 0).filter((i) => i.kind === 'glyphs').map((i) => i.gtext.join('')).join(''),
      longWidths: longWord.lines.map((l) => l.width), longText: longWord.lines.map((l) => longWord.text.slice(l.start, l.end)).join(''),
      tinyLines: tiny.lineCount, labelX: labelRun?.x, labelY: labelRun?.y, firstBaseline: label.firstBaseline,
      mirroredRight: mirrored.lines[0].x + mirrored.lines[0].width,
      rules: ri.filter((i) => i.kind === 'line').map((i) => [i.y1, i.width]), background: ri[0].kind === 'rect' && ri[0].w === 200, height: rules.height,
    };
  });
  check('a paragraph split after a line break fits its space', r.fits && r.tail && r.headLines === 2 && r.tailText === 'three\nfour', r);
  check('a lone last line is not stranded', r.widow === 2, r.widow);
  check("a superscript paragraph mark leaves its text where it is", r.same);
  check('max lines with an ellipsis', r.ellLines === 2 && r.ellText.endsWith('\u2026'), r.ellText);
  check('a word longer than the line is broken between its letters', r.longWidths.length > 1 && r.longWidths.every((w) => w <= 60 + 1e-6) && r.longText === 'Pneumonoultramicroscopicsilicovolcanoconiosis', r.longWidths);
  check('a line too narrow for one letter still takes a letter per line', r.tinyLines === 3, r.tinyLines);
  check('a list label sits on the first baseline', Math.abs(r.labelX - 4) < 1e-6 && Math.abs(r.labelY - r.firstBaseline) < 1e-6, [r.labelX, r.labelY]);
  check('a mirrored paragraph keeps its indent on the right', Math.abs(r.mirroredRight - 170) < 1e-6, r.mirroredRight);
  check('rules above and below, and the background', r.rules.length === 2 && Math.abs(r.rules[0][0] + 2.5) < 1e-6 && Math.abs(r.rules[1][0] - (r.height + 4)) < 1e-6 && r.background, r.rules);
}

async function fallbackCharacters(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const doc = await common.createPdf();
    const pg = doc.addPage([300, 200]);
    const c = new text.PdfCanvas(pg);
    const l = await text.layoutText('\u4E2D\u6587 English \uD83D\uDE00', { size: 40 });
    l.draw(c, 20, 20);
    const bytes = await common.savePdf(doc);
    const shot = await window.T.render(bytes, 1, 2);
    const items = await window.T.items(bytes);
    const runs = l.items(20, 20).filter((i) => i.kind === 'fallback');
    const zhong = runs[0];
    return {
      missing: text.missingCharacters('\u4E2D\u6587 abc \u0939\u093F \uD83D\uDE00'),
      canDraw: [text.canDraw('Hello \u0939\u093F\u0928\u094D\u0926\u0940'), text.canDraw('\u4E2D\u6587'), text.canDraw('\u{10FFFD}')],
      ink: shot.ink(zhong.x, zhong.y - 40, zhong.x + zhong.width, zhong.y + 10),
      emojiColour: (() => {
        const e = runs[runs.length - 1];
        let coloured = 0;
        for (let y = e.y - 35; y < e.y + 5; y += 1) for (let x = e.x; x < e.x + e.width; x += 1) {
          const [rr, gg, bb] = shot.px(x, y);
          if (Math.max(rr, gg, bb) - Math.min(rr, gg, bb) > 60) coloured++;
        }
        return coloured;
      })(),
      text: window.T.joined(items),
    };
  });
  check('characters no bundled font has are found', JSON.stringify(r.missing) === JSON.stringify(['\u4E2D', '\u6587', '\uD83D\uDE00']), r.missing);
  check('canDraw: bundled fonts and the browser, not unknown characters', r.canDraw[0] && r.canDraw[1] && !r.canDraw[2], r.canDraw);
  check('a Chinese character shows (rendered pixels not blank)', r.ink > 400, r.ink);
  check('an emoji keeps its colours', r.emojiColour > 50, r.emojiColour);
  check('characters drawn as pictures are still text', r.text === '\u4E2D\u6587 English \uD83D\uDE00', r.text);
}

/**
 * Missing characters as each browser draws them: Chromium and WebKit draw one box for all, Firefox
 * a box with the character's code in hex inside (so each differs), and none of them is a glyph.
 * Real glyphs, box-shaped ones included, must not be taken for one.
 */
async function missingBoxes(page, browser) {
  const r = await page.evaluate(() => {
    const { text } = window.T;
    const name = (s) => [...s].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ');
    // Unassigned code points (in the first plane and beyond), and one under a combining mark.
    const missing = ['\u{378}', '\u{379}', '\u{380}', '\u{5FF}', '\u{2FFFD}', '\u{E0080}', '\u{378}\u{301}'];
    // Latin, Devanagari (a conjunct too), Chinese, Japanese, Korean, box-shaped glyphs and emoji
    // (a skin tone, a joined sequence, a flag, a keycap).
    const real = [
      'A', '\u{E9}', '\u{915}', '\u{915}\u{94D}\u{937}', '\u{939}\u{93F}', '\u{4E2D}', '\u{6587}', '\u{65E5}', '\u{D55C}', '\u{3042}',
      '\u{53E3}', '\u{30ED}', '\u{25A1}', '\u{25AF}', '\u{1F600}', '\u{1F44D}\u{1F3FD}',
      '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}', '\u{1F1EE}\u{1F1F3}', '1\u{FE0F}\u{20E3}',
    ];
    const out = {};
    for (const kind of ['sans', 'serif', 'mono']) {
      out[kind] = {
        missingDrawn: missing.filter((c) => text.browserCanDraw(c, kind)).map(name),
        realRefused: real.filter((c) => !text.browserCanDraw(c, kind)).map(name),
      };
    }
    out.canDraw = [
      text.canDraw('\u{378}'), text.canDraw('Watermark \u{378}'), text.canDraw('\u{2FFFD}'), text.canDraw('\u{378}', { family: 'serif' }),
      text.canDraw('\u{4E2D}\u{6587} \u{1F600} \u{939}\u{93F}\u{928}\u{94D}\u{926}\u{940}'), text.canDraw('\u{4E2D}\u{3000}\u{6587}'),
    ];
    return out;
  });
  for (const kind of ['sans', 'serif', 'mono']) {
    check(`${browser}: missing characters are boxes in ${kind}`, r[kind].missingDrawn.length === 0, r[kind].missingDrawn);
    check(`${browser}: real glyphs are not boxes in ${kind}`, r[kind].realRefused.length === 0, r[kind].realRefused);
  }
  check(`${browser}: canDraw refuses missing characters, not CJK, emoji, Hindi or an ideographic space`,
    JSON.stringify(r.canDraw) === JSON.stringify([false, false, false, false, true, true]), r.canDraw);
}

async function shapesAndImages(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const doc = await common.createPdf();
    const pg = doc.addPage([400, 300]);
    const c = new text.PdfCanvas(pg);
    c.fillStyle = '#ff0000';
    c.fillRect(10, 10, 40, 40);
    c.globalAlpha = 0.5;
    c.fillStyle = 'blue';
    c.fillRect(60, 10, 40, 40);
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(0, 128, 0, 0.5)';
    c.fillRect(110, 10, 40, 40);
    // Clipped to a circle.
    c.save();
    c.beginPath();
    c.arc(180, 30, 20, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#00aa00';
    c.fillRect(160, 10, 40, 40);
    c.restore();
    // Even-odd: a ring.
    c.beginPath();
    c.arc(240, 30, 20, 0, Math.PI * 2);
    c.arc(240, 30, 8, 0, Math.PI * 2);
    c.fillStyle = '#800080';
    c.fill('evenodd');
    // Non-zero, both circles drawn the same way round: a full disc.
    c.beginPath();
    c.arc(290, 30, 20, 0, Math.PI * 2);
    c.arc(290, 30, 8, 0, Math.PI * 2);
    c.fill();
    // Transforms: a square turned 45 degrees around (350, 30).
    c.save();
    c.translate(350, 30);
    c.rotate(Math.PI / 4);
    c.fillStyle = '#000';
    c.fillRect(-10, -10, 20, 20);
    c.restore();
    // Strokes: width scales with the transform, dashes, caps.
    c.save();
    c.scale(2, 2);
    c.strokeStyle = '#0000ff';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(10, 40);
    c.lineTo(60, 40);
    c.stroke();
    c.restore();
    c.strokeStyle = '#ff00ff';
    c.lineWidth = 4;
    c.setLineDash([10, 10]);
    c.beginPath();
    c.moveTo(150, 100);
    c.lineTo(250, 100);
    c.stroke();
    c.setLineDash([]);
    // Gradients.
    const g = c.createLinearGradient(10, 0, 110, 0);
    g.addColorStop(0, '#ff0000');
    g.addColorStop(1, '#0000ff');
    c.fillStyle = g;
    c.fillRect(10, 120, 100, 30);
    const rg = c.createRadialGradient(170, 135, 0, 170, 135, 30);
    rg.addColorStop(0, '#ffff00');
    rg.addColorStop(1, 'rgba(255,255,0,0)');
    c.fillStyle = rg;
    c.fillRect(140, 105, 60, 60);
    // Pictures: one with transparency, one opaque (JPEG).
    const see = window.T.canvas(20, 20);
    const sc = see.getContext('2d');
    sc.fillStyle = 'rgba(255, 0, 0, 0.5)';
    sc.fillRect(0, 0, 20, 20);
    c.drawImage(see, 220, 120, 40, 40);
    const photo = window.T.canvas(32, 32);
    const pc = photo.getContext('2d');
    pc.fillStyle = '#00ff00';
    pc.fillRect(0, 0, 32, 32);
    pc.fillStyle = '#0000ff';
    pc.fillRect(16, 0, 16, 32);
    c.drawImage(photo, 270, 120, 64, 64);
    // Part of a picture (its right half).
    c.drawImage(photo, 16, 0, 16, 32, 340, 120, 20, 40);
    // Rounded rectangle and arcTo.
    c.fillStyle = '#ffa500';
    c.beginPath();
    c.roundRect(10, 200, 60, 40, 15);
    c.fill();
    c.strokeStyle = '#000';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(100, 240);
    c.arcTo(150, 200, 200, 240, 20);
    c.stroke();
    // Multiply blending, as Edit PDF's highlighter.
    c.fillStyle = '#ffff00';
    c.fillRect(220, 200, 60, 40);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = '#00ffff';
    c.fillRect(250, 200, 60, 40);
    c.globalCompositeOperation = 'source-over';
    // A form drawn see-through fades as a whole, whatever its own drawing sets.
    const form = text.createFormCanvas(doc, 20, 20);
    form.fillStyle = '#000';
    form.fillRect(0, 0, 20, 20);
    c.globalAlpha = 0.5;
    c.drawForm(form, 360, 200);
    c.globalAlpha = 1;
    const bytes = await common.savePdf(doc);
    const s = await window.T.render(bytes, 1, 2);
    const at = (x, y) => s.px(x, y);
    return {
      red: at(30, 30), halfBlue: at(80, 30), halfGreen: at(130, 30),
      clippedIn: at(180, 30), clippedCorner: at(162, 12),
      ringCentre: at(240, 30), ring: at(240, 15), disc: at(290, 30),
      rotatedCorner: at(341.5, 21.5), rotatedTip: at(350, 17), rotatedOut: at(359, 21),
      thick: [at(40, 77.5), at(40, 85), at(40, 82.5)], dashOn: at(155, 100), dashOff: at(165, 100),
      gradLeft: at(12, 135), gradRight: at(108, 135), radialCentre: at(170, 135), radialEdge: at(140, 106),
      halfRed: at(240, 140), photoLeft: at(285, 150), photoRight: at(320, 150), cropped: at(350, 140),
      round: at(40, 220), roundCorner: at(11, 201), arc: s.ink(140, 205, 160, 225, 100),
      yellow: at(230, 220), multiplied: at(265, 220), cyan: at(300, 220), fadedForm: at(370, 210),
      size: bytes.length,
    };
  });
  const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  check('fillRect', near(r.red, [255, 0, 0]), r.red);
  check('globalAlpha', near(r.halfBlue, [128, 128, 255]), r.halfBlue);
  check('colour with alpha', near(r.halfGreen, [128, 192, 128]), r.halfGreen);
  check('clip to a circle', near(r.clippedIn, [0, 170, 0]) && near(r.clippedCorner, [255, 255, 255]), [r.clippedIn, r.clippedCorner]);
  check('even-odd fill leaves a hole', near(r.ringCentre, [255, 255, 255]) && near(r.ring, [128, 0, 128]), [r.ringCentre, r.ring]);
  check('non-zero fill fills both circles', near(r.disc, [128, 0, 128]), r.disc);
  check('translate and rotate', near(r.rotatedTip, [0, 0, 0]) && near(r.rotatedCorner, [255, 255, 255]) && near(r.rotatedOut, [255, 255, 255]), [r.rotatedTip, r.rotatedCorner, r.rotatedOut]);
  check('line width scales with the transform', near(r.thick[0], [0, 0, 255]) && near(r.thick[1], [255, 255, 255]) && near(r.thick[2], [0, 0, 255]), r.thick);
  check('dashed line', near(r.dashOn, [255, 0, 255]) && near(r.dashOff, [255, 255, 255]), [r.dashOn, r.dashOff]);
  check('linear gradient', r.gradLeft[0] > 200 && r.gradLeft[2] < 60 && r.gradRight[2] > 200 && r.gradRight[0] < 60, [r.gradLeft, r.gradRight]);
  check('radial gradient fading out', near(r.radialCentre, [255, 255, 0]) && near(r.radialEdge, [255, 255, 255]), [r.radialCentre, r.radialEdge]);
  check('picture with transparency', near(r.halfRed, [255, 128, 128]), r.halfRed);
  check('opaque picture (JPEG)', near(r.photoLeft, [0, 255, 0]) && near(r.photoRight, [0, 0, 255]), [r.photoLeft, r.photoRight]);
  check('part of a picture', near(r.cropped, [0, 0, 255]), r.cropped);
  check('rounded rectangle', near(r.round, [255, 165, 0]) && near(r.roundCorner, [255, 255, 255]), [r.round, r.roundCorner]);
  check('arcTo draws a rounded corner', r.arc > 10, r.arc);
  check('a form drawn with globalAlpha', near(r.fadedForm, [128, 128, 128], 20), r.fadedForm);
  check('multiply blending', near(r.yellow, [255, 255, 0]) && near(r.multiplied, [0, 255, 0]) && near(r.cyan, [0, 255, 255]), [r.yellow, r.multiplied, r.cyan]);
}

async function existingPages(page) {
  const r = await page.evaluate(async () => {
    const { text, common, lib } = window.T;
    // A page turned 90 degrees with a crop box, whose drawing leaves the transform changed (no q/Q).
    const src = await common.createPdf();
    const p = src.addPage([300, 500]);
    p.setCropBox(10, 20, 280, 460);
    p.setRotation(lib.degrees(90));
    const leak = src.context.register(src.context.flateStream('2 0 0 2 0 0 cm 0 0 1 rg'));
    p.node.normalize();
    p.node.addContentStream(leak);
    const loaded = await common.loadPdf(await src.save());
    const page = loaded.getPage(0);
    const c = new text.PdfCanvas(page);
    c.fillStyle = '#ff0000';
    c.fillRect(0, 0, 30, 30);
    c.fillText('Top left as shown', 40, 20, { size: 12 });
    c.link(40, 8, 100, 14, 'https://example.org/page');
    c.link(40, 30, 100, 14, 'javascript:alert(1)');
    const bytes = await common.savePdf(loaded);
    const s = await window.T.render(bytes, 1, 2);
    const items = await window.T.items(bytes);
    const pdf = await window.T.pdfjs.openPdfJs(bytes);
    const annots = await (await pdf.getPage(1)).getAnnotations();
    await pdf.loadingTask.destroy();
    return {
      size: [c.width, c.height], corner: s.px(5, 5), beyond: s.px(40, 45), canvasW: s.width / 2,
      text: window.T.joined(items), annots: annots.map((a) => a.url ?? null),
    };
  });
  check('a turned page is drawn on as shown', r.size[0] === 460 && r.size[1] === 280 && Math.abs(r.canvasW - 460) < 1, r.size);
  check('drawing starts at the shown top-left corner, unmoved by the page\'s own drawing', r.corner[0] > 200 && r.corner[1] < 60 && r.corner[2] < 60 && r.beyond[0] > 200 && r.beyond[1] > 200, [r.corner, r.beyond]);
  check('text on an existing page', r.text === 'Top left as shown', r.text);
  check('links: web addresses yes, scripts no', JSON.stringify(r.annots) === JSON.stringify(['https://example.org/page']), r.annots);
}

async function navigation(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const doc = await common.createPdf();
    const p1 = doc.addPage([300, 400]);
    const p2 = doc.addPage([300, 400]);
    const c1 = new text.PdfCanvas(p1);
    const c2 = new text.PdfCanvas(p2);
    c2.addDestination('chapter-2', 0, 100);
    const rich = new text.RichText().append('Go to chapter two', { size: 12, link: { dest: 'chapter-2' } }).append(' or ', { size: 12 }).append('the site', { size: 12, link: { url: 'https://usugami.com/' } });
    (await text.layoutParagraph({ text: rich, width: 250 })).draw(c1, 20, 20);
    c1.link(20, 60, 50, 20, { page: 1, y: 200 });
    text.addOutline(doc, [
      { title: 'Chapter 1', page: 0, top: 380, children: [{ title: 'Section 1.1', page: 0, y: 100 }] },
      { title: 'Chapter 2 \u2014 \u0926\u0941\u0928\u093F\u092F\u093E', dest: 'chapter-2' },
    ]);
    const bytes = await common.savePdf(doc);
    const pdf = await window.T.pdfjs.openPdfJs(bytes);
    const annots = await (await pdf.getPage(1)).getAnnotations();
    const outline = await pdf.getOutline();
    const dest = await pdf.getDestination('chapter-2');
    const pageOf = async (d) => (d && typeof d[0] === 'object' ? pdf.getPageIndex(d[0]) : null);
    const first = outline[0].dest;
    const res = {
      annots: annots.map((a) => a.url ?? a.dest).map((d) => (Array.isArray(d) ? 'explicit' : d)),
      linkRects: annots.map((a) => a.rect.map(Math.round)),
      outline: outline.map((o) => [o.title, o.items.map((i) => i.title), o.count ?? 0]),
      firstPage: await pageOf(first), firstTop: first[3],
      dest: dest && [await pageOf(dest), dest[3]],
      explicit: await pageOf(annots.find((a) => Array.isArray(a.dest))?.dest),
    };
    await pdf.loadingTask.destroy();
    return res;
  });
  check('internal links, named and explicit, and web links', JSON.stringify(r.annots) === JSON.stringify(['chapter-2', 'https://usugami.com/', 'explicit']), r.annots);
  check('link rectangles in page coordinates', r.linkRects[0][0] === 20 && r.linkRects[0][3] <= 380 && r.linkRects[0][1] >= 350, r.linkRects);
  check('nested bookmarks, children folded', JSON.stringify(r.outline) === JSON.stringify([['Chapter 1', ['Section 1.1'], -1], ['Chapter 2 \u2014 \u0926\u0941\u0928\u093F\u092F\u093E', [], 0]]), r.outline);
  check('bookmark destination: page and top', r.firstPage === 0 && r.firstTop === 380, [r.firstPage, r.firstTop]);
  check('named destination', r.dest && r.dest[0] === 1 && r.dest[1] === 300, r.dest);
  check('explicit link destination page', r.explicit === 1, r.explicit);
}

async function finishAndCopy(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const a = await common.createPdf();
    const c = new text.PdfCanvas(a.addPage([300, 200]));
    c.fillText('Copied \u0928\u092E\u0938\u094D\u0924\u0947', 20, 40, { size: 14 });
    // Written now, so the page can be copied to another PDF before this one is saved.
    await text.finishText(a);
    const b = await common.createPdf();
    const [copied] = await b.copyPages(a, [0]);
    b.addPage(copied);
    // Drawing goes on after finishText, in a new content stream.
    c.fillText('and more', 20, 80, { size: 14 });
    const bytesB = await common.savePdf(b);
    const bytesA = await common.savePdf(a);
    return { b: window.T.joined(await window.T.items(bytesB)), a: window.T.joined(await window.T.items(bytesA)) };
  });
  check('pages drawn on can be copied after finishText', r.b === 'Copied \u0928\u092E\u0938\u094D\u0924\u0947', r.b);
  check('drawing goes on after finishText', r.a === 'Copied \u0928\u092E\u0938\u094D\u0924\u0947 and more', r.a);
}

async function canvasText(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    await text.ensureFonts('Wide text', { size: 20, bold: true });
    const doc = await common.createPdf();
    const pg = doc.addPage([400, 300]);
    const c = new text.PdfCanvas(pg);
    c.font = 'bold 20px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#123456';
    const metrics = c.measureText('Wide text');
    c.fillText('Wide text', 200, 50);
    c.textAlign = 'start';
    c.textBaseline = 'alphabetic';
    c.fillText('Squeezed into fifty points', 20, 100, 50);
    c.font = 'italic 16px serif';
    c.strokeStyle = '#000';
    c.lineWidth = 0.5;
    c.strokeText('Outline', 20, 150);
    c.save();
    c.translate(300, 200);
    c.rotate(-Math.PI / 4);
    c.globalAlpha = 0.3;
    c.textAlign = 'center';
    c.fillText('WATERMARK', 0, 0, { size: 30, bold: true, color: '#d32f2f' });
    c.restore();
    // A form drawn twice: the same text in each.
    const form = text.createFormCanvas(doc, 80, 20);
    form.fillText('Stamp', 5, 15, { size: 12 });
    c.drawForm(form, 20, 250);
    c.drawForm(form, 120, 250, 40, 10);
    const bytes = await common.savePdf(doc);
    const items = await window.T.items(bytes);
    const s = await window.T.render(bytes, 1, 2);
    const wide = items.find((i) => i.str === 'Wide text');
    const squeezed = items.find((i) => i.str.startsWith('Squeezed'));
    const line = items.filter((i) => Math.abs(i.y - squeezed.y) < 0.5 && i.str.trim());
    const squeezedWidth = Math.max(...line.map((i) => i.x + i.w)) - Math.min(...line.map((i) => i.x));
    return {
      metrics: [metrics.width, metrics.actualBoundingBoxAscent, metrics.fontBoundingBoxAscent],
      centre: wide && wide.x + wide.w / 2, squeezedWidth,
      text: items.map((i) => i.str).filter((x) => x.trim()).join(' '),
      colour: (() => {
        for (let x = 160; x < 240; x += 0.5) {
          const p = s.px(x, 50);
          if (p[0] < 128) return p;
        }
        return null;
      })(),
      watermark: s.px(300, 200),
    };
  });
  check('measureText', r.metrics[0] > 80 && r.metrics[0] < 110 && r.metrics[1] > 10 && r.metrics[1] < 16 && Math.abs(r.metrics[2] - 21.38) < 0.01, r.metrics);
  check('textAlign centre', Math.abs(r.centre - 200) < 1, r.centre);
  check('maxWidth squeezes the text', Math.abs(r.squeezedWidth - 50) < 1, r.squeezedWidth);
  check('canvas text in fillStyle', r.colour && Math.abs(r.colour[0] - 0x12) < 50 && Math.abs(r.colour[2] - 0x56) < 50, r.colour);
  check('text drawn by the canvas and in forms is real text', r.text === 'Wide text Squeezed into fifty points Outline WATERMARK Stamp Stamp', r.text);
}

async function deferredText(page, url) {
  // A fresh page: no font loaded yet. Text drawn before its fonts load still lands in place.
  await setup(page, url);
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const doc = await common.createPdf();
    const pg = doc.addPage([300, 200]);
    const c = new text.PdfCanvas(pg);
    c.fillStyle = '#eeeeee';
    c.fillRect(0, 0, 300, 200);
    c.fillText('Drawn before its fonts loaded: \u0928\u092E\u0938\u094D\u0924\u0947', 10, 30, { size: 10, family: 'serif' });
    c.fillStyle = '#000';
    c.fillRect(10, 40, 5, 5);
    const bytes = await common.savePdf(doc);
    return window.T.joined(await window.T.items(bytes));
  });
  check('text drawn before its fonts load is written once they have', r === 'Drawn before its fonts loaded: \u0928\u092E\u0938\u094D\u0924\u0947', r);
}

async function robustness(page) {
  const r = await page.evaluate(async () => {
    const { text, common } = window.T;
    const out = {};
    const weird = await text.layoutParagraph({ text: '\uD800abc\u0000\uFFFF\u200D\u00AD\uFE0F\u0301', base: { size: NaN, font: 12345, color: 'not a colour' }, width: -5 });
    out.weird = [weird.lineCount, weird.height > 0];
    const t0 = performance.now();
    const long = await text.layoutParagraph({ text: 'a'.repeat(50000), base: { size: 10 }, width: 100 });
    out.longMs = performance.now() - t0;
    out.longLines = long.lineCount;
    const t1 = performance.now();
    const words = await text.layoutParagraph({ text: 'word '.repeat(40000), base: { size: 10 }, width: 300, align: 'justify' });
    out.wordsMs = performance.now() - t1;
    out.wordsLines = words.lineCount;
    const doc = await common.createPdf();
    const pg = doc.addPage([200, 200]);
    const c = new text.PdfCanvas(pg);
    c.fillText('ignored', Infinity, NaN);
    c.fillStyle = 'nonsense';
    c.lineWidth = -1;
    c.moveTo(NaN, 0);
    c.arc(10, 10, 5, 0, 7);
    c.fill();
    c.restore();
    c.restore();
    weird.draw(c, 10, 10);
    c.drawImage(null, 0, 0);
    let threw = false;
    try { c.arc(0, 0, -1, 0, 1); } catch (e) { threw = e instanceof RangeError; }
    out.rangeError = threw;
    const bytes = await common.savePdf(doc);
    out.saved = bytes.length > 100;
    out.text = window.T.joined(await window.T.items(bytes));
    return out;
  });
  check('odd text and styles lay out without failing', r.weird[0] === 1 && r.weird[1], r.weird);
  check('a 50,000-letter word lays out quickly', r.longLines > 100 && r.longMs < 5000, [r.longLines, r.longMs]);
  check('40,000 words lay out quickly', r.wordsLines > 500 && r.wordsMs < 5000, [r.wordsLines, r.wordsMs]);
  check('bad canvas arguments are ignored as a canvas ignores them', r.saved && r.rangeError, r);
  check('the odd text still extracts', r.text.includes('abc'), r.text);
}

// ---------------------------------------------------------------------------------------------

await withPage(async (page, url) => {
  await setup(page, url);
  await fontsAndData(page);
  await languages(page);
  await hindiMatchesPreview(page);
  await tabsAndJustification(page);
  await lineSpacing(page);
  await paragraphBlocks(page);
  await fallbackCharacters(page);
  await missingBoxes(page, 'chromium');
  await shapesAndImages(page);
  await existingPages(page);
  await navigation(page);
  await finishAndCopy(page);
  await canvasText(page);
  await robustness(page);
  await deferredText(page, url);
}, { viewport: { width: 1200, height: 900 } });

// The core on the other engines the site supports.
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await setup(page, url);
    await languages(page);
    await fallbackCharacters(page);
    await missingBoxes(page, browser);
    await shapesAndImages(page);
    await canvasText(page);
  }, { browser, viewport: { width: 1200, height: 900 } });
  console.log(`${browser}: ok`);
}

console.log(`text: ${passed} checks passed`);
