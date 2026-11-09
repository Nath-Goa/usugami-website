// Flatten PDF (engine/flatten.js): form fields, comments, highlights, drawings and stamps become
// part of the page; links stay; fields whose text the form's font can't show stay fields; nothing
// to flatten is said. Checked by reading the results back with pdf-lib and pdf.js, and by
// rendering them with pdf.js (annotations shown) before and after.
//
//   node tests/flatten.test.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPage, assert, saveOutput, root, fixture } from './harness.mjs';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef, PDFBool, PDFNumber,
  StandardFonts,
} from '../site/app/js/lib/pdf-lib.js';
import fontkit from '../site/app/js/lib/fontkit.js';
import { placementMatrix, pageArea } from '../site/app/js/engine/flatten/placement.js';
import { flattenNotes } from '../site/app/js/engine/flatten.js';
import { UserError, CancelledError } from '../site/app/js/core/errors.js';

const A4 = [595.28, 841.89];

// --- Port of the app's AppearancePlacementTest (pure: runs in Node) -------------------------
{
  const close = (a, b, msg) => assert(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4), `${msg}: ${a} vs ${b}`);
  const place = (rect, bbox, form, x, y) => {
    const ix = form[0] * x + form[2] * y + form[4];
    const iy = form[1] * x + form[3] * y + form[5];
    const m = placementMatrix(rect, bbox, form);
    return [m[0] * ix + m[2] * iy + m[4], m[1] * ix + m[3] * iy + m[5]];
  };
  const I = [1, 0, 0, 1, 0, 0];
  close(placementMatrix([100, 200, 300, 230], [0, 0, 200, 30]), [1, 0, 0, 1, 100, 200], 'box the size of the rectangle is moved onto it');
  close([...place([50, 60, 150, 100], [5, 5, 25, 15], I, 5, 5), ...place([50, 60, 150, 100], [5, 5, 25, 15], I, 25, 15)], [50, 60, 150, 100], 'box is stretched to fill the rectangle');
  const quarter = [0, 1, -1, 0, 20, 0];
  const corners = [[0, 0], [100, 0], [0, 20], [100, 20]].map(([x, y]) => place([10, 10, 30, 110], [0, 0, 100, 20], quarter, x, y));
  close([Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))], [10, 30, 10, 110], 'turned appearance still fills the rectangle');
  close(placementMatrix([300, 230, 100, 200], [0, 0, 200, 30]), [1, 0, 0, 1, 100, 200], 'rectangle given upside down is normalised');
  close(placementMatrix([0, 50, 100, 50], [0, 0, 50, 0]), [2, 0, 0, 1, 0, 50], 'flat box is not stretched to infinity');
  close(pageArea([0, 1, -1, 0, 100, 0], 10, 20, 30, 40), [40, 10, 80, 40], 'page area of a turned rectangle');
  console.log('ok placement');
}

