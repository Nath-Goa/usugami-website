// The Usugami watermark on the result screen (ui/ResultMarker.kt, ui/MarkCard.kt): a switch that puts
// a small "Usugami" on the PDFs just made, or takes it off them again, and an arrow that opens its
// size and opacity with the first page showing the mark as they move. One setting for the whole
// app, kept in this browser: every PDF made afterwards gets the mark until it is turned off.
//
// The PDFs are made without it (the tools take a mark off the PDFs they read, engine/pdf-common.js);
// the result screen keeps each one as it was made and shows, opens, shares and saves the version
// the setting asks for: marked from the PDF as made (engine/page-mark.js), or the PDF as made again,
// byte for byte, when it is turned off.
import { h, announce, yieldToUI } from './dom.js';
import { t } from './i18n.js';
import { getSetting, setSetting, onSettingChange } from './settings.js';
import { switchRow, slider, iconButton, linearProgress, uid } from './ui.js';
import { CancelledError, checkCancelled } from './errors.js';
import {
  MarkStyle, MarkLayout, DEFAULT_SIZE, DEFAULT_OPACITY, MIN_OPACITY, sameMark, mayCarryMark,
} from '../engine/mark-layout.js';

const PDF = 'application/pdf';

/** The settings' keys (core/settings.js): whether it is on, and its size and opacity. */
export const MARK_KEYS = Object.freeze({ on: 'mark.on', size: 'mark.size', opacity: 'mark.opacity' });

/** Whether the mark is on and its style (MarkSetting): off unless turned on, the style kept while it is off. */
export function getMarkSetting() {
  return {
    on: getSetting(MARK_KEYS.on, false) === true,
    style: MarkStyle.of(getSetting(MARK_KEYS.size, DEFAULT_SIZE), getSetting(MARK_KEYS.opacity, DEFAULT_OPACITY)),
  };
}

/** The mark the PDFs made now get (MarkSetting.wanted): its style when it is on, else null. */
export function wantedMark() {
  const s = getMarkSetting();
  return s.on ? s.style : null;
}

/** Puts the mark on, or takes it off, for the PDFs made from now on and the results showing. */
export function setMarkOn(on) {
  setSetting(MARK_KEYS.on, !!on);
}

/** Gives the mark `style` ({ size, opacity }), kept while it is off. */
export function setMarkStyle(style) {
  const s = MarkStyle.of(style.size, style.opacity);
  setSetting(MARK_KEYS.size, s.size);
  setSetting(MARK_KEYS.opacity, s.opacity);
}

/**
 * Calls `fn(setting)` once for each change of the mark's settings, here or in another tab (a
 * change of size and opacity together is one call). Returns an unsubscribe function.
 */
export function onMarkSettingChange(fn) {
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn(getMarkSetting());
    });
  };
  const offs = Object.values(MARK_KEYS).map((key) => onSettingChange(key, changed));
  return () => offs.forEach((off) => off());
}

const engine = () => import('../engine/page-mark.js');

/** Whether an OutputFile is a PDF (the mark goes on PDFs only). */
export function isPdfOutput(file) {
  return (file?.type || PDF).toLowerCase() === PDF;
}

const keyOf = (style) => `${style.size}/${style.opacity}`;

// What is known of each OutputFile handed to a result screen, kept while the file is: the PDF as
// made, without any mark, and the version with the mark last put on it. A result shown again (the
// browser's Forward, Back to editing and the result again) then needs no work for it.
const known = new WeakMap();

function stateOf(file) {
  let s = known.get(file);
  if (!s) {
    s = { made: null, madePromise: null, marked: null };
    // Nearly every PDF is made without a mark: told at once, without reading it.
    if (!isPdfOutput(file) || !mayCarryMark(file.bytes)) s.made = file;
    known.set(file, s);
  }
  return s;
}

/**
 * The Usugami mark on a result's files (ResultMarker): each file as it was made, and the version
 * showing, with the mark it carries. `bringTo(style | null)` changes the versions showing; nothing
 * else changes them. Files other than PDFs are shown as they are.
 */
export class ResultMarker {
  /** @param {OutputFile[]} files the files as the tool made them */
  constructor(files) {
    this.entries = files.map((original) => {
      const state = stateOf(original);
      const pdf = isPdfOutput(original);
      // undefined: not known yet (a PDF that may have kept a mark from the PDF it was made of).
      return { original, state, pdf, current: state.made ?? original, mark: state.made ? null : undefined };
    });
  }

