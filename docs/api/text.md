# Text engine (`site/app/js/engine/text/`)

Fonts, rich-text paragraph layout and **PdfCanvas**, a canvas-like drawing surface on a pdf-lib
page. It stands in for what the Android app draws with `Canvas`, `Typeface`, `StaticLayout` and
`PdfDocument`: Word, PowerPoint, Excel and EPUB to PDF, Add page numbers, Add watermark and Edit
PDF draw their text, shapes and pictures with it.

- Text stays **real text**: selectable, searchable, copyable (Hindi included, in the right order),
  with only the glyphs used of each font embedded (subsets), so PDFs stay small.
- **Units are points**, the origin is the **top-left** corner, **y goes down** (as on a canvas).
- Fonts load on demand from `site/app/fonts/` (Noto). Characters no bundled font has (Chinese,
  Japanese, Korean, emoji, Arabic, Thai...) are drawn by the browser into a sharp picture placed in
  the line, with their text kept as invisible text over it.

```js
import { PdfCanvas, layoutParagraph, RichText, LineSpacing } from '../engine/text/index.js';
```

Everything below is exported from `engine/text/index.js`; the same names are also exported by
the module named in each section (`fonts.js`, `layout.js`, `canvas.js`, `paint.js`,
`fallback.js`, `color.js`, `linebreak.js`).