// --- What the app says after flattening (ports of BatchToolsDeviceTest's checks; pure) ---------
{
  const same = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)}`);
  const ok = (keptFields = 0, droppedDynamicXfa = false) => ({ keptFields, droppedDynamicXfa });
  // One PDF: its own messages.
  same(flattenNotes([{ name: 'alpha.pdf', error: new UserError('flatten_nothing') }]), [{ key: 'flatten_nothing', args: [] }], 'one with nothing');
  same(flattenNotes([{ name: 'x.pdf', result: ok(2, true) }]), [{ key: 'flatten_xfa_dropped', args: [] }, { key: 'flatten_fields_kept', count: 2, args: [2] }], 'one with XFA dropped and fields kept');
  same(flattenNotes([{ name: 'x.pdf', error: new CancelledError() }]), [], 'cancelled says nothing');
  // Several: the one left out named, then what happened to another.
  same(flattenNotes([{ name: 'form.pdf', result: ok() }, { name: 'alpha.pdf', error: new UserError('flatten_nothing') }, { name: 'amounts.pdf', result: ok(2) }]), [
    { key: 'batch_nothing_to_flatten', count: 1, args: [1, 'alpha.pdf'] },
    { key: 'file_problem', args: ['amounts.pdf', { key: 'flatten_fields_kept', count: 2, args: [2] }] },
  ], 'several, one with nothing to flatten');
  same(flattenNotes([{ name: 'alpha.pdf', error: new UserError('flatten_nothing') }, { name: 'beta.pdf', error: new UserError('flatten_nothing') }]), [
    { key: 'batch_nothing_to_flatten', count: 2, args: [2, 'alpha.pdf, beta.pdf'] },
  ], 'several, none with anything to flatten');
  same(flattenNotes([
    { name: 'amounts.pdf', result: ok(2) }, { name: 'tax form.pdf', error: new UserError('flatten_xfa_only') },
    { name: 'more amounts.pdf', result: ok(2) }, { name: 'visa form.pdf', error: new UserError('flatten_xfa_only') },
    { name: 'permit.pdf', result: ok(0, true) }, { name: 'junk.pdf', error: new UserError('pdf_import_failed') },
  ]), [
    { key: 'file_problem', args: ['tax form.pdf, visa form.pdf', { key: 'flatten_xfa_only_many', args: [] }] },
    { key: 'batch_failed', count: 1, args: [1, 'junk.pdf'] },
    { key: 'file_problem', args: ['amounts.pdf, more amounts.pdf', { key: 'flatten_fields_kept_many', args: [] }] },
    { key: 'file_problem', args: ['permit.pdf', { key: 'flatten_xfa_dropped', args: [] }] },
  ], 'what is said of several comes once for all of them');
  console.log('ok notes');
}

// --- Fixtures --------------------------------------------------------------------------------

const enc = (s) => s;
/** A content stream (form XObject) registered in doc, returned by reference. */
function form(doc, content, bbox, extra = {}) {
  return doc.context.register(doc.context.flateStream(enc(content), { Type: 'XObject', Subtype: 'Form', BBox: bbox, ...extra }));
}
function annot(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}
function helvetica(doc) {
  return doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
}
function newForm(doc, helv, extra = {}) {
  const acro = doc.context.obj({ Fields: [], DR: { Font: { Helv: helv } }, DA: PDFString.of('/Helv 0 Tf 0 g'), ...extra });
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
  return acro;
}
const fieldsOf = (doc, acro) => doc.context.lookup(acro.get(PDFName.of('Fields')));
/** A text field whose widget is the field itself (merged), placed on page. */
function textField(doc, page, acro, name, rect, { value, ap, da = '/Helv 12 Tf 0 g', extra = {}, place = true } = {}) {
  const dict = {
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name), Rect: rect, F: 4, DA: PDFString.of(da),
    ...(place ? { P: page.ref } : {}), ...extra,
  };
  if (value !== undefined) dict.V = PDFHexString.fromText(value);
  if (ap) dict.AP = { N: ap };
  const ref = annot(doc, page, dict);
  fieldsOf(doc, acro).push(ref);
  return ref;
}
async function writeText(doc, page, text, x, y, size = 14) {
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x, y, size, font: f });
}

/**
 * One A4 page saying "FORM PAGE" with (as the app's TestPdfs.formPdf, and more):
 * - text field "name" filled with `name`, with an appearance an app drew
 * - text field "city" holding "Lisbon" but never drawn (no appearance)
 * - multi-line text field "notes", right-aligned text field "amount", comb field "code",
 *   password field "pin", each with a value and no appearance
 * - ticked check box "agree" drawn as a blue square, radio group "size" with "L" chosen
 * - list box "colours" with "Green" chosen, no appearance
 * - a red square comment with no appearance of its own, at (350, 400) to (500, 500)
 * - a sticky note with its popup; a hidden red comment and one only for printing (not drawn)
 * - a highlight, an ink drawing, a stamp and a free-text comment, each with its appearance,
 *   the stamp's turned by its own matrix and half see-through (/CA)
 * - a link to a web page
 * With xfa, the form also has a dynamic XFA form, as some government forms do.
 */
async function formPdf({ name = 'Jane Doe', xfa = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'FORM PAGE', 72, 760);
  const helv = helvetica(doc);
  const acro = newForm(doc, helv);
  const fonts = { Font: { Helv: helv } };
  textField(doc, page, acro, 'name', [72, 600, 322, 624], {
    value: name,
    ap: form(doc, `/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (${name}) Tj ET Q EMC`, [0, 0, 250, 24], { Resources: fonts }),
  });
  textField(doc, page, acro, 'city', [72, 560, 322, 584], { value: 'Lisbon' });
  textField(doc, page, acro, 'notes', [340, 560, 520, 620], {
    value: 'Second floor, ring twice please, and leave it with the neighbours', da: '/Helv 11 Tf 0 0 1 rg', extra: { Ff: 1 << 12 },
  });
  textField(doc, page, acro, 'amount', [340, 520, 520, 544], { value: '1,250.00', extra: { Q: 2, MK: { BC: [0, 0, 0], BG: [0.9, 0.9, 0.9] } } });
  textField(doc, page, acro, 'code', [340, 480, 460, 504], { value: 'AB12', extra: { Ff: 1 << 24, MaxLen: 6 } });
  textField(doc, page, acro, 'pin', [340, 440, 460, 464], { value: '4321', extra: { Ff: 1 << 13 } });

  // A ticked check box, drawn as a blue square.
  const on = form(doc, '0 0 1 rg 1 1 12 12 re f', [0, 0, 14, 14], { Resources: {} });
  const off = form(doc, '', [0, 0, 14, 14]);
  const box = annot(doc, page, {
    Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('agree'), Rect: [72, 520, 86, 534], F: 4, P: page.ref,
    V: 'Yes', AS: 'Yes', AP: { N: { Yes: on, Off: off } },
  });
  fieldsOf(doc, acro).push(box);

  // A radio group: two buttons, the second chosen; each draws a green dot when on.
  const radio = doc.context.register(doc.context.obj({ FT: 'Btn', Ff: 1 << 15, T: PDFString.of('size'), V: 'L', Kids: [] }));
  for (const [i, state] of ['M', 'L'].entries()) {
    const dot = form(doc, '0 0.6 0 rg 14 7 m 14 10.9 10.9 14 7 14 c 3.1 14 0 10.9 0 7 c 0 3.1 3.1 0 7 0 c 10.9 0 14 3.1 14 7 c f', [0, 0, 14, 14]);
    const kid = annot(doc, page, {
      Type: 'Annot', Subtype: 'Widget', Parent: radio, Rect: [72 + i * 30, 480, 86 + i * 30, 494], F: 4, P: page.ref,
      AS: state === 'L' ? 'L' : 'Off', AP: { N: { [state]: dot, Off: form(doc, '', [0, 0, 14, 14]) } },
    });
    doc.context.lookup(radio).get(PDFName.of('Kids')).push(kid);
  }
  fieldsOf(doc, acro).push(radio);

  // A list box with no look: "Green" chosen.
  const list = annot(doc, page, {
    Type: 'Annot', Subtype: 'Widget', FT: 'Ch', T: PDFString.of('colours'), Rect: [72, 380, 222, 440], F: 4, P: page.ref,
    DA: PDFString.of('/Helv 10 Tf 0 g'), Opt: [PDFString.of('Red'), PDFString.of('Green'), PDFString.of('Blue')], V: PDFString.of('Green'),
  });
  fieldsOf(doc, acro).push(list);

  // Comments.
  annot(doc, page, { Type: 'Annot', Subtype: 'Square', Rect: [350, 300, 500, 400], C: [1, 0, 0], IC: [1, 0, 0], F: 4 });
  const note = annot(doc, page, { Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], Contents: PDFString.of('Check the date'), F: 4 });
  const popup = annot(doc, page, { Type: 'Annot', Subtype: 'Popup', Rect: [300, 650, 500, 750], Parent: note });
  doc.context.lookup(note).set(PDFName.of('Popup'), popup);
  annot(doc, page, { Type: 'Annot', Subtype: 'Square', Rect: [72, 200, 140, 260], F: 2, AP: { N: form(doc, '1 0 0 rg 0 0 68 60 re f', [0, 0, 68, 60]) } });
  annot(doc, page, { Type: 'Annot', Subtype: 'Square', Rect: [150, 200, 218, 260], F: 32 | 4, AP: { N: form(doc, '1 0 0 rg 0 0 68 60 re f', [0, 0, 68, 60]) } });
  // A highlight over "FORM PAGE", as viewers make it: multiplied with the page.
  const multiply = { ExtGState: { M: { BM: 'Multiply' } } };
  annot(doc, page, {
    Type: 'Annot', Subtype: 'Highlight', Rect: [70, 755, 160, 778], C: [1, 1, 0], F: 4,
    QuadPoints: [70, 778, 160, 778, 70, 755, 160, 755],
    AP: { N: form(doc, '/M gs 1 1 0 rg 70 755 90 23 re f', [70, 755, 160, 778], { Resources: multiply }) },
  });
  // An ink drawing whose appearance box is in page coordinates (as many apps write it).
  annot(doc, page, {
    Type: 'Annot', Subtype: 'Ink', Rect: [240, 640, 340, 700], C: [0, 0, 1], F: 4, InkList: [[245, 645, 290, 695, 335, 645]],
    AP: { N: form(doc, '0 0 1 RG 3 w 1 J 1 j 245 645 m 290 695 l 335 645 l S', [240, 640, 340, 700]) },
  });
  // A stamp whose appearance is drawn sideways and turned upright by its own matrix, half see-through.
  annot(doc, page, {
    Type: 'Annot', Subtype: 'Stamp', Name: 'Approved', Rect: [380, 160, 440, 280], F: 4, CA: 0.5,
    AP: { N: form(doc, '0 0.5 0 rg 0 0 120 60 re f 1 1 1 rg 10 10 100 40 re f', [0, 0, 120, 60], { Matrix: [0, 1, -1, 0, 0, 0] }) },
  });
  annot(doc, page, {
    Type: 'Annot', Subtype: 'FreeText', Rect: [72, 100, 272, 130], F: 4, DA: PDFString.of('/Helv 12 Tf 0 g'), Contents: PDFString.of('Signed in blue ink'),
    AP: { N: form(doc, 'BT /Helv 12 Tf 0 g 4 10 Td (Signed in blue ink) Tj ET 0 G 0.5 0.5 199 29 re S', [0, 0, 200, 30], { Resources: fonts }) },
  });
  annot(doc, page, { Type: 'Annot', Subtype: 'Link', Rect: [72, 50, 272, 70], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.org/form') } });

  if (xfa) {
    const packet = doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'));
    acro.set(PDFName.of('XFA'), packet);
    doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
  }
  return doc.save({ updateFieldAppearances: false });
}

/**
 * As the app's TestPdfs.unencodableFormPdf: a form in Helvetica, which has no rupee sign and no
 * Devanagari, that asks viewers to draw its fields (NeedAppearances):
 * - "amount" holding "₹ 5,000", with a white background (/MK) and its look from before the value
 *   was set, saying "OLD AMOUNT"
 * - "name" holding "नाम", with no look at all
 * - with unplaced, "city" holding "Lisbon", whose widget doesn't say which page it is on
 */
async function unencodableFormPdf({ unplaced = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const helv = helvetica(doc);
  const acro = newForm(doc, helv, { NeedAppearances: true });
  textField(doc, page, acro, 'amount', [72, 600, 322, 624], {
    value: '₹ 5,000',
    extra: { MK: { BG: [1, 1, 1] } },
    ap: form(doc, 'BT /Helv 12 Tf 2 7 Td (OLD AMOUNT) Tj ET', [0, 0, 250, 24], { Resources: { Font: { Helv: helv } } }),
  });
  textField(doc, page, acro, 'name', [72, 560, 322, 584], { value: 'नाम' });
  if (unplaced) textField(doc, page, acro, 'city', [72, 520, 322, 544], { value: 'Lisbon', place: false });
  return doc.save({ updateFieldAppearances: false });
}

/** A drop-down list whose choices pair a code with a country's name, "code-pt" chosen (app's test). */
async function countryPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const helv = helvetica(doc);
  const acro = newForm(doc, helv, { NeedAppearances: true });
  // A name kept elsewhere in the file, and a choice with no name, before the one chosen.
  const austria = doc.context.register(PDFString.of('Austria'));
  const ref = annot(doc, page, {
    Type: 'Annot', Subtype: 'Widget', FT: 'Ch', Ff: 1 << 17, T: PDFString.of('country'), Rect: [72, 600, 200, 624], F: 4, P: page.ref,
    DA: PDFString.of('/Helv 12 Tf 0 g'), V: PDFString.of('code-pt'),
    Opt: [[PDFString.of('code-at'), austria], [PDFString.of('code-be')], [PDFString.of('code-pt'), PDFString.of('Portugal')], [PDFString.of('code-es'), PDFString.of('Spain')]],
  });
  fieldsOf(doc, acro).push(ref);
  return doc.save({ updateFieldAppearances: false });
}

/**
 * Three pages turned 90, 180 and 270 degrees, each with a comment that has a look, a comment that
 * has none, and a text field turned with its page (/MK /R) with no look.
 */
async function rotatedPdf() {
  const doc = await PDFDocument.create();
  const helv = helvetica(doc);
  const acro = newForm(doc, helv);
  for (const [i, rotation] of [90, 180, 270].entries()) {
    const page = doc.addPage(A4);
    page.node.set(PDFName.of('Rotate'), PDFNumber.of(rotation));
    await writeText(doc, page, `TURNED ${rotation}`, 100, 700);
    annot(doc, page, {
      Type: 'Annot', Subtype: 'Square', Rect: [100, 500, 220, 560], F: 4, C: [0, 0, 1],
      AP: { N: form(doc, '0 0 1 RG 4 w 2 2 116 56 re S 1 0.5 0 rg 20 20 30 20 re f', [0, 0, 120, 60]) },
    });
    annot(doc, page, { Type: 'Annot', Subtype: 'Circle', Rect: [300, 300, 400, 380], F: 4, C: [0, 0.5, 0], IC: [0, 0.8, 0] });
    textField(doc, page, acro, `turned${rotation}`, rotation % 180 ? [100, 200, 124, 400] : [100, 200, 300, 224], {
      value: `Upright ${rotation}`, extra: { MK: { R: rotation } },
    });
  }
  return doc.save({ updateFieldAppearances: false });
}

/** A form whose font is a full Devanagari font (Type0), with Hindi filled in and no look. */
async function devanagariPdf() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage(A4);
  const bytes = await readFile(join(root, 'site/app/fonts/NotoSansDevanagari-Regular.ttf'));
  const noto = await doc.embedFont(bytes, { subset: false });
  noto.encodeText('नमस्ते राम');
  const helv = helvetica(doc);
  const acro = newForm(doc, helv);
  acro.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict).set(PDFName.of('Noto'), noto.ref);
  textField(doc, page, acro, 'greeting', [72, 600, 322, 630], { value: 'नमस्ते राम', da: '/Noto 14 Tf 0 g' });
  return doc.save({ updateFieldAppearances: false });
}

async function plainPdf({ link = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'ALPHA', 72, 760);
  if (link) annot(doc, page, { Type: 'Annot', Subtype: 'Link', Rect: [72, 50, 272, 70], A: { S: 'URI', URI: PDFString.of('https://example.org') } });
  return doc.save();
}

async function xfaOnlyPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'Please wait while the form loads', 72, 760);
  const acro = newForm(doc, helvetica(doc));
  acro.set(PDFName.of('XFA'), doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>')));
  doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
  return doc.save();
}


/**
 * Comments with no look of their own, of each kind viewers draw anyway: text markup over words,
 * an ink drawing, a line with endings, a polygon and a polyline, an ellipse, a text box, a stamp,
 * a caret and sticky notes with several icons.
 */
async function noLookPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  await writeText(doc, page, 'The quick brown fox jumps over the lazy dog', 72, 760);
  await writeText(doc, page, 'Underlined words here and struck out words there', 72, 720);
  await writeText(doc, page, 'Squiggly words appear on this line', 72, 680);
  const add = (d) => annot(doc, page, { Type: 'Annot', F: 4, ...d });
  add({ Subtype: 'Highlight', Rect: [70, 755, 250, 775], C: [1, 1, 0], QuadPoints: [70, 775, 250, 775, 70, 755, 250, 755] });
  add({ Subtype: 'Underline', Rect: [70, 715, 200, 735], C: [0, 0, 1], QuadPoints: [70, 735, 200, 735, 70, 715, 200, 715] });
  add({ Subtype: 'StrikeOut', Rect: [300, 715, 420, 735], C: [1, 0, 0], QuadPoints: [300, 735, 420, 735, 300, 715, 420, 715] });
  add({ Subtype: 'Squiggly', Rect: [70, 675, 200, 695], C: [0, 0.6, 0], QuadPoints: [70, 695, 200, 695, 70, 675, 200, 675] });
  add({ Subtype: 'Ink', Rect: [70, 540, 250, 640], C: [0.5, 0, 0.5], BS: { W: 3 }, InkList: [[80, 550, 120, 630, 160, 560, 200, 620, 240, 550]] });
  add({ Subtype: 'Line', Rect: [300, 540, 520, 640], C: [0, 0, 0], BS: { W: 2 }, L: [310, 560, 510, 620], LE: ['Circle', 'OpenArrow'] });
  add({ Subtype: 'Polygon', Rect: [70, 400, 250, 520], C: [0, 0, 1], IC: [0.7, 0.85, 1], BS: { W: 2 }, Vertices: [80, 410, 160, 510, 240, 410] });
  add({ Subtype: 'PolyLine', Rect: [300, 400, 520, 520], C: [1, 0.5, 0], BS: { W: 2 }, Vertices: [310, 410, 380, 510, 450, 410, 510, 510], LE: ['None', 'ClosedArrow'] });
  add({ Subtype: 'Circle', Rect: [70, 280, 250, 380], C: [0, 0.5, 0], BS: { W: 3 } });
  add({ Subtype: 'FreeText', Rect: [300, 280, 520, 380], DA: PDFString.of('/Helv 14 Tf 0 0 1 rg'), Contents: PDFString.of('A text box comment that wraps onto a second line') });
  add({ Subtype: 'Stamp', Name: 'NotApproved', Rect: [70, 150, 250, 210] });
  add({ Subtype: 'Caret', Rect: [300, 150, 320, 170], C: [0, 0, 1] });
  for (const [i, name] of ['Note', 'Comment', 'Key', 'Help', 'Insert', 'Check', 'Cross', 'Circle', 'Star', 'RightArrow', 'UpArrow', 'CrossHairs', 'Paragraph'].entries()) {
    add({ Subtype: 'Text', Name: name, Rect: [60 + i * 36, 60, 78 + i * 36, 80], C: [1, 0.9, 0.3] });
  }
  return doc.save();
}

/**
 * Two pages sharing one resource dictionary (as many PDFs do), each with a comment that has a
 * look, and a third with a comment on a layer that is switched off.
 */
async function sharedAndLayerPdf() {
  const doc = await PDFDocument.create();
  const shared = doc.context.register(doc.context.obj({}));
  for (const [i, color] of ['1 0 0', '0 0 1'].entries()) {
    const page = doc.addPage(A4);
    page.node.set(PDFName.of('Resources'), shared);
    annot(doc, page, {
      Type: 'Annot', Subtype: 'Square', Rect: [100 + i * 200, 400, 200 + i * 200, 500], F: 4,
      AP: { N: form(doc, `${color} rg 0 0 100 100 re f`, [0, 0, 100, 100]) },
    });
  }
  const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Reviewer notes') }));
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
  const page = doc.addPage(A4);
  annot(doc, page, {
    Type: 'Annot', Subtype: 'Square', Rect: [100, 400, 200, 500], F: 4, OC: ocg,
    AP: { N: form(doc, '1 0 0 rg 0 0 100 100 re f', [0, 0, 100, 100]) },
  });
  annot(doc, page, {
    Type: 'Annot', Subtype: 'Square', Rect: [300, 400, 400, 500], F: 4,
    AP: { N: form(doc, '0 0.6 0 rg 0 0 100 100 re f', [0, 0, 100, 100]) },
  });
  return doc.save();
}

/** Check boxes and radio buttons with a value and no look; and Edit PDF's bakeUnder page. */
async function buttonsPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const acro = newForm(doc, helvetica(doc));
  const radio = doc.context.register(doc.context.obj({ FT: 'Btn', Ff: 1 << 15, T: PDFString.of('r'), V: '1', Kids: [], Opt: [PDFString.of('A'), PDFString.of('B')] }));
  for (let i = 0; i < 2; i++) {
    const kid = annot(doc, page, { Type: 'Annot', Subtype: 'Widget', Parent: radio, Rect: [20 + 40 * i, 150, 40 + 40 * i, 170], F: 4, MK: { CA: PDFString.of('l'), BC: [0, 0, 0] } });
    doc.context.lookup(radio).get(PDFName.of('Kids')).push(kid);
  }
  fieldsOf(doc, acro).push(radio);
  for (const [i, ca] of ['4', '8', 'u', 'n', 'H'].entries()) {
    fieldsOf(doc, acro).push(annot(doc, page, {
      Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('c' + i), V: 'Yes', Rect: [20 + 40 * i, 100, 40 + 40 * i, 120], F: 4,
      DA: PDFString.of('0 0 0.7 rg /ZaDb 0 Tf'), MK: { BC: [0, 0, 0], BG: [0.95, 0.95, 0.95], CA: PDFString.of(ca) },
    }));
  }
  fieldsOf(doc, acro).push(annot(doc, page, { Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('off'), V: 'Off', Rect: [20, 50, 40, 70], F: 4, MK: { BC: [0, 0, 0] } }));
  return doc.save({ updateFieldAppearances: false });
}

// --- Reading results back ------------------------------------------------------------------

async function structure(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro ? acro.lookupMaybe(PDFName.of('Fields'), PDFArray) : undefined;
  const fieldInfo = [];
  if (fields) for (let i = 0; i < fields.size(); i++) {
    const f = ctx.lookup(fields.get(i));
    const t = f.get(PDFName.of('T'));
    const v = f.get(PDFName.of('V'));
    fieldInfo.push({ name: t?.decodeText(), value: v?.decodeText?.() });
  }
  const pages = doc.getPages().map((page) => {
    const annots = page.node.Annots();
    const list = [];
    if (annots) for (let i = 0; i < annots.size(); i++) {
      const a = ctx.lookup(annots.get(i));
      const action = a.lookupMaybe(PDFName.of('A'), PDFDict);
      list.push({
        subtype: a.get(PDFName.of('Subtype'))?.decodeText(),
        uri: action?.get(PDFName.of('URI'))?.decodeText(),
        hasAp: a.has(PDFName.of('AP')),
        name: a.get(PDFName.of('T'))?.decodeText(),
      });
    }
    return list;
  });
  return {
    hasForm: !!acro,
    needAppearances: acro?.get(PDFName.of('NeedAppearances')) === PDFBool.True,
    hasXfa: !!acro?.get(PDFName.of('XFA')),
    needsRendering: doc.catalog.has(PDFName.of('NeedsRendering')),
    fields: fieldInfo,
    pages,
    encrypted: !!ctx.trailerInfo.Encrypt,
  };
}

// In the page: rendering with pdf.js, comparing renders, reading text.
const pageHelpers = `
window.__flat = {
  async lib() {
    return import(new URL('app/js/lib/pdfjs.js', document.baseURI.replace(/app\\/fonts\\/.*$/, '')).href);
  },
  async render(bytes, scale = 1) {
    const { openPdfJs, pdfjsLib } = await this.lib();
    const pdf = await openPdfJs(bytes);
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const viewport = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await p.render({ canvas, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      const tc = await p.getTextContent();
      out.push({ canvas, viewport, text: tc.items.map((t) => t.str).join(' '), items: tc.items.map((t) => ({ str: t.str, transform: t.transform })) });
    }
    await pdf.loadingTask.destroy();
    return out;
  },
  /** Each channel averaged over 3 by 3 pixels: text drawn with coloured (LCD) or grey edges looks alike. */
  blurred(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = (yy * w + xx) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      const o = (y * w + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
    return out;
  },
  /** Pixels that differ between two canvases, outside rectangles (PDF coordinates) to skip. */
  diff(a, b, viewport, skip = []) {
    const w = a.width, h = a.height;
    const da = this.blurred(a);
    const db = this.blurred(b);
    const masks = skip.map((r) => {
      const [x1, y1, x2, y2] = this.toCanvas(viewport, r);
      return [x1 - 4, y1 - 4, x2 + 4, y2 + 4];
    });
    let differ = 0, total = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (masks.some((m) => x >= m[0] && x <= m[2] && y >= m[1] && y <= m[3])) continue;
      total++;
      const i = (y * w + x) * 3;
      if (Math.abs(da[i] - db[i]) > 60 || Math.abs(da[i + 1] - db[i + 1]) > 60 || Math.abs(da[i + 2] - db[i + 2]) > 60) differ++;
    }
    return { differ, total };
  },
  /** How many pixels in a rectangle (PDF coordinates) match a colour test. */
  count(canvas, viewport, r, test) {
    const [x1, y1, x2, y2] = this.toCanvas(viewport, r);
    const x0 = Math.max(0, Math.floor(x1)), y0 = Math.max(0, Math.floor(y1));
    const w = Math.min(canvas.width, Math.ceil(x2)) - x0, hh = Math.min(canvas.height, Math.ceil(y2)) - y0;
    const d = canvas.getContext('2d').getImageData(x0, y0, w, hh).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++;
    return n;
  },
  /** A rectangle in PDF coordinates on the canvas: [x1, y1, x2, y2]. */
  toCanvas(viewport, r) {
    const [a, b, c, d, e, f] = viewport.transform;
    const pts = [[r[0], r[1]], [r[2], r[3]], [r[0], r[3]], [r[2], r[1]]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  },
  png(canvas) { return canvas.toDataURL('image/png').split(',')[1]; },
};`;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Runs flattenPdf in the page; returns the result or { error: name, key, wrong }. */
async function flatten(page, base, input, extra = {}) {
  return page.evaluate(async ({ base, input, extra }) => {
    const { flattenPdf } = await import(new URL('app/js/engine/flatten.js', base).href);
    const bytes = Uint8Array.from(atob(input.bytes), (c) => c.charCodeAt(0));
    const controller = new AbortController();
    const progress = [];
    if (extra.abortNow) controller.abort();
    try {
      const out = await flattenPdf({ ...input, bytes }, {
        signal: controller.signal,
        onProgress: (done, total) => {
          progress.push([done, total]);
          if (extra.abortAt !== undefined && done >= extra.abortAt) controller.abort();
        },
      });
      let s = '';
      for (let i = 0; i < out.bytes.length; i += 0x8000) s += String.fromCharCode(...out.bytes.subarray(i, i + 0x8000));
      return { ...out, bytes: btoa(s), progress };
    } catch (e) {
      return { error: e.name, key: e.key, wrong: e.wrong, message: e.message, progress };
    }
  }, { base, input: { ...input, bytes: b64(input.bytes) }, extra }).then((r) => (r.bytes ? { ...r, bytes: new Uint8Array(Buffer.from(r.bytes, 'base64')) } : r));
}

/** Renders before and after, compares them (outside `skip`), and runs `check` on the after render. */
async function compare(page, before, after, { skip = [], tolerance = 0.0002, check = '() => ({})', name } = {}) {
  const r = await page.evaluate(async ({ before, after, skip, check }) => {
    const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const f = window.__flat;
    const a = await f.render(dec(before), 1.5);
    const b = await f.render(dec(after), 1.5);
    const fn = eval(check);
    return a.map((pa, i) => ({
      ...f.diff(pa.canvas, b[i].canvas, pa.viewport, skip[i] ?? []),
      textBefore: pa.text,
      textAfter: b[i].text,
      items: b[i].items,
      pngBefore: f.png(pa.canvas),
      pngAfter: f.png(b[i].canvas),
      checks: fn(b[i], pa, i),
    }));
  }, { before: b64(before), after: b64(after), skip, check });
  for (const [i, p] of r.entries()) {
    await saveOutput(`flatten-${name}-${i + 1}-before.png`, Buffer.from(p.pngBefore, 'base64'));
    await saveOutput(`flatten-${name}-${i + 1}-after.png`, Buffer.from(p.pngAfter, 'base64'));
    console.log(`  ${name} page ${i + 1}: ${p.differ} of ${p.total} pixels differ`);
    assert(p.differ / p.total <= tolerance, `${name} page ${i + 1} looks as before: ${p.differ} of ${p.total} pixels differ`);
  }
  return r;
}

const RED = '(r, g, b) => r > 200 && g < 80 && b < 80';
const BLUE = '(r, g, b) => b > 200 && r < 80 && g < 80';

await withPage(async (page, url) => {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(pageHelpers);

  // --- Fields and comments baked into the page ---------------------------------------------
  {
    const source = await formPdf();
    await saveOutput('flatten-form.pdf', source);
    const out = await flatten(page, url, { name: 'form.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    await saveOutput('flatten-form_flattened.pdf', out.bytes);
    assert(out.name === 'form_flattened.pdf', `named after the original: ${out.name}`);
    assert(out.type === 'application/pdf' && out.pageCount === 1, 'a one-page PDF');
    assert(out.keptFields === 0 && out.droppedDynamicXfa === false, 'nothing kept, no XFA');
    assert(out.progress.length > 0 && out.progress.at(-1)[0] === out.progress.at(-1)[1], `progress ends at its total: ${JSON.stringify(out.progress.at(-1))}`);
    const s = await structure(out.bytes);
    assert(!s.hasForm || s.fields.length === 0, 'no form fields left');
    assert(s.pages[0].length === 1 && s.pages[0][0].subtype === 'Link', `only the link stays: ${JSON.stringify(s.pages[0])}`);
    assert(s.pages[0][0].uri === 'https://example.org/form', 'the link still goes where it went');

    // Rendered: as before, but for what had no look (city, notes, amount, code, pin, the list,
    // the red square, the note), which is drawn now, and the stamp, whose opacity (/CA) the app
    // applies, as Acrobat does, where pdf.js leaves it opaque.
    const generated = [[380, 160, 440, 280], [72, 560, 322, 584], [340, 560, 520, 620], [340, 520, 520, 544], [340, 480, 460, 504], [340, 440, 460, 464], [72, 380, 222, 440], [350, 300, 500, 400], [490, 690, 530, 730]];
    const [r] = await compare(page, source, out.bytes, {
      name: 'form',
      skip: [generated],
      check: `(after) => {
        const f = window.__flat, v = after.viewport, c = after.canvas;
        return {
          red: f.count(c, v, [355, 305, 495, 395], ${RED}),
          blue: f.count(c, v, [73, 521, 85, 533], ${BLUE}),
          hidden: f.count(c, v, [72, 200, 218, 260], ${RED}),
          noteInk: f.count(c, v, [500, 700, 518, 720], (r, g, b) => r < 100 && g < 100 && b < 100),
          listHighlight: f.count(c, v, [74, 380, 220, 438], (r, g, b) => Math.abs(r - 153) < 20 && Math.abs(g - 193) < 20 && Math.abs(b - 215) < 20),
          notesBlue: f.count(c, v, [340, 560, 520, 620], (r, g, b) => b > 150 && r < 100 && g < 100),
          stampHalf: f.count(c, v, [382, 162, 438, 278], (r, g, b) => r > 100 && r < 160 && g > 170 && g < 215 && b > 100 && b < 160),
          stampFull: f.count(c, v, [382, 162, 438, 278], (r, g, b) => r < 30 && g > 110 && g < 145 && b < 30),
          radio: f.count(c, v, [102, 480, 116, 494], (r, g, b) => g > 120 && r < 60 && b < 60),
          radioOff: f.count(c, v, [72, 480, 86, 494], (r, g, b) => g > 120 && r < 60 && b < 60),
        };
      }`,
    });
    const text = r.textAfter;
    assert(!r.textBefore.includes('Jane Doe'), 'field values are not part of the page before');
    for (const word of ['FORM PAGE', 'Jane Doe', 'Lisbon', '1,250.00', 'Signed in blue ink', 'Green', 'Red', 'Blue']) {
      assert(text.includes(word), `"${word}" is part of the page: ${text}`);
    }
    assert(/Second floor/.test(text) && /please/.test(text), `the multi-line field is drawn: ${text}`);
    assert(text.includes('****') && !text.includes('4321'), `a password is drawn masked: ${text}`);
    assert(['A', 'B', '1', '2'].every((ch) => r.items.some((it) => it.str === ch)), 'a comb field is drawn a character per cell');
    const c = r.checks;
    assert(c.red > 5000, `the red square is drawn: ${c.red}`);
    assert(c.blue > 50, `the ticked box is drawn: ${c.blue}`);
    assert(c.hidden === 0, `hidden and print-only comments are not drawn: ${c.hidden}`);
    assert(c.noteInk > 10, `the sticky note's icon is drawn: ${c.noteInk}`);
    assert(c.listHighlight > 200, `the list box's choice is highlighted: ${c.listHighlight}`);
    assert(c.notesBlue > 20, `the multi-line field keeps its blue: ${c.notesBlue}`);
    assert(c.stampHalf > 1000 && c.stampFull === 0, `the stamp is drawn half see-through: ${c.stampHalf}, ${c.stampFull}`);
    assert(c.radio > 50 && c.radioOff === 0, `the chosen radio button shows: ${c.radio}, ${c.radioOff}`);
    // Right-aligned: "1,250.00" ends near the field's right edge.
    const amount = r.items.find((it) => it.str.includes('1,250.00'));
    assert(amount && amount.transform[4] > 440, `the amount is right-aligned: ${amount?.transform}`);
    // Multi-line: on more than one line.
    const noteLines = new Set(r.items.filter((it) => /Second|neighbours/.test(it.str)).map((it) => Math.round(it.transform[5])));
    assert(noteLines.size >= 2, `the multi-line field wraps: ${[...noteLines]}`);
    console.log('ok fields and comments baked');
  }

  // --- Pages turned 90, 180 and 270 degrees ------------------------------------------------
  {
    const source = await rotatedPdf();
    const out = await flatten(page, url, { name: 'turned.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    await saveOutput('flatten-turned_flattened.pdf', out.bytes);
    const generated = (rotation) => [[300, 300, 400, 380], rotation % 180 ? [100, 200, 124, 400] : [100, 200, 300, 224]];
    const r = await compare(page, source, out.bytes, {
      name: 'turned',
      skip: [generated(90), generated(180), generated(270)],
      check: `(after, before, i) => {
        const f = window.__flat, v = after.viewport, c = after.canvas;
        return { green: f.count(c, v, [310, 310, 390, 370], (r, g, b) => g > 150 && r < 80 && b < 80) };
      }`,
    });
    for (const [i, rotation] of [90, 180, 270].entries()) {
      const p = r[i];
      assert(p.checks.green > 2000, `page ${i + 1}: the circle is drawn: ${p.checks.green}`);
      const item = p.items.find((it) => it.str.includes(`Upright ${rotation}`));
      assert(item, `page ${i + 1}: the field's text is part of the page: ${p.textAfter}`);
      // pdf.js gives text in the page's own coordinates: text that reads upright on a page turned
      // r degrees runs at r degrees there.
      const angle = Math.round(Math.atan2(item.transform[1], item.transform[0]) * 180 / Math.PI);
      assert((angle + 360) % 360 === rotation, `page ${i + 1}: the field's text is turned with its page: ${angle}`);
    }
    console.log('ok turned pages');
  }

  // --- Fields whose text the form's font can't show stay fields ----------------------------
  {
    const source = await unencodableFormPdf();
    const out = await flatten(page, url, { name: 'unencodable.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    assert(out.keptFields === 2, `both stay fields: ${out.keptFields}`);
    const s = await structure(out.bytes);
    assert(s.needAppearances, 'the form still asks viewers to draw its fields');
    const values = Object.fromEntries(s.fields.map((f) => [f.name, f.value]));
    assert(values.amount === '₹ 5,000' && values.name === 'नाम', `the values are kept: ${JSON.stringify(values)}`);
    assert(s.pages[0].length === 2, `their widgets stay on the page: ${JSON.stringify(s.pages[0])}`);
    const [text] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(out.bytes));
    assert(!text.includes('OLD AMOUNT'), 'the out-of-date look is not part of the page');

    // Fields kept stay fields, widgets and all, though a field flattened has a widget that
    // doesn't say which page it is on.
    const unplaced = await unencodableFormPdf({ unplaced: true });
    const out2 = await flatten(page, url, { name: 'unplaced.pdf', bytes: unplaced });
    assert(out2.keptFields === 2, `two kept: ${out2.keptFields}`);
    const s2 = await structure(out2.bytes);
    assert(JSON.stringify(s2.fields.map((f) => f.name).sort()) === '["amount","name"]', `kept fields: ${JSON.stringify(s2.fields)}`);
    assert(s2.pages[0].filter((a) => a.subtype === 'Widget').length === 2, 'the kept fields\' widgets stay on the page');
    assert(s2.pages[0].find((a) => a.name === 'amount')?.hasAp, 'the amount keeps its look');
    const [text2] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(out2.bytes));
    assert(text2.includes('Lisbon'), `the field that can be drawn is part of the page: ${text2}`);
    console.log('ok fields kept');
  }

  // --- A form font that has the script is used to draw it ----------------------------------
  {
    const source = await devanagariPdf();
    const out = await flatten(page, url, { name: 'hindi.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    assert(out.keptFields === 0, `drawn in the form's own font: ${out.keptFields}`);
    const s = await structure(out.bytes);
    assert(!s.hasForm || !s.fields.length, 'no field left');
    const r = await compare(page, source, out.bytes, {
      name: 'hindi', skip: [[[72, 600, 322, 630]]],
      check: `(after) => ({ ink: window.__flat.count(after.canvas, after.viewport, [72, 600, 322, 630], (r, g, b) => r < 90 && g < 90 && b < 90) })`,
    });
    assert(r[0].checks.ink > 100, `the Hindi text is drawn: ${r[0].checks.ink}`);
    assert(r[0].textAfter.includes('नम') || r[0].textAfter.includes('राम'), `the Hindi text is text: ${r[0].textAfter}`);
    console.log('ok form font with the script');
  }

  // --- A drop-down list shows the name of its choice -----------------------------------------
  {
    const out = await flatten(page, url, { name: 'country.pdf', bytes: await countryPdf() });
    assert(!out.error, `flattened: ${out.message}`);
    const [text] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(out.bytes));
    assert(text.includes('Portugal') && !text.includes('code-pt') && !text.includes('Spain'), `the choice's name is part of the page: ${text}`);
    console.log('ok drop-down name');
  }

  // --- Nothing to flatten ------------------------------------------------------------------
  {
    const plain = await flatten(page, url, { name: 'alpha.pdf', bytes: await plainPdf() });
    assert(plain.error === 'UserError' && plain.key === 'flatten_nothing', `nothing to flatten: ${JSON.stringify(plain)}`);
    const linked = await flatten(page, url, { name: 'alpha.pdf', bytes: await plainPdf({ link: true }) });
    assert(linked.key === 'flatten_nothing', `a link alone is nothing to flatten: ${JSON.stringify(linked)}`);
    const xfaOnly = await flatten(page, url, { name: 'xfa.pdf', bytes: await xfaOnlyPdf() });
    assert(xfaOnly.key === 'flatten_xfa_only', `a dynamic XFA form alone can't be flattened: ${JSON.stringify(xfaOnly)}`);
    console.log('ok nothing to flatten');
  }

  // --- A dynamic XFA form is dropped and the rest flattened ---------------------------------
  {
    const out = await flatten(page, url, { name: 'xfa_form.pdf', bytes: await formPdf({ name: 'Ana Lima', xfa: true }) });
    assert(!out.error && out.droppedDynamicXfa === true, `XFA dropped: ${JSON.stringify(out.error ?? out.droppedDynamicXfa)}`);
    const s = await structure(out.bytes);
    assert(!s.needsRendering && !s.hasXfa && (!s.hasForm || !s.fields.length), 'no XFA, no NeedsRendering, no fields');
    const [text] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(out.bytes));
    assert(text.includes('Ana Lima'), `the name is part of the page: ${text}`);
    console.log('ok XFA dropped');
  }

  // --- Password-protected PDFs: formPdf() locked with "secret" (AES-256 and RC4), made with
  // pikepdf, since pdf-lib leaves strings unencrypted when it encrypts. ---------------------
  for (const file of ['flatten-locked.pdf', 'flatten-locked-rc4.pdf']) {
    const locked = new Uint8Array(await fixture(file));
    const none = await flatten(page, url, { name: 'locked.pdf', bytes: locked });
    assert(none.error === 'PasswordError' && !none.wrong, `a password is needed: ${JSON.stringify(none)}`);
    const wrong = await flatten(page, url, { name: 'locked.pdf', bytes: locked, password: 'guess' });
    assert(wrong.error === 'PasswordError' && wrong.wrong, `a wrong password is said: ${JSON.stringify(wrong)}`);
    const out = await flatten(page, url, { name: 'locked.pdf', bytes: locked, password: 'secret' });
    assert(!out.error, `opened with its password: ${out.message}`);
    const s = await structure(out.bytes);
    assert(!s.encrypted, 'the flattened PDF has no password');
    assert(s.pages[0].length === 1 && s.pages[0][0].subtype === 'Link', `flattened: ${JSON.stringify(s.pages[0])}`);
    const [text] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(out.bytes));
    assert(text.includes('Jane Doe') && text.includes('Lisbon'), `its fields are part of the page: ${text}`);
    console.log('ok password', file);
  }

  // --- Cancelling, a damaged file, a name asked for, several PDFs one after another ----------
  {
    const source = await formPdf();
    const now = await flatten(page, url, { name: 'form.pdf', bytes: source }, { abortNow: true });
    assert(now.error === 'CancelledError', `cancelled before starting: ${JSON.stringify(now)}`);
    const midway = await flatten(page, url, { name: 'form.pdf', bytes: source }, { abortAt: 2 });
    assert(midway.error === 'CancelledError', `cancelled midway: ${JSON.stringify(midway)}`);
    const junk = await flatten(page, url, { name: 'junk.pdf', bytes: new TextEncoder().encode('%PDF-1.7\nnot really a PDF\n'.repeat(20)) });
    assert(junk.error === 'UserError' && junk.key === 'pdf_import_failed', `a damaged file is said: ${JSON.stringify(junk)}`);
    const named = await flatten(page, url, { name: 'form.pdf', bytes: source, outputName: 'My form.pdf' });
    assert(named.name === 'My form.pdf', `the name asked for: ${named.name}`);
    const many = await page.evaluate(async ({ base, files }) => {
      const { flattenPdf } = await import(new URL('app/js/engine/flatten.js', base).href);
      const out = [];
      for (const f of files) {
        try {
          const r = await flattenPdf({ name: f.name, bytes: Uint8Array.from(atob(f.bytes), (c) => c.charCodeAt(0)) }, { name: f.name.replace('.pdf', '_flat') }, {});
          out.push(r.name + ':' + r.keptFields);
        } catch (e) {
          out.push(f.name + ':' + e.key);
        }
      }
      return out;
    }, { base: url, files: [
      { name: 'form.pdf', bytes: b64(source) },
      { name: 'alpha.pdf', bytes: b64(await plainPdf()) },
      { name: 'amounts.pdf', bytes: b64(await unencodableFormPdf()) },
    ] });
    assert(JSON.stringify(many) === JSON.stringify(['form_flat.pdf:0', 'alpha.pdf:flatten_nothing', 'amounts_flat.pdf:2']), `each PDF on its own: ${many}`);
    console.log('ok cancel, damaged, names, several');
  }

  // --- Comments with no look of their own are drawn as viewers draw them ---------------------
  {
    const source = await noLookPdf();
    const out = await flatten(page, url, { name: 'nolook.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    await saveOutput('flatten-nolook_flattened.pdf', out.bytes);
    const s = await structure(out.bytes);
    assert(s.pages[0].length === 0, 'no comment left');
    // pdf.js draws text markup, ink, ellipses and polylines without a look the same way; the
    // line's endings, the polygon's closing edge, the text box, stamp, caret and note icons it
    // draws otherwise or not at all (on the canvas), as the app's PDFBox does.
    const differ = [[300, 540, 520, 640], [70, 400, 250, 520], [495, 495, 525, 525], [300, 280, 520, 380], [70, 150, 250, 210], [295, 145, 325, 175], [50, 55, 540, 85]];
    const [r] = await compare(page, source, out.bytes, {
      name: 'nolook',
      skip: [differ],
      check: `(after) => {
        const f = window.__flat, v = after.viewport, c = after.canvas;
        const ink = (r, g, b) => r < 230 || g < 230 || b < 230;
        return {
          arrow: f.count(c, v, [495, 605, 515, 625], (r, g, b) => r < 80 && g < 80 && b < 80),
          polygonFill: f.count(c, v, [140, 420, 180, 450], (r, g, b) => b > 230 && r > 150 && r < 200),
          freeText: f.count(c, v, [300, 280, 520, 380], (r, g, b) => b > 150 && r < 100 && g < 100),
          stamp: f.count(c, v, [70, 150, 250, 210], (r, g, b) => r > 150 && g < 80 && b < 80),
          caret: f.count(c, v, [300, 150, 320, 170], (r, g, b) => b > 150 && r < 80 && g < 80),
          icons: [...Array(13).keys()].map((i) => f.count(c, v, [60 + i * 36, 60, 78 + i * 36, 80], ink)),
        };
      }`,
    });
    const c = r.checks;
    assert(c.arrow > 10, `the line's arrow is drawn: ${c.arrow}`);
    assert(c.polygonFill > 200, `the polygon is filled: ${c.polygonFill}`);
    assert(c.freeText > 100, `the text box's text is drawn: ${c.freeText}`);
    assert(r.textAfter.includes('A text box comment') && r.textAfter.includes('NOT APPROVED'), `the text box and stamp are text: ${r.textAfter}`);
    assert(c.stamp > 300, `the stamp is drawn: ${c.stamp}`);
    assert(c.caret > 10, `the caret is drawn: ${c.caret}`);
    assert(c.icons.every((n) => n > 40), `each note icon is drawn: ${c.icons}`);
    console.log('ok comments without a look');
  }

  // --- Pages sharing resources; a comment on a layer that is off -----------------------------
  {
    const source = await sharedAndLayerPdf();
    const out = await flatten(page, url, { name: 'shared.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    const r = await compare(page, source, out.bytes, {
      name: 'shared',
      check: `(after) => {
        const f = window.__flat, v = after.viewport, c = after.canvas;
        return {
          red: f.count(c, v, [100, 400, 400, 500], ${RED}),
          blue: f.count(c, v, [100, 400, 400, 500], ${BLUE}),
          green: f.count(c, v, [300, 400, 400, 500], (r, g, b) => g > 120 && r < 60 && b < 60),
        };
      }`,
    });
    assert(r[0].checks.red > 10000 && r[0].checks.blue === 0, `page 1 shows its own red square only: ${JSON.stringify(r[0].checks)}`);
    assert(r[1].checks.blue > 10000 && r[1].checks.red === 0, `page 2 shows its own blue square only: ${JSON.stringify(r[1].checks)}`);
    assert(r[2].checks.red === 0 && r[2].checks.green > 10000, `the comment on the layer that is off stays hidden: ${JSON.stringify(r[2].checks)}`);
    console.log('ok shared resources and layers');
  }

  // --- Check boxes and radio buttons without a look ------------------------------------------
  {
    const source = await buttonsPdf();
    const out = await flatten(page, url, { name: 'buttons.pdf', bytes: source });
    assert(!out.error, `flattened: ${out.message}`);
    await saveOutput('flatten-buttons_flattened.pdf', out.bytes);
    const r = await page.evaluate(async (bytes) => {
      const f = window.__flat;
      const [p] = await f.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)), 2);
      const dark = (r, g, b) => r < 90 && g < 90 && b < 90;
      const blue = (r, g, b) => b > 120 && r < 60 && g < 60;
      return {
        radio: [0, 1].map((i) => f.count(p.canvas, p.viewport, [23 + 40 * i, 153, 37 + 40 * i, 167], dark)),
        boxes: [0, 1, 2, 3, 4].map((i) => f.count(p.canvas, p.viewport, [23 + 40 * i, 103, 37 + 40 * i, 117], blue)),
        off: f.count(p.canvas, p.viewport, [23, 53, 37, 67], dark),
        png: f.png(p.canvas),
      };
    }, b64(out.bytes));
    await saveOutput('flatten-buttons-after.png', Buffer.from(r.png, 'base64'));
    assert(r.radio[0] === 0 && r.radio[1] > 40, `only the chosen radio button shows its dot: ${r.radio}`);
    assert(r.boxes.every((n) => n > 20), `each ticked box shows its symbol: ${r.boxes}`);
    assert(r.off === 0, `an unticked box shows nothing inside: ${r.off}`);
    console.log('ok buttons without a look');
  }

  // --- bakeUnder: what Edit PDF and Sign PDF draw over goes into the page first --------------
  {
    const result = await page.evaluate(async ({ base, bytes }) => {
      const { loadPdf, savePdf } = await import(new URL('app/js/engine/pdf-common.js', base).href);
      const { bakeUnder } = await import(new URL('app/js/engine/flatten.js', base).href);
      const doc = await loadPdf(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)));
      // Over the "name" field and the red square only.
      await bakeUnder(doc, 0, [[80, 590, 120, 610], [360, 310, 380, 330]]);
      const out = await savePdf(doc);
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(s);
    }, { base: url, bytes: b64(await formPdf()) });
    const baked = new Uint8Array(Buffer.from(result, 'base64'));
    const s = await structure(baked);
    const names = s.fields.map((f) => f.name);
    assert(!names.includes('name') && names.includes('city') && names.includes('agree'), `only the field under the area is taken off the form: ${names}`);
    const subtypes = s.pages[0].map((a) => a.subtype);
    assert(subtypes.filter((t) => t === 'Square').length === 2, `the red square is baked, the hidden ones stay: ${subtypes}`);
    assert(subtypes.includes('Link') && subtypes.includes('Ink') && subtypes.includes('Text'), `the others stay: ${subtypes}`);
    const [text] = await page.evaluate(async (bytes) => (await window.__flat.render(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)))).map((p) => p.text), b64(baked));
    assert(text.includes('Jane Doe') && !text.includes('Lisbon'), `only the field under the area is part of the page: ${text}`);
    console.log('ok bakeUnder');
  }
});

// The main case in Firefox and WebKit too.
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/fonts/OFL.txt');
    await page.evaluate(pageHelpers);
    const source = await formPdf();
    const out = await flatten(page, url, { name: 'form.pdf', bytes: source });
    assert(!out.error, `${browser}: flattened: ${out.message}`);
    const s = await structure(out.bytes);
    assert(s.pages[0].length === 1 && s.pages[0][0].subtype === 'Link', `${browser}: only the link stays`);
    const kept = await flatten(page, url, { name: 'amounts.pdf', bytes: await unencodableFormPdf() });
    assert(kept.keptFields === 2, `${browser}: fields kept`);
    console.log(`ok ${browser}`);
  }, { browser });
}

console.log('flatten: all passed');
