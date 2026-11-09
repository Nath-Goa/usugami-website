# PowerPoint to PDF (`site/app/js/engine/office/pptx.js`)

A port of the app's `data/office/PptxConverter.kt`: a `.pptx` presentation becomes a PDF with one
page per slide that isn't hidden, in the presentation's order, the size of its slides (sldSz,
held to 1–200 inches as in the app; 720 × 540 points without one).

Screens don't call it directly: they call the dispatcher, which checks the file, loads this module
on demand and turns every failure into the app's message.

```js
import { convertOffice, verifyOfficeFile, officeErrorKey } from '../../engine/office/index.js';

await verifyOfficeFile('powerpoint', fileItem);          // when the file is picked or shared
const out = await convertOffice('powerpoint', fileItem, { name: 'Garden talk' }, {
  signal,
  onProgress: (done, total, info) => dialog.update(done / total,
    info?.compressing ? t('creating_pdf') : tp('progress_slides', total, done, total)),
});
// out: { name: 'Garden talk.pdf', bytes, type: 'application/pdf', pageCount }
```

---

## `convertPptx(input, options = {}, hooks = {}) → Promise<OutputFile>`

The converter `convertOffice('powerpoint', …)` runs (see `docs/api/office-core.md`, "Writing a
converter"). It doesn't check the file first: use `convertOffice`, or `verifyOfficeFile` before it.

| Parameter | Meaning |
|---|---|
| `input` | `{ name, bytes }` (a FileItem will do): the `.pptx` file |
| `options.name` | The PDF's name as typed, without `.pdf`; blank or missing: the file's own name ("Talk.pptx" → "Talk.pdf"), or "Presentation" |
| `hooks.onProgress(done, total, info)` | Called as each slide starts: `done` of `total` slides (hidden ones aren't counted), then `(n, n, { compressing: true })` while the PDF is saved |
| `hooks.signal` | An `AbortSignal`: reading, drawing and saving stop with `CancelledError` (checked between slides, shapes and paragraphs) |
| `hooks.onLeftOut(error, shapeName)` | Optional: told of each shape left out because it couldn't be drawn (as the app leaves such a shape out rather than failing the presentation). For tests and diagnostics |

Resolves to `{ name, bytes, type: 'application/pdf', pageCount }`.

Throws (all turned into the app's messages by `convertOffice`):

| Thrown | `convertOffice` gives |
|---|---|
| `OfficeNothingToConvert` (problems.js): no slides, or only hidden ones | `office_no_slides` |
| `ZipError`, `XmlError`: a damaged package, a slide, layout, master or theme that isn't well-formed XML, or XML with a DOCTYPE (entities) | `office_convert_failed` |
| `UserError('web_fonts_unavailable')` from the text engine (fonts couldn't be fetched) | passed through |
| `CancelledError` | passed through |

```js
import { convertPptx } from '../../engine/office/pptx.js';
const { bytes, pageCount } = await convertPptx({ name: 'Talk.pptx', bytes }, {}, { signal });
```

### Message keys a PowerPoint screen needs

This engine throws no `UserError` keys of its own; through `convertOffice` and `verifyOfficeFile`
these come (strings.xml texts; `_many` keys for several files are in office-core.md):

| Key | English |
|---|---|
| `office_no_slides` | This presentation has no slides to convert. Hidden slides are left out. |
| `office_not_powerpoint` | This isn't a PowerPoint presentation (.pptx), or it's damaged. |
| `office_legacy_powerpoint` | This is an old PowerPoint file (.ppt). Save it as .pptx in PowerPoint or another app, then try again. |
| `office_encrypted` | This file is protected with a password. Remove the password in Word or PowerPoint, save the file, then try again. |
| `office_convert_failed` | Couldn't convert this file. Check the file and free storage. |
| `web_fonts_unavailable` | Usugami couldn't load its fonts. Check your connection and try again. |

Progress: `progress_slides` ("%1$d of %2$d slide(s)", a plural) and `creating_pdf` ("Creating and
compressing PDF…").

---

## What converts, as in the app

- **Slides**: in `p:sldIdLst` order; hidden ones (`show="0"`) left out; a slide whose part is
  missing is left out too. Slide numbers (`a:fld type="slidenum"`) count every slide, hidden ones
  too, from `firstSlideNum`.
- **Backgrounds**: the slide's, else its layout's, else its master's (`p:bg`: colours, gradients,
  pictures stretched over the slide; `p:bgRef` as its colour), on white.
- **Masters and layouts**: their shapes that aren't placeholders, behind the slide's
  (`showMasterSp="0"` on a slide hides both, on a layout the master's); colour maps
  (`p:clrMap`, a slide's or layout's `p:clrMapOvr` recolouring the whole slide, master too);
  themes (colours, heading and body fonts).
- **Placeholders**: take their position, outline, fill, body look (insets, anchor, autofit…) and
  list styles from the layout's and master's placeholder they match (by index, then type, then
  kind), and their text style from the master's title, body or other style and the presentation's
  default text style. Empty placeholders aren't drawn.
- **Shapes**: preset geometries (drawingml.js's list; others as rectangles), adjustments, freeform
  paths (`a:custGeom`; ones whose points need formulas are left out, their text kept), fills
  (solid, gradients, pictures, a pattern's foreground colour, `a:grpFill`), outlines with dashes
  and arrowheads, the shape style's fill, line and font colours, rotation, flips, groups (scaled,
  flipped, nested), hidden shapes left out.
- **Pictures**: cropped (`a:srcRect`, negative crops leave the frame partly empty), flipped, in
  their geometry, with their outline; decoded no larger than shown (office-pdf.js); pictures that
  can't be decoded (EMF, WMF, TIFF, damaged) as a light grey box.
- **Text**: paragraphs, runs (size, bold, italic, underline, strike, colour, gradient's first
  colour, highlight, superscript/subscript, capitals, letter spacing, Latin font or theme font),
  line breaks, levels 1–9, indents, alignment (right to left too), line spacing (multiple and
  exact), space before and after (the first's before and the last's after only with
  `spcFirstLastPara`), bullets (characters, Wingdings and Symbol ones as the characters they show,
  picture bullets as "•", size, colour, font) and numbering (every `buAutoNum` scheme; numbers go on
  past an empty paragraph; a deeper level starts over), links in the theme's link colour,
  underlined, Insert > Symbol characters (`a:sym`), slide numbers. Text without a colour is white on
  a dark fill. Insets, anchoring (top, middle, bottom), `wrap="none"`, vertical text (`vert`,
  `vert270`, `eaVert`: Chinese, Japanese and Korean upright, wrapped to the box's width; stacked
  letters likewise), flipped-upside-down text, SmartArt text in its own frame (`dsp:txXfrm`).
- **Shrink on overflow** (`a:normAutofit`): starting from PowerPoint's saved `fontScale` and
  `lnSpcReduction`, the text is laid out again at 90 % of the size (and line spacing reduced by up
  to 20 %) until it fits its box or reaches 30 %.
- **Tables**: the presentation's table styles (whole table, banded rows and columns, first and last
  row and column: fills, borders, bold and colour of text), or PowerPoint's default look (Medium
  Style 2, Accent 1) for a style the file doesn't have; cells' own fills, borders and margins; cells
  merged across (`gridSpan`/`hMerge`) and down (`rowSpan`/`vMerge`, text centred over the rows as
  anchored); right-to-left tables; rows growing with their text.
- **Charts**: a light grey box with the chart's title (or the frame's description).
  **SmartArt**: from the drawing PowerPoint saves with it (`dsp:drawing`), else a grey box with its
  description. **Ink, equations, 3-D models, embedded objects**: the picture PowerPoint saves of
  them (`mc:Fallback`, `p:oleObj`'s `p:pic`).
- **Damaged parts of a shape's own** (a chart's part, the table styles' part, a picture) leave out
  only what is in them; a shape that can't be drawn is left out (see `onLeftOut`).

Text stays real text (selectable, searchable) and only the glyphs used are embedded (text engine).
Each page's content is written as its slide is finished, so the save at the end stays short.

---

## Helper modules (PowerPoint only)

Other converters don't need these; they are listed for whoever works on PowerPoint to PDF.

### `pptx-model.js`: reading

| Export | What |
|---|---|
| `Ctx(pkg, part, theme, colorMap)` | Scheme colours of a part (`scheme(name)`, `color(x)`, `fill(x)`, `outline(x)`, `forPart(part)`) |
| `readColorMap(root)` | A part's `p:clrMap` or `p:clrMapOvr` as a Map, or null; `mapKey(map)` compares two |
| `ShapeReader({ chartTitle, smartArt })` | `readShapes(spTree, ctx)` → shapes (`shapeOf`'s fields: `kind` (`Kind.SHAPE`, `PICTURE`, `GROUP`, `TABLE`, `GRAPHIC`), `ph`, `xfrm`, `geometry`, `custom`, `fill`, `line`, `body`…); `chartTitle(ctx, relId)` and `smartArt(ctx, relId)` give what was loaded beforehand (`partReferences(root)` lists the ids) |
| `readBody`, `readParagraph`, `readLevels`, `readLevelLook`, `readRunLook`, `readBodyLook` | Text bodies, paragraphs and looks (null fields inherit: `runOver`, `levelOver`, `bodyOver`) |
| `readTable`, `readTableStyles`, `readTableStylePart`, `readBackground` | Tables, table styles, backgrounds |
| `chartTitleOf(root)`, `smartArtDrawingId(root)`, `hasText(body)`, `gapPoints(gap, size)`, `drawable(shape)` | Small readers |

### `pptx-text.js`: text

- `layoutText(conv, body, chain, width, scale, reduction, slide, styleFont, darkFill)` → Spaced
  ParagraphLayouts (`.align`, `.rtl` added). `conv`: `{ themeFont(name), breathe(), slideWidth }`.
- `drawText(conv, canvas, body, box, chain, inheritedLooks, styleFont, slide, fill)` → the font
  scale used (autofit); `box` is `{ left, top, right, bottom }` in points.
- `textStyle(look, scale, styleFont, darkFill, themeFont)`, `hasUprightText(body)`, `tenths(points)`.

### `pptx-table.js`: tables

- `drawTable(conv, canvas, table, rect, style, chain, slide)`; `defaultTableStyle(ctx)`.

---

## Differences from the app

- Fonts: the bundled Noto fonts stand in for the presentation's, as the phone's do in the app, so
  text can wrap a little differently (and autofit shrink a little more or less). Lines are scaled
  to PowerPoint's 1.2 × size spacing as in the app.
- A damaged table styles part gives no styles (tables take PowerPoint's default look); the app keeps
  the styles read before the damage. A damaged slide, layout, master or theme fails the
  conversion, as in the app.
- Hebrew, Arabic, Chinese, Japanese and Korean text is drawn by the browser into the page as
  pictures with invisible text over it (the text engine's way), not as embedded fonts.
- Pictures follow office-pdf.js (decoded once at 150 pixels per inch, JPEG at quality 75 when that
  is smaller and the picture takes 2 KB or more, else lossless); see office-core.md.
- Links look as in the app (theme colour, underlined) and, as in the app, aren't clickable.