Contents: [Quick start](#quick-start) · [Styles](#styles) · [Fonts](#fonts-fontsjs) ·
[Rich text](#rich-text-layoutjs) · [Paragraphs](#paragraphs-layoutjs) ·
[Measuring](#measuring) · [PdfCanvas](#pdfcanvas-canvasjs) · [Text on the canvas](#text-on-the-canvas) ·
[Pictures](#pictures) · [Forms](#forms-drawn-many-times) · [Links, destinations, bookmarks](#links-destinations-and-bookmarks) ·
[Saving](#saving-and-copying-pages) · [Screen previews](#screen-previews-paintjs) ·
[Errors](#errors) · [Recipes](#recipes) · [Differences from the app](#differences-from-the-app)

---

## Quick start

```js
import { createPdf, savePdf } from '../engine/pdf-common.js';
import { PdfCanvas, layoutParagraph, RichText } from '../engine/text/index.js';

const doc = await createPdf();
const page = doc.addPage([595.28, 841.89]);           // A4
const canvas = new PdfCanvas(page);                   // top-left origin, points

const text = new RichText()
  .append('Hello ', { size: 12, font: 'Calibri' })
  .append('दुनिया', { size: 12, bold: true, color: '#d32f2f' });
const para = await layoutParagraph({ text, width: 400, align: 'justify' });
para.draw(canvas, 72, 72);                            // its box's top-left corner at (72, 72)

canvas.fillStyle = 'rgba(0, 0, 255, 0.3)';
canvas.fillRect(72, 72 + para.height + 10, 100, 20);

const bytes = await savePdf(doc);                      // fonts and content are written here
```

`savePdf` (or pdf-lib's `doc.save()`) writes everything the engine drew: there is nothing else to
call. See [Saving](#saving-and-copying-pages) for copying pages before saving.

---

## Styles

A **style** is a plain object describing how a run of text looks (OfficeText.kt's `TextStyle`).
Every field is optional:

| Field | Meaning | Default |
|---|---|---|
| `font` | An Office font name (`'Calibri'`, `'Times New Roman'`, `'Courier New'`...): picks the nearest family with `officeFamily()` | — |
| `family` | `'sans-serif'`, `'serif'`, `'monospace'`, `'cursive'`, `'casual'`, `'sans-serif-light'`, `'sans-serif-condensed'` (overrides `font`) | from `font`, else `'sans-serif'` |
| `size` | Font size in points | `11` |
| `bold`, `italic` | Weight and slant | `false` |
| `underline` | `true` or `'double'` | `false` |
| `strike` | Strikethrough | `false` |
| `color` | Text colour: CSS string (`'#c00'`, `'rgba(…)'`, `'hsl(…)'`, names) or ARGB number (`0xFF336699`, as Android's `Color`) | black |
| `background` | Colour behind the run (from line top to line bottom, as Android's `BackgroundColorSpan`) | none |
| `baseline` | `1` (or `'super'`) superscript, `-1` (or `'sub'`) subscript: drawn at 0.65 × size, raised 0.33 × size or dropped 0.14 × size | `0` |
| `caps`, `smallCaps` | Written in capitals; small capitals at 0.8 × size (as the app) | `false` |
| `spacing` | Extra points between letters (Word's character spacing) | `0` |
| `scaleX` | Width of the letters, 1 = as designed (Excel's width matching, see `widthScale`) | `1` |
| `autoColor` | Word's automatic colour: black, but white on dark shading (the run's `background`, or RichText's `behind`) | `false` |
| `link` | `{ url: 'https://…' }`, `{ dest: 'name' }` or `{ page: 2, y: 100 }`: the run becomes a link (see [Links](#links-destinations-and-bookmarks)) | — |
| `features` | OpenType features for fontkit, e.g. `{ liga: false }` (ligatures are off anyway with `spacing`) | — |
| `lang` | OpenType language tag for shaping (rarely needed) | — |

`resolveStyle(style, behind?)` (fonts.js) returns the style with everything worked out
(`{ family, kind: 'sans'|'serif'|'mono', size, drawnSize, bold, italic, color: {r,g,b,a}, background,
shift, letterSpacing (points), scaleX, stack, ... }`); every function accepts either form.

```js
resolveStyle({ size: 10, baseline: 1 }).drawnSize   // 6.5
resolveStyle({ size: 10, baseline: 1 }).shift       // -3.3 (points; negative is up)
resolveStyle({ autoColor: true }, '#202020').color  // { r: 1, g: 1, b: 1, a: 1 } (white on dark)
```

---

## Fonts (`fonts.js`)

The bundled fonts stand in for the phone's:

| Family | Files | Notes |
|---|---|---|
| sans-serif (also casual, light) | Noto Sans Regular, Bold, Italic, BoldItalic | |
| serif (also cursive, as italic) | Noto Serif, 4 styles | |
| monospace | Noto Sans Mono Regular, Bold | italic is slanted (as Android's fake italic, skew 0.25) |
| Hindi | Noto Sans / Noto Serif Devanagari Regular, Bold | italic is slanted |
| sans-serif-condensed | Noto Sans at `scaleX` 0.9 | |

For each character the engine uses the style's family, then Devanagari, then any other bundled
font that has it, then the browser (as a picture). Shaping (Devanagari conjuncts and vowel signs,
kerning, ligatures) is fontkit's.

### Office fonts (OfficeText.kt's `OfficeFonts`)

```js
officeFamily(name, bold = false): string
```
The app's family for an Office font name: `'monospace'` (Courier, Consolas, "Mono" in the name...),
`'serif'` (Times, Cambria, Georgia, Garamond...; not "Century Gothic"), `'cursive'` (script,
brush, corsiva...), `'casual'` (Comic), `'sans-serif-light'` (light/thin, not bold),
`'sans-serif-condensed'` (narrow/condensed), else `'sans-serif'`.
```js
officeFamily('Monotype Corsiva')        // 'cursive'
officeFamily('SourceCodePro-Regular')   // 'monospace'
```

```js
officeLineHeight(name): number
```
Word's single-spaced line height per point of size for that font: 1.22 (Calibri, Verdana, Aptos),
1.33 (Segoe), 1.21 (Tahoma, Century Gothic), 1.15 (Times, Arial, Helvetica, Liberation), 1.14
(Georgia, Courier), 1.12 (Garamond), else 1.17.

```js
phoneLineHeight(style): number     // the bundled font's line height per point: 1.362 for Noto Sans/Serif/Mono
lineScale(style, officeHeight = officeLineHeight(style.font)): number   // officeHeight / phoneLineHeight, within 0.7..1.4
```
Pass `lineScale(...)` as a paragraph's `lineScale` so lines are as tall as in Word (DocxConverter,
PptxConverter, XlsxText do this). Excel: `lineScale(style, officeLineHeight(name) + 0.14)`.

```js
digitWidth(style): number                 // width of "0" as a share of the size (0.572 for Noto Sans)
widthScale(officeDigitEm, style): number  // XlsxText.widthScale: officeDigitEm / digitWidth (as the family draws it), within 0.75..1.25; 1 if officeDigitEm is null
```
Excel draws cell text at the width of the workbook's font: `{ ...style, scaleX: widthScale(SheetUnits.digitEm(name), style) }`
(`digitEm` is the spreadsheet engine's port of SheetUnits). The digit compared is the one the
family draws, so a condensed family's 90 % counts: 'Arial Narrow' comes out with Arial Narrow's
digit width, not 10 % narrower (the scale goes on top of the family's own).

### Loading and characters

```js
await ensureFonts(text, style)            // loads every font `text` needs in `style`
await ensureFonts([{ text, style }, ...]) // or for several runs
fontsReady(text, style): boolean
loadFont(file): Promise<LoadedFont>       // e.g. 'NotoSans-Bold.ttf'; cached
missingCharacters(text, style): string[]  // clusters no bundled font has (drawn by the browser)
graphemes(text): string[]                 // user-perceived characters (Devanagari conjuncts kept whole)
needsGlyph(codePoint): boolean            // false for spaces, joiners, variation selectors, controls
isEmoji(cluster): boolean
fileMetrics(file)                          // { ascent, descent, underlinePosition, ... } in ems, known without loading
FONT_FILES, FONT_METRICS, ITALIC_SKEW (0.25), CONDENSED_SCALE (0.9)
```
The async layout functions load fonts themselves; `ensureFonts` is for the synchronous ones and
for `PdfCanvas.measureText`.

```js
canDraw(text, style = {}): boolean          // fallback.js
browserCanDraw(cluster, kind = 'sans'): boolean   // kind: 'sans' | 'serif' | 'mono' (resolveStyle(style).kind)
```
WatermarkText.canDraw: whether every character can be drawn, by a bundled font or by the
browser's fonts (a character that would show as a missing-glyph box can't). Add watermark and
Edit PDF use it to refuse text the device can't show (the app's `watermark_no_font`).
`browserCanDraw` is the browser half, for one cluster no bundled font has (cached per cluster).

How a missing character is told from a glyph: the cluster is drawn on a small canvas at 40 px and
compared with what the browser draws for characters no font has (U+FDD0, U+FFFF, U+2FEF,
U+FFE7, U+1FFFE, U+10FFFD, U+FFFFD). Chromium and WebKit on Windows draw one box for all of them, so the same pixels
mean missing. On Linux with GNU Unifont installed (as on GitHub's Ubuntu runners), Chromium and WebKit
draw unassigned characters of the first plane with Unifont's box holding the code in hex; U+2FEF and
U+FFE7 (unassigned) are such boxes there, so they match them by their frame. Firefox draws a box with the character's code in hex inside (four digits in the first
plane, six beyond, and the box can be wider for six), and Safari on Apple devices the Last Resort
font's box for the character's block, so the pixels differ inside: a cluster with the same advance,
its ink in exactly the same place, and the same frame (the edge of its ink) as one of those boxes is
missing too. No real glyph matches that closely; Latin, Devanagari, Chinese, Japanese, Korean,
emoji (with skin tones, flags, keycaps and joined sequences) and box-shaped glyphs (□ ▯ 口 ロ) are
checked in all three browsers. A cluster that draws no ink can't be drawn. As in the app, which
asks each character, every letter, number, symbol, punctuation or unassigned character of a cluster
must be drawable alone too (marks, joiners and selectors aren't asked alone), so a missing letter
under a combining mark is caught. Where nothing can be measured (no canvas), it says true.

---

## Rich text (`layout.js`)

```js
const rich = new RichText({ behind })   // behind: the shading under the text (for autoColor), optional
rich.append(text, style)                 // returns rich; capitals for caps/smallCaps
rich.appendObject(obj, style)            // an inline picture: one U+FFFC character
rich.text, rich.spans                    // the string; [{ start, end, style (resolved), obj? }]
rich.length, rich.isEmpty, rich.hasContent, rich.styleAt(index)
RichText.from(stringOrRunsOrRichText, style)
fitPictures(rich, most): RichText        // inline objects wider than `most` points shrunk to it, keeping their shape
OBJECT                                   // '￼'
```

An **inline object** (OfficeText.kt's `PictureSpan`) sits on the baseline like a large letter and
raises the line to its height:
```js
rich.appendObject({
  width: 120, height: 80,
  draw(target, { x, y, width, height }) {   // target: the PdfCanvas (or a screen 2D context)
    target.drawImage(bitmapOrPdfImage, x, y, width, height);
  },
}, style);
```
Line spacing never squeezes a line with a picture below its natural height (as the app).

---

## Paragraphs (`layout.js`)

```js
const para = await layoutParagraph(spec)    // ParagraphLayout
const para = layoutParagraphSync(spec)      // same, when fonts are loaded (prepareParagraph(spec) or ensureFonts)
await prepareParagraph(spec)                // loads what a spec needs
const para = await layoutText(text, style, options)   // plain text: lines at line breaks, wrapped only with options.width
```

`spec` (ParagraphSpec; **lengths in points**, not the app's tenth-of-a-point units):

| Field | Meaning | Default |
|---|---|---|
| `text` | `RichText`, a string, or `[{ text, style }]` runs | `''` |
| `base` | The paragraph mark's style: only an empty paragraph (and the empty line after a final line break) takes its height | first run's style |
| `style` | Style of a plain string `text` | `base` |
| `width` | Width of the paragraph's box | unlimited (no wrapping) |
| `align` | `'start'`, `'center'`, `'end'`, `'justify'` (start = left, or right in a right-to-left paragraph); also `'left'`, `'right'` | `'start'` |
| `firstIndent`, `indent` | From the box's left edge to the first line, and to the other lines (hanging indent: `firstIndent < indent`) | `0` |
| `rightIndent` | From the box's right edge | `0` |
| `spacing` | `LineSpacing.multiple(f)`, `.exact(points)`, `.atLeast(points)`, `LineSpacing.SINGLE` (or `{ multiple }`, `{ exact }`, `{ atLeast }`, or a number = multiple) | single |
| `lineScale` | Multiple spacing is scaled by this (see `lineScale()`) | `1` |
| `label` | `{ text, style, x }`: list number or bullet drawn on the first baseline, `x` points from the left edge (from the right when `mirrored`) | — |
| `rtl` | Right-to-left paragraph | `false` |
| `directionFromText` | Otherwise reads the way its first letter does (books); Word and PowerPoint pass `false` | `true` |
| `mirrored` | A right-to-left Word paragraph: `firstIndent`/`indent` measured from the right, `rightIndent` from the left | `false` |
| `background` | Colour filling the box (text area between the indents) | — |
| `tabs` | Tab stops: numbers (left stops) or `{ pos, align: 'left'|'center'|'right'|'decimal', leader: 'dot'|'hyphen'|'underscore'|'middleDot'|'none' }` | `[]` |
| `defaultTab` | After the last stop, stops every this many points | `36` |
| `avoidSingleLines` | `split()` keeps a lone first or last line from being stranded | `true` |
| `ruleAbove`, `ruleBelow` | `{ width, color, gap }`: lines drawn in the space above / below (`gap` from the text) | — |
| `maxLines`, `ellipsis` | At most this many lines; the last ends in "…" when text is cut | — , `true` |

Behaviour (as Android's StaticLayout in the app):
- Lines break where Unicode allows (after spaces, after hyphens and dashes, between Chinese and
  Japanese characters but not before closing punctuation, at Thai word boundaries, never inside a
  character and its marks); a word longer than the line is broken between its letters. A soft
  hyphen (U+00AD) where a line breaks shows a hyphen. Spaces at a line's end hang past the edge.
- Each line is as tall as the tallest font in it (Hindi lines are taller), times the line spacing;
  extra space goes **above** the text, as in Word. Exact spacing can make lines overlap, as in Word.
- Justification stretches the spaces of every line except the last and lines ending at a line
  break (and only the spaces after a line's last tab).
- Tab stops are measured from the line's start (after its indent), as Android measures them.
- A text ending with a line break has an empty line after it.

### ParagraphLayout

```js
para.height              // points
para.firstBaseline       // the first line's baseline, from the top
para.firstLineHeight     // the first line's bottom, from the top
para.contentWidth        // widest line, without the spaces it ends with (shrink-to-fit, unwrapped text)
para.width               // the width laid out to
para.lineCount
para.lines               // [{ start, end (text offsets), top, baseline, bottom, x, width, ascent, descent, hard, rtl }]
para.text                // this part's text
para.lineBottoms()       // [bottom of each line, from the top] (for PageBreaking)
para.split(space, force = false)   // [head, tail|null] or null: the lines that fit in `space` points (see below)
para.draw(target, x, y)  // box's top-left at (x, y) on a PdfCanvas or a 2D canvas context
para.items(x, y)         // what it draws (for custom renderers): rect, glyphs, fallback, object, line, link items
para.inkBounds()         // { left, top, right, bottom } of the glyphs' ink, from the box's top-left
```

`split()` is ParagraphBlock.split with PageBreaking.linesThatFit: it returns views of the same
laid-out lines (no layout again), so a long paragraph splits across pages quickly; the head of a
justified paragraph keeps its last line justified, a list label goes only on the first part and
`ruleAbove` / `ruleBelow` only on the first / last part. `null` means no line fits (with `force`,
at least one always does).

```js
let part = await layoutParagraph(spec);
while (part) {
  const parts = part.split(pageBottom - y, y === pageTop);
  if (!parts) { newPage(); continue; }
  parts[0].draw(canvas, left, y);
  y += parts[0].height;
  part = parts[1];
  if (part) newPage();
}
```

```js
linesThatFit(lineBottoms, space, avoidSingleLines, force, keepFirst = true, keepLast = true): number
```
PageBreaking.linesThatFit, for blocks of your own.

---

## Measuring

```js
const m = await measureText(text, style)   // measureTextSync when fonts are loaded
// { width, ascent, descent, height, ink: { left, top, right, bottom }, layout }
```
One line (it breaks only at line breaks). `ink` is relative to the start of the first baseline, y
down (so `ink.top` is negative): Android's `getTextBounds`, for the watermark's stamp size.
`m.layout.draw(canvas, x, y)` draws it with its box's top-left at (x, y); its baseline is
`y + m.layout.firstBaseline`.

Shrink to fit (PowerPoint, Excel): lay out again at smaller sizes; shaping is cached, so this is
cheap.
```js
let size = 18, para;
do { para = await layoutParagraph({ text: runsAt(size), width: box.w }); size -= 0.5; }
while (para.height > box.h && size > 4);
```

---

## PdfCanvas (`canvas.js`)

```js
const canvas = new PdfCanvas(page, { frame: 'shown' })
canvas.width, canvas.height    // the page as shown, in points
canvas.doc, canvas.page
```
`page` is a pdf-lib `PDFPage` (new or of a loaded PDF). The origin is the **top-left corner of
the page as shown**: its crop box, turned as its /Rotate turns it (PageEdits.kt's
`topLeftMatrix`), so page numbers and edits land where the user sees them on turned or cropped
pages. `frame: 'page'` uses the media box, unturned. The page's own drawing is wrapped in q/Q
first, so a transform or colour it leaves set can't move or recolour what is added. Several
canvases may draw on one page (each adds a content stream, drawn in order). Making a canvas
changes its page (that wrapping, an empty content stream), so make one only for pages you draw on:
Edit PDF leaves pages without edits exactly as they were.

The `CanvasRenderingContext2D` subset it implements, with the same names and meaning:

| Group | Members |
|---|---|
| State | `save()`, `restore()`, `reset()`; as Android's Canvas also `saveCount` and `restoreToCount(n)` (below) |
| Transform | `translate`, `rotate` (radians), `scale`, `transform`, `setTransform(a,b,c,d,e,f | matrix)`, `resetTransform`, `getTransform` |
| Paths | `beginPath`, `moveTo`, `lineTo`, `bezierCurveTo`, `quadraticCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, `closePath` |
| Painting | `fill(rule?)`, `fill(path, rule?)` (`'nonzero'` / `'evenodd'`), `stroke(path?)`, `clip(rule?)`, `clip(path, rule?)`, `fillRect`, `strokeRect`, `clearRect` (paints white: a PDF page can't be made see-through) |
| Style | `fillStyle`, `strokeStyle` (CSS colours, ARGB numbers or gradients), `globalAlpha`, `globalCompositeOperation` (`source-over` and the blend modes: `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`) |
| Lines | `lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `getLineDash`, `lineDashOffset` |
| Gradients | `createLinearGradient(x0,y0,x1,y1)`, `createRadialGradient(x0,y0,r0,x1,y1,r1)`, `gradient.addColorStop(offset, colour)` (PDF shadings; stops with varying alpha become a soft mask) |
| Pictures | `drawImage(image, dx, dy)`, `(image, dx, dy, dw, dh)`, `(image, sx, sy, sw, sh, dx, dy, dw, dh)`, `imageSmoothingEnabled` |
| Text | `font`, `textAlign`, `textBaseline`, `direction`, `letterSpacing`, `fillText`, `strokeText`, `measureText` |

Semantics follow the canvas: points are transformed when added to the path; line widths and
dashes are in the transform current when stroking; invalid values (NaN, unknown colours, negative
widths) are ignored; `clip()` keeps the path; `restore()` with nothing saved does nothing.

Save depth, as Android's `Canvas`: `canvas.saveCount` is 1 with nothing saved and one more for
each `save()` not restored; `save()` returns the count before it; `canvas.restoreToCount(n)`
restores until `n` is left (below 1 counts as 1). Use it to undo everything a drawing saved when it
fails partway:
```js
const depth = canvas.saveCount;      // or: const depth = canvas.save();
try { drawShape(canvas); } finally { canvas.restoreToCount(depth); }
```

`PdfPath` is a Path2D-like object (same path methods, `addPath(path, matrix?)`) for
`fill(path)`, `stroke(path)` and `clip(path)`; browser `Path2D` objects can't be read, so use
`new PdfPath()` instead.

Not supported: shadows, filters, patterns from images (`createPattern`), `isPointInPath`,
`getImageData`/`putImageData`, conic gradients, and composite operations other than the blend
modes above (they draw as `source-over`).

```js
// Edit PDF's highlighter: see-through and multiplied with the page.
canvas.save();
canvas.globalAlpha = 0.4;
canvas.globalCompositeOperation = 'multiply';
canvas.strokeStyle = '#ffeb3b';
canvas.lineWidth = 12;
canvas.lineCap = 'round';
canvas.lineJoin = 'round';
canvas.beginPath();
points.forEach(([x, y], i) => (i ? canvas.lineTo(x, y) : canvas.moveTo(x, y)));
canvas.stroke();
canvas.restore();
```

### Extras

```js
canvas.drawLayout(layout, x, y)        // = layout.draw(canvas, x, y)
canvas.drawItems(layout.items(x, y))   // custom renderers
canvas.toPage(x, y)                    // the page's own coordinates (PDF, y up) of a canvas point
canvas.close()                         // writes the content now (savePdf does it; see Saving)
pageFrame(page, frame = 'shown')       // { matrix (top-left canvas → page), width, height, rotation }
parseCssFont('italic bold 12px serif') // { size: 12, bold: true, italic: true, family: 'serif' }
```

---

## Text on the canvas

```js
canvas.fillText(text, x, y, style)     // style object (see Styles); its color defaults to fillStyle
canvas.fillText(text, x, y, maxWidth?) // canvas style: canvas.font, fillStyle, textAlign, textBaseline
canvas.strokeText(text, x, y, styleOrMaxWidth)
canvas.measureText(text)               // TextMetrics-like: width, actualBoundingBox*, fontBoundingBox*, emHeight*, baselines
```
One line (line breaks become spaces, as on a canvas); `maxWidth` squeezes it narrower.
`canvas.font` takes a CSS font: `'bold 12px sans-serif'`, `'italic 10px "Times New Roman"'`
(a family name goes through `officeFamily`); **px means points** here.

`fillText` and `strokeText` work before their fonts are loaded: the text is drawn into its place in
the page once they are (the save waits for it). `measureText` needs them loaded (`await
ensureFonts(text, style)`), and throws otherwise.

Paragraphs: `canvas.drawLayout(await layoutParagraph(spec), x, y)`.

How the text is stored: Type 0 (CID) fonts, subsets of the glyphs used, each code mapped to the
text it stands for (ToUnicode), so text reads back in its own order even where Hindi reorders or
joins letters (pdf.js extracts "दुनिया", not "दु िनया"); words whose glyphs don't follow their
letters are also wrapped in `/ActualText` marked content for viewers that use it. Letter spacing is
counted in each letter's width, so spaced-out words still read as words. Characters the browser
draws (Arabic, Hebrew, Chinese, emoji…) carry invisible text over their picture; for a right-to-left
run it is written in drawing order (whole characters reversed), as viewers expect of visual-order
PDFs, so pdf.js and others turn it back and "مرحبا" copies and is found as typed.

---

## Pictures

```js
canvas.drawImage(image, ...)
canvas.imageFormat = 'auto' | 'jpeg' | 'png'   // default 'auto': JPEG when opaque, lossless with a soft mask when see-through
canvas.imageQuality = 0.85                     // JPEG quality (the app's JPEG_QUALITY is 85)
embedImage(doc, image, { format, quality }): { ref, width, height }
```
`image` may be an `ImageBitmap`, `HTMLCanvasElement`, `OffscreenCanvas`, loaded
`HTMLImageElement`, `ImageData` (or `{ width, height, data }` RGBA), a pdf-lib `PDFImage`
(`await doc.embedJpg(bytes)` / `embedPng`: best for pictures you already have as JPEG/PNG bytes,
no re-encoding), or what `embedImage` returned. Each picture object is put in the PDF once, however
often it is drawn. Sizes default to the picture's pixels as points. JPEG encoding finishes in the
background; `savePdf` waits for it. The pixels are copied when drawn, so the source may be closed
right after.

---

## Forms (drawn many times)

```js
const form = createFormCanvas(doc, width, height)   // a PdfCanvas drawing into a form XObject (top-left origin)
form.fillText('DRAFT', 0, 80, { size: 100, bold: true });
canvas.drawForm(form, x, y, w?, h?)                  // on any page, as often as needed: stored once
```
A watermark drawn once in a form and put on 500 pages takes the room of one. Links can't be put in
forms (they belong to pages).

---

## Links, destinations and bookmarks

```js
canvas.link(x, y, w, h, target)       // the rectangle (current transform) becomes a link annotation
// target: 'https://…' or { url } (http, https, mailto, tel, ftp only; anything else is ignored),
//         { dest: 'name' } (a named destination), or { page: index, y, x? } (y from the top of that page as shown)
canvas.addDestination(name, x = 0, y = 0)   // names a point of this page (current transform)
addNamedDestination(doc, name, page, left, top)   // the same in page coordinates (PDF, y up)
addOutline(doc, items)                // bookmarks; replaces the PDF's outline
```
A style's `link` makes a laid-out run a link (rectangles from line top to bottom, joined across a
line). A tab between runs of the same link is part of it, as in Word, so a contents line linked as a
whole (title, dot leader, page number) is one link area; a tab at either end of a link isn't.
Outline items (EpubConverter's `OutlineItem`):
```js
addOutline(doc, [
  { title: 'Chapter 1', page: 0, top: 780, children: [        // top: PDF points from the page's bottom, as the app
    { title: 'Section 1.1', page: 0, y: 300 },                // or y: points from the top as shown
  ] },
  { title: 'Chapter 2', dest: 'chapter-2' },                   // or a named destination
]);
```
Titles are cut at 500 characters (the app's MAX_TITLE). Top-level items show; their children are
folded unless the item has `open: true`. A page tree that loops or is damaged (pdf-lib would
overflow its stack or throw a TypeError) makes `addOutline` and a link to `{ page }` throw
`UserError('pdf_import_failed')`. The book's title, author and language are set with
pdf-lib (`doc.setTitle`, `setAuthor`, `setLanguage`).

---

## Saving and copying pages

pdf-lib's `doc.save()` (so `savePdf`) first runs `finishText(doc)`, which waits for pending
pictures and text, writes every canvas's content, the font subsets and named destinations. Each
page's content is compressed as it is written, so it gives the browser its turn (`yieldToUI`)
every 16 ms: a long document doesn't freeze the screen, its progress or Cancel while it is saved.

```js
await finishText(doc)   // canvas.js (and index.js)
```
Call it yourself only before **copying or embedding pages of `doc` into another PDF**
(`otherDoc.copyPages(doc, …)`, `embedPage`), since those copy what is written. Drawing may go on
afterwards (a new content stream; font subsets grow and are written again).

---

## Screen previews (`paint.js`)

```js
paintLayout(ctx2d, layout, x, y)    // = layout.draw(ctx2d, x, y)
paintItems(ctx2d, layout.items(x, y))
```
Draws a laid-out paragraph on a screen canvas with the very glyph outlines the PDF gets (and the
same pictures for other scripts), so the preview matches the PDF exactly: as the app's previews
draw with the same Paint as its PDFs. Scale the context for the device pixel ratio first.

```js
const m = await measureText(text, { size: 100, bold: true, color });   // watermark at 100 points
ctx.save();
ctx.scale(dpr * zoom, dpr * zoom);
m.layout.draw(ctx, x, y);
ctx.restore();
```

---

## Errors

| Key | English text | When |
|---|---|---|
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. | A font file couldn't be fetched (offline before the app was saved for offline use). Thrown by `loadFont`, `ensureFonts`, the async layout functions, and by `savePdf` when text drawn with `fillText` waited for it. |

The engine doesn't throw `watermark_no_font` itself: Add watermark and Edit PDF check
`canDraw(text, style)` and throw `UserError('watermark_no_font')` (strings.xml: "This phone has no
font for some of these characters. Try different text."; the web app may word it for a device).

Programming errors (fonts not loaded for a synchronous call, a non-page given to `PdfCanvas`,
negative radii) throw ordinary `Error`/`TypeError`/`RangeError`.

---

## Recipes

**Word paragraph (DocxConverter)**
```js
const rich = new RichText({ behind: cellShading });
for (const run of runs) rich.append(run.text, { font: run.font, size: run.size, bold: run.bold, color: run.color, autoColor: run.auto });
const para = await layoutParagraph({
  text: rich, base: markStyle, width: columnWidth, align: 'justify',
  firstIndent, indent, rightIndent, spacing: LineSpacing.multiple(1.15),
  lineScale: lineScale(markStyle), directionFromText: false,
  label: { text: '1.', style: labelStyle, x: labelX }, tabs: [{ pos: 425, align: 'right', leader: 'dot' }],
});
```

**Page numbers (stamps)**
```js
const canvas = new PdfCanvas(page);          // shown frame: bottom of the page as the user sees it
const style = { size: 12, color: '#000' };
const m = await measureText(String(n), style);
const x = (canvas.width - m.width) / 2;      // bottom centre
const y = canvas.height - margin;            // baseline
canvas.fillText(String(n), x, y, style);
```

**Watermark (stamps)**: one form for all pages.
```js
if (!canDraw(text, { bold: true })) throw new UserError('watermark_no_font');
const style = { size: 100, bold: true, color: WATERMARK_GRAY };
const m = await measureText(text, style);
const pad = 2;
const w = m.ink.right - m.ink.left + 2 * pad, h = m.ink.bottom - m.ink.top + 2 * pad;
const form = createFormCanvas(doc, w, h);
form.fillText(text, pad - m.ink.left, pad - m.ink.top, style);   // baseline at pad - ink.top
for (const page of doc.getPages()) {
  const c = new PdfCanvas(page);
  c.save();
  c.globalAlpha = 0.3;
  c.translate(c.width / 2, c.height / 2);
  c.rotate(-Math.atan2(c.height, c.width));
  const k = Math.min(c.width, c.height) / w;        // or the app's PageStamps fit
  c.drawForm(form, -w * k / 2, -h * k / 2, w * k, h * k);
  c.restore();
}
```

**Edit PDF text box** (PageText.kt draws at 100 points, then scales)
```js
const layout = await layoutText(item.text, { size: item.size, color: item.color });   // lines at line breaks
const ink = layout.inkBounds();                     // for Hindi reaching above the line
layout.draw(canvas, item.x, item.y);                // same in the preview: layout.draw(ctx2d, ...)
```

**EPUB bookmarks**: `canvas.addDestination('chapter-3', 0, y)` where each chapter starts, then
`addOutline(doc, tocItems.map(...{ dest }))`, or give `page` and `y`.

**Excel cell text at Calibri's width**
```js
const style = { font: 'Calibri', size: 11 };
style.scaleX = widthScale(digitEm('Calibri'), style);     // digitEm: SheetUnits.digitEm
const lineHeight = 11 * (officeLineHeight('Calibri') + 0.14);
```

---

## Differences from the app

- The fonts are the bundled Noto fonts on every device, not the phone's (Roboto, Noto Serif,
  Droid Sans Mono...). Lines are scaled to Office's heights as in the app, so pages break about
  where they do there. Families the bundle lacks are the nearest: cursive is Noto Serif Italic,
  casual and light are Noto Sans, condensed is Noto Sans drawn 90 % wide.
- Characters no bundled font has are drawn by the browser into pictures (with their text kept
  invisible over them, so it is still found and copied); the app draws them as text with the
  phone's fonts. Their look depends on the device's fonts. At text sizes they are 1-bit masks at
  160 pixels per em painted in the text colour (about 0.7 KB per different character), larger
  and emoji with smooth edges; each different character is stored once per PDF. WebKit on Linux
  (GNOME Web) draws colour emoji on a canvas without their colours, so there they come out dark.
- Browsers have no `Paint.hasGlyph`: `canDraw` tells a missing character by drawing it and
  comparing it with the box the browser draws for characters no font has (see Fonts).
- TextScales.kt isn't needed: it puts right a bug of Android 8's PDF writer with narrowed text;
  here a run's width scale goes into the text matrix.
- Copying Hindi from the PDF gives the right text (the app's README says it can come out jumbled
  there).
- Right-to-left text follows the basics of Unicode's bidirectional algorithm (no embeddings or
  isolates); Hebrew and Arabic are drawn by the browser.
- Tab stops can also be centre, right and decimal, with leaders; the app's are left stops only.
- Links in text can be clickable (`link` in a style); the app's converters keep links as plain
  text, so they work the same unless a converter passes `link`.
