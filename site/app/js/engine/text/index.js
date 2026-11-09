// The text engine in one import: fonts, paragraph layout and the canvas-like PDF drawing surface
// (see docs/api/text.md). Importing a single module (fonts.js, layout.js, canvas.js) works too.
export {
  officeFamily, officeLineHeight, phoneLineHeight, lineScale, widthScale, digitWidth, familyKind,
  resolveStyle, fontStack, pickFont, ensureFonts, fontsReady, loadFont, loadedFont, missingCharacters,
  needsGlyph, isEmoji, graphemes, fileMetrics, FONT_FILES, FONT_METRICS, ITALIC_SKEW, CONDENSED_SCALE,
} from './fonts.js';
export {
  RichText, OBJECT, LineSpacing, layoutParagraph, layoutParagraphSync, prepareParagraph, layoutText,
  measureText, measureTextSync, fitPictures, linesThatFit, ParagraphLayout,
} from './layout.js';
export {
  PdfCanvas, PdfPath, PdfGradient, createFormCanvas, embedImage, addOutline, addNamedDestination,
  pageFrame, parseCssFont, finishText,
} from './canvas.js';
export { paintLayout, paintItems } from './paint.js';
export { canDraw, browserCanDraw } from './fallback.js';
export { parseColor, isDark } from './color.js';
export { lineBreaks } from './linebreak.js';