  /**
   * Shows each PDF with `wanted` at once where that needs no work: its version with that mark made
   * before (a result shown again), or, for none, the PDF as made. Returns whether all are at it.
   */
  useKnown(wanted) {
    const key = wanted ? keyOf(wanted) : null;
    for (const e of this.entries) {
      if (!e.pdf || (e.mark !== undefined && sameMark(e.mark, wanted))) continue;
      if (wanted && e.state.marked?.key === key) {
        e.current = e.state.marked.file;
        e.mark = wanted;
      } else if (!wanted && e.state.made) {
        e.current = e.state.made;
        e.mark = null;
      }
    }
    return this.isAt(wanted);
  }

  /** Whether some file is a PDF, which the mark can go on. */
  get hasPdfs() {
    return this.entries.some((e) => e.pdf);
  }

  /** The files as they show now, in order. */
  get files() {
    return this.entries.map((e) => e.current);
  }

  /** Whether every PDF shows with `wanted` (a style, or null for none). */
  isAt(wanted) {
    return this.entries.every((e) => !e.pdf || (e.mark !== undefined && sameMark(e.mark, wanted)));
  }

  /** Whether bringing the files to `wanted` would put the mark on any (rather than only take it off). */
  marksAny(wanted) {
    if (!wanted) return false;
    const key = keyOf(wanted);
    return this.entries.some((e) => e.pdf && !(e.mark !== undefined && sameMark(e.mark, wanted)) && e.state.marked?.key !== key);
  }

  /**
   * The PDF `entry` was made as, without any mark: the file itself, or, for one that kept a mark
   * from the PDF it was made of (Compress PDF keeping the original as it was), a copy with the mark
   * taken off, which no longer is that original. Read once, whoever asks.
   */
  made(entry) {
    const s = entry.state;
    if (s.made) return Promise.resolve(s.made);
    s.madePromise ??= (async () => {
      let made = entry.original;
      try {
        const { markPdf } = await engine();
        const bytes = await markPdf(entry.original.bytes, null);
        if (bytes) made = { ...entry.original, bytes, keptOriginal: false };
      } catch {
        // Not a PDF pdf-lib can read: it shows as it is, and can't be marked either.
      }
      s.made = made;
      return made;
    })();
    return s.madePromise;
  }

  /** The first PDF as it was made, for the preview; null when there is none. */
  firstMade() {
    const first = this.entries.find((e) => e.pdf);
    return first ? this.made(first) : Promise.resolve(null);
  }

  /**
   * Brings every PDF to carry `wanted` (a MarkStyle), or no mark when it is null. Each is marked
   * from the PDF as made; with the mark off each is the PDF as made again. The files showing change
   * all at once, when all are done; stopped by `signal` (CancelledError), they stay as they were.
   * `onFile(index, count, name)` is told of each PDF being marked. A PDF that can't be marked stays
   * as it was, and `failed` says so.
   * @returns {Promise<{ changed: boolean, failed: boolean }>}
   */
  async bringTo(wanted, { signal, onFile } = {}) {
    const pdfs = this.entries.filter((e) => e.pdf);
    const updates = [];
    let failed = false;
    for (let i = 0; i < pdfs.length; i++) {
      const e = pdfs[i];
      checkCancelled(signal);
      if (e.mark !== undefined && sameMark(e.mark, wanted)) continue;
      const made = await this.made(e);
      checkCancelled(signal);
      if (!wanted) {
        updates.push({ e, file: made, mark: null });
        continue;
      }
      const key = keyOf(wanted);
      if (e.state.marked?.key === key) {
        updates.push({ e, file: e.state.marked.file, mark: wanted });
        continue;
      }
      onFile?.(i, pdfs.length, made.name);
      try {
        const { markPdf } = await engine();
        const bytes = await markPdf(made.bytes, wanted, { signal });
        // Saved anew, a PDF Compress kept as it was isn't that PDF any more.
        const file = bytes ? { ...made, bytes, keptOriginal: false } : made;
        e.state.marked = { key, file };
        updates.push({ e, file, mark: wanted });
      } catch (err) {
        if (err instanceof CancelledError || signal?.aborted) throw new CancelledError();
        failed = true;
      }
      await yieldToUI();
    }
    checkCancelled(signal);
    let changed = false;
    for (const { e, file, mark } of updates) {
      if (e.current !== file) changed = true;
      e.current = file;
      e.mark = mark;
    }
    return { changed, failed };
  }
}

// ---------------------------------------------------------------------------------------------
// The card

/** How much of its opacity the word keeps on the preview page while the mark is off. */
const OFF_ALPHA = 0.25;
/** A4's size in points, for a page that couldn't be drawn. */
const A4 = { width: 595.28, height: 841.89 };
/** The preview page's largest size on screen, in CSS pixels. */
const PREVIEW_MAX = { width: 150, height: 200 };
const WORD_FONT = 'Helvetica, Arial, "Liberation Sans", "Noto Sans", sans-serif';

/** The device's pixels per CSS pixel, kept to 3. */
const density = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

/**
 * The card at the top of the result screen (MarkCard): "Usugami watermark" and its line, the
 * arrow that opens its size and opacity, the switch; a bar under the row while the PDFs change;
 * and, opened, the first page with the mark drawn on it as the sliders move. A tap anywhere on the
 * row flips the switch. The PDFs change once a slider is let go.
 * @param {{ setting: { on: boolean, style: MarkStyle }, onOn(on: boolean), onStyle(style: MarkStyle),
 *   page: () => Promise<{ canvas: HTMLCanvasElement|null, width: number, height: number }|null> }} options
 *   page: draws the first page as made, asked for when the card is first opened
 * @returns {HTMLElement} el.setSetting(setting), el.setWorking(b), el.setEnabled(b), el.open(b), el.isOpen,
 *   el.sliders ({ size, opacity }), el.arrow, el.row, el.preview
 */
export function markCard({ setting, onOn, onStyle, page }) {
  let current = setting;
  let moving = setting.style;
  let enabled = true;
  let open = false;
  let working = false;
  let pageAsked = false;
  let shown = { canvas: null, width: A4.width, height: A4.height };

  const row = switchRow({
    label: t('mark_title'),
    detail: t('mark_detail'),
    checked: setting.on,
    onChange: (on) => onOn(on),
  });
  row.classList.add('ui-mark-row');
  const panelId = uid('mark-panel');
  const arrow = iconButton({ icon: 'keyboard_arrow_down', label: t('mark_adjust'), cls: 'ui-mark-arrow' });
  arrow.setAttribute('aria-expanded', 'false');
  arrow.setAttribute('aria-controls', panelId);
  // The arrow is a button of its own: it opens the sliders without flipping the switch.
  arrow.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  row.insertBefore(arrow, row.switch);

  // While the PDFs change: a bar under the row, in room of its own, so nothing moves meanwhile.
  const bar = linearProgress({ value: null, label: t('mark_working') });
  const barSlot = h('div', { class: 'ui-mark-working', 'aria-hidden': 'true' });

  // The page with the mark: the first page as made (white A4 until it is drawn), the word over it.
  const pageCanvas = h('canvas', { class: 'ui-mark-canvas' });
  const pageBox = h('div', { class: 'ui-mark-page', role: 'img' }, pageCanvas);

  const percent = (v) => t('mark_percent', v);
  const sizeSlider = slider({
    label: t('mark_size'), min: 0, max: 100, step: 1, value: setting.style.size, format: percent,
    onChange: (v) => { moving = MarkStyle.of(v, moving.opacity); draw(); },
    onCommit: () => letGo(),
  });
  const opacitySlider = slider({
    label: t('mark_opacity'), min: MIN_OPACITY, max: 100, step: 1, value: setting.style.opacity, format: percent,
    onChange: (v) => { moving = MarkStyle.of(moving.size, v); draw(); },
    onCommit: () => letGo(),
  });
  const sliders = h('div', { class: 'ui-mark-sliders' }, sizeSlider, opacitySlider);
  const panel = h('div', { class: 'ui-mark-panel', id: panelId },
    h('div', { class: 'ui-mark-panel-inner' },
      h('div', { class: 'ui-mark-body' }, h('div', { class: 'ui-mark-layout' }, pageBox, sliders))));
  panel.inert = true;

  const card = h('section', { class: 'ui-mark', 'aria-label': t('mark_title') }, row, barSlot, panel);

  // Read when let go, after a keyboard step has just moved it.
  function letGo() {
    const chosen = MarkStyle.of(sizeSlider.value, opacitySlider.value);
    if (!chosen.equals(current.style)) onStyle(chosen);
  }

  function setOpen(b) {
    open = !!b;
    arrow.setAttribute('aria-expanded', String(open));
    card.classList.toggle('is-open', open);
    panel.inert = !open;
    if (open && !pageAsked) {
      pageAsked = true;
      Promise.resolve(page?.()).then((p) => {
        if (p) {
          shown = { canvas: p.canvas ?? null, width: p.width || A4.width, height: p.height || A4.height };
          draw();
        }
      }).catch(() => { /* a white page stands in */ });
    }
    if (open) draw();
  }

  function refreshControls() {
    row.setDisabled(!enabled);
    const slide = enabled && current.on;
    sizeSlider.setDisabled(!slide);
    opacitySlider.setDisabled(!slide);
    pageBox.setAttribute('aria-label', current.on ? t('mark_preview_description') : t('pdf_page_number', 1));
  }

  /** Draws the page and the word on it, as the PDFs will have it (faint while it is off). */
  function draw() {
    if (!open) return;
    const ratio = shown.width / shown.height;
    let w = PREVIEW_MAX.width;
    let hgt = w / ratio;
    if (hgt > PREVIEW_MAX.height) {
      hgt = PREVIEW_MAX.height;
      w = hgt * ratio;
    }
    pageBox.style.width = `${w}px`;
    pageBox.style.height = `${hgt}px`;
    const d = density();
    const pw = Math.max(1, Math.round(w * d));
    const ph = Math.max(1, Math.round(hgt * d));
    if (pageCanvas.width !== pw) pageCanvas.width = pw;
    if (pageCanvas.height !== ph) pageCanvas.height = ph;
    const ctx = pageCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    // The page is white paper in either theme, as the PDF shows it.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pw, ph);
    if (shown.canvas) ctx.drawImage(shown.canvas, 0, 0, pw, ph);
    const scale = pw / shown.width;
    const place = MarkLayout.place(moving, shown.width, shown.height);
    // The word as wide as Helvetica Bold makes it in the PDF, in the screen's own bold sans.
    const wordWidth = MarkLayout.TEXT_WIDTH * place.fontSize * scale;
    ctx.font = `bold 100px ${WORD_FONT}`;
    const probe = Math.max(1, ctx.measureText(MarkLayout.TEXT).width);
    ctx.font = `bold ${(100 * wordWidth) / probe}px ${WORD_FONT}`;
    ctx.textBaseline = 'alphabetic';
    const gray = Math.round(MarkLayout.GRAY * 255);
    ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
    ctx.globalAlpha = current.on ? moving.alpha : moving.alpha * OFF_ALPHA;
    ctx.fillText(MarkLayout.TEXT, place.x * scale, ph - place.y * scale);
    ctx.globalAlpha = 1;
  }

  card.setSetting = (s) => {
    current = s;
    moving = s.style;
    row.setChecked(s.on);
    sizeSlider.setValue(s.style.size);
    opacitySlider.setValue(s.style.opacity);
    refreshControls();
    draw();
  };
  card.setWorking = (b) => {
    if (working === !!b) return;
    working = !!b;
    if (working) {
      barSlot.append(bar);
      announce(t('mark_working'));
    }
    // Faded in and out in its own room; taken away once gone, so it doesn't run unseen.
    requestAnimationFrame(() => barSlot.classList.toggle('is-on', working));
    if (!working) setTimeout(() => { if (!working) bar.remove(); }, 260);
  };
  /** Not while the PDFs, or a ZIP file of them, are being saved. */
  card.setEnabled = (b) => {
    enabled = !!b;
    refreshControls();
  };
  card.open = (b = true) => setOpen(b);
  Object.defineProperty(card, 'isOpen', { get: () => open, configurable: true });
  card.sliders = { size: sizeSlider, opacity: opacitySlider };
  card.arrow = arrow;
  card.row = row;
  card.preview = pageBox;
  refreshControls();
  return card;
}

/**
 * Draws page 1 of `file` (a PDF OutputFile) as shown, for the preview: its picture at most
 * `maxCss` CSS pixels on its longer side at the screen's density, and its size as shown in points.
 * @returns {Promise<{ canvas: HTMLCanvasElement, width: number, height: number }|null>}
 */
export async function drawFirstPage(file, maxCss = 200) {
  if (!file) return null;
  const { openPdfJs } = await import('../lib/pdfjs.js');
  const doc = await openPdfJs(file.bytes);
  try {
    const p = await doc.getPage(1);
    const base = p.getViewport({ scale: 1 });
    const scale = Math.min(4, (maxCss * density()) / Math.max(base.width, base.height));
    const viewport = p.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvas, viewport, background: '#ffffff' }).promise;
    return { canvas, width: base.width, height: base.height };
  } finally {
    doc.loadingTask?.destroy();
  }
}
