// The page on which Redact PDF's boxes are marked (the app's RedactOptions.kt BoxEditor). The page
// is drawn exactly as the redacted picture will show it, with its boxes over it, see-through so
// what they cover can be checked. Dragging on the page draws a box; dragging a box moves it, and
// dragging the chosen box's corner resizes it; tapping a box chooses it, and tapping elsewhere
// lets it go. On the web each box is also a button a keyboard reaches (arrow keys move it, Shift
// and arrow keys resize it, Delete removes it), and the page zooms: buttons on wide screens, Ctrl
// and the mouse wheel, + and -, or two fingers on a touch screen.
//
// The editor keeps no boxes of its own: it reads them from state() and reports what the user did.
import { h } from '../../core/dom.js';
import { t, tp, formatNumber } from '../../core/i18n.js';
import { iconButton, linearProgress, uid } from '../../core/ui.js';

/** A box drawn smaller than this on the screen, either way, is taken for a slip and dropped (the app's 6 dp). */
const MIN_DRAWN = 6;
/** How near the chosen box's bottom-right corner a touch takes its handle, to resize it. */
const HANDLE_REACH = 24;
/** How far around a box a tap still chooses it, so a thin box is easy to tap. */
const BOX_REACH = 12;
/** How far a pointer moves before a press becomes a drag (Compose's touch slop; less for a mouse). */
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 4;
/** The zoom buttons' steps, as multiples of the page fitting the screen. */
const ZOOMS = [1, 1.25, 1.5, 2, 3, 4];
const MAX_ZOOM = ZOOMS[ZOOMS.length - 1];
/** An A4 page stands in until the page's own shape is known. */
const A4 = 595 / 842;
/** The preview's picture is kept below this many pixels and this long a side, however far zoomed. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
/** Arrow keys with Ctrl (or ⌘) take this many steps at once. */
const BIG_STEP = 10;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

let scrollbar = null;
/** How tall a horizontal scroll bar is here: 0 where scroll bars lie over the content (phones, macOS). */
function scrollbarSize() {
  if (scrollbar != null) return scrollbar;
  const probe = h('div', { style: { position: 'absolute', top: '-200px', width: '100px', height: '100px', overflow: 'scroll', visibility: 'hidden' } });
  document.body.append(probe);
  scrollbar = Math.max(0, probe.offsetHeight - probe.clientHeight);
  probe.remove();
  return scrollbar;
}

/**
 * The page editor. Returns { el, zoomBar, setPdf(pdf), showPage(index), update(), relayout(),
 * isReady(), frame(), focusBox(index), focusFallback(), zoom(), setZoom(z), destroy() }.
 *
 * @param {object} o
 * @param {object} o.engine        engine/redact.js (renderPreview and the box helpers)
 * @param {() => { boxes: object[], page: number, selected: number }} o.state
 * @param {(index: number) => void} o.onSelect     a box tapped (-1: none)
 * @param {(box: object) => void} o.onAdd          a box drawn
 * @param {(index: number, was: object, box: object) => void} o.onChange   a box moved or resized by dragging
 * @param {(index: number, step: (box) => object) => void} o.onKeyStep     an arrow key on box `index`
 * @param {(index: number) => void} o.onKeyDelete  Delete on box `index`
 * @param {(page: number) => void} o.onPage        Page Up / Page Down
 * @param {() => void} o.onReady   the page showing has been drawn (or couldn't be)
 * @param {string} [o.describedBy] the id of the keyboard hint, for the box buttons
 */
export function createEditor({ engine: E, state, onSelect, onAdd, onChange, onKeyStep, onKeyDelete, onPage, onReady, describedBy }) {
  let pdf = null;
  let page = 0;
  let aspect = A4;
  /** The page last drawn: { index, canvas, pxWidth, frame }. */
  let rendered = null;
  let failed = -1;
  let drawController = null;
  let drawTimer = 0;
  let zoom = 1;
  let size = { sheetW: 0, sheetH: 0, tallest: 0 };
  /** A press on the page, until it lifts: a tap, or a drag drawing, moving or resizing a box. */
  let gesture = null;
  /** The box being drawn (index -1), or box `was` (at `index` when touched) being moved or resized. */
  let draft = null;
  /** Two fingers zooming and moving the page. */
  let pinch = null;
  /** After two fingers, the others are ignored until all have lifted. */
  let pinched = false;
  const touches = new Map();
  let destroyed = false;

  const canvasHost = h('div', { class: 'redact-canvas' });
  // Until the page has been drawn, a bar on white; a page that can't be drawn says so.
  const loading = linearProgress({ value: null, label: t('redact_mark') });
  const failedText = h('p', { class: 'redact-failed' }, t('redact_page_failed'));
  const status = h('div', { class: 'redact-status' }, loading, failedText);
  const chosenText = h('span', { class: 'visually-hidden', id: uid('redact-chosen') });
  const boxesEl = h('div', { class: 'redact-boxes', role: 'group', tabindex: '-1', 'aria-describedby': chosenText.id });
  const draftEl = h('div', { class: 'redact-box is-chosen is-draft', 'aria-hidden': 'true', hidden: true });
  const sheet = h('div', { class: 'redact-sheet' }, canvasHost, boxesEl, draftEl, status, chosenText);
  const viewport = h('div', { class: 'redact-viewport' }, sheet);
  const el = h('div', { class: 'redact-editor' }, viewport);
  const buttons = [];

  // ---- Zoom ----

  const zoomOut = iconButton({ icon: 'zoom_out', label: t('web_redact_zoom_out'), onClick: () => stepZoom(-1) });
  const zoomIn = iconButton({ icon: 'zoom_in', label: t('web_redact_zoom_in'), onClick: () => stepZoom(1) });
  const zoomFit = iconButton({ icon: 'fit_screen', label: t('web_redact_zoom_fit'), onClick: () => setZoom(1) });
  const zoomLevel = h('span', { class: 'redact-zoom-level', 'aria-live': 'polite' });
  const zoomBar = h('div', { class: 'redact-zoombar', role: 'group', 'aria-label': t('web_redact_zoom') }, zoomOut, zoomLevel, zoomIn, zoomFit);

  function updateZoomBar() {
    zoomLevel.textContent = formatNumber(Math.round(zoom * 100) / 100, { style: 'percent', maximumFractionDigits: 0 });
    zoomOut.disabled = zoom <= 1.001;
    zoomFit.disabled = zoom <= 1.001;
    zoomIn.disabled = zoom >= MAX_ZOOM - 0.001;
  }

  function stepZoom(direction) {
    const next = direction > 0 ? ZOOMS.find((z) => z > zoom + 0.01) : [...ZOOMS].reverse().find((z) => z < zoom - 0.01);
    setZoom(next ?? (direction > 0 ? MAX_ZOOM : 1));
  }

  /** Zooms to `z` times the page fitting, keeping the page's point under `anchor` (client px) in place. */
  function setZoom(z, anchor, { draw = true } = {}) {
    z = clamp(z, 1, MAX_ZOOM);
    if (Math.abs(z - zoom) < 0.001) return;
    const vr = viewport.getBoundingClientRect();
    const ax = anchor?.x ?? vr.left + viewport.clientWidth / 2;
    const ay = anchor?.y ?? vr.top + Math.min(viewport.clientHeight, window.innerHeight - vr.top) / 2;
    const before = sheet.getBoundingClientRect();
    const fx = before.width ? (ax - before.left) / before.width : 0.5;
    const fy = before.height ? (ay - before.top) / before.height : 0.5;
    zoom = z;
    layout({ draw: false });
    const after = sheet.getBoundingClientRect();
    viewport.scrollLeft += after.left + fx * after.width - ax;
    viewport.scrollTop += after.top + fy * after.height - ay;
    if (draw) scheduleDraw();
  }

  // ---- Size and drawing ----

  const wide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 840px)').matches;

  /** The tallest the page shows at its fitting size. */
  function tallest() {
    const height = window.innerHeight || 800;
    // A tall page is at most 440 px high on a phone, and less in landscape, so the whole page fits
    // on the screen (the app's rule); a computer's window gives it the height it has.
    return wide() ? clamp(height - 252, 320, 1600) : Math.min(440, Math.max(240, height - 180));
  }

  /** How many pixels per CSS pixel the preview is drawn at, for the size it shows at. */
  function pixelRatio(w, hgt) {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    return Math.max(0.25, Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, w * hgt)), MAX_SIDE / Math.max(1, w), MAX_SIDE / Math.max(1, hgt)));
  }

  /** Sizes the page to the space it has and the zoom; draws it again once the size settles. */
  function layout({ draw = true } = {}) {
    // The frame's width with any scroll bar, so a scroll bar coming or going doesn't resize the page.
    const vw = viewport.offsetWidth;
    if (!vw) return;
    const most = tallest();
    const fitW = Math.min(vw, most * aspect);
    const fitH = fitW / aspect;
    const sheetW = Math.max(1, Math.round(fitW * zoom));
    const sheetH = Math.max(1, Math.round(fitH * zoom));
    viewport.classList.toggle('is-zoomed', zoom > 1.001);
    sheet.style.width = `${sheetW}px`;
    sheet.style.height = `${sheetH}px`;
    const across = sheetW > vw + 0.5;
    // Room for a scroll bar under a page wider than the screen, where scroll bars take room.
    const bar = across ? scrollbarSize() : 0;
    viewport.style.height = `${Math.min(most, sheetH + bar)}px`;
    size = { sheetW, sheetH, tallest: most };
    updateZoomBar();
    if (!draw || !pdf) return;
    if (!rendered || rendered.index !== page) return;
    // A sharper picture once zoomed in, a lighter one once zoomed out.
    const need = sheetW * pixelRatio(sheetW, sheetH);
    if (Math.abs(rendered.pxWidth - need) / need > 0.2) scheduleDraw();
  }

  function scheduleDraw(delay = 200) {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(() => draw(page), delay);
  }

  function release(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }

  /** Draws page `index` at the size it shows, replacing the picture once it is ready. */
  async function draw(index) {
    clearTimeout(drawTimer);
    drawController?.abort();
    if (!pdf || destroyed) return;
    const controller = new AbortController();
    drawController = controller;
    const { sheetW, sheetH } = size;
    const width = sheetW || 400;
    const height = sheetH || width / aspect;
    let canvas;
    try {
      canvas = await E.renderPreview(pdf, index, width, { signal: controller.signal, pixelRatio: pixelRatio(width, height) });
    } catch {
      if (controller.signal.aborted || destroyed || index !== page) return;
      // A page the browser can't draw can't be redacted either, so the preview says so.
      failed = index;
      update();
      onReady?.();
      return;
    }
    if (controller.signal.aborted || destroyed || index !== page) {
      release(canvas);
      return;
    }
    const old = rendered?.canvas;
    canvas.className = 'redact-picture';
    canvas.removeAttribute('style');
    canvas.setAttribute('aria-hidden', 'true');
    canvasHost.append(canvas);
    if (old && old !== canvas) release(old);
    const frame = canvas.frame;
    if (frame?.shownWidth > 0 && frame?.shownHeight > 0) {
      const shape = frame.shownWidth / frame.shownHeight;
      if (Math.abs(shape - aspect) > 1e-6) {
        aspect = shape;
        layout({ draw: false });
      }
    }
    const wasReady = rendered?.index === index;
    rendered = { index, canvas, pxWidth: canvas.width, frame };
    failed = -1;
    update();
    if (!wasReady) onReady?.();
  }

  /** Shows page `index` (from 0): its shape at once, its picture once drawn. */
  async function showPage(index) {
    page = index;
    failed = -1;
    gesture = null;
    draft = null;
    update();
    onReady?.();
    if (!pdf) return;
    const doc = pdf;
    try {
      const p = await doc.getPage(index + 1);
      if (doc !== pdf || page !== index) return;
      const [x0, y0, x1, y1] = p.view;
      let w = Math.abs(x1 - x0);
      let hgt = Math.abs(y1 - y0);
      if (((p.rotate % 180) + 180) % 180 === 90) [w, hgt] = [hgt, w];
      if (w > 0 && hgt > 0) aspect = w / hgt;
    } catch {
      // Drawing it fails too, and says so.
    }
    if (doc !== pdf || page !== index) return;
    layout({ draw: false });
    draw(index);
  }

  // ---- The boxes ----

  const isReady = () => !!rendered && rendered.index === page && failed !== page;

  function onPageIndices(boxes) {
    const out = [];
    boxes.forEach((b, i) => { if (b.page === page) out.push(i); });
    return out;
  }

  function place(node, box) {
    // The page isn't mirrored in right-to-left languages: its boxes are placed from its left edge.
    node.style.left = `${box.left * 100}%`;
    node.style.top = `${box.top * 100}%`;
    node.style.width = `${(box.right - box.left) * 100}%`;
    node.style.height = `${(box.bottom - box.top) * 100}%`;
  }

  function boxButton() {
    const b = h('button', { type: 'button', class: 'redact-box', 'aria-describedby': describedBy || null });
    b.addEventListener('focus', () => {
      const index = Number(b.dataset.index);
      if (Number.isInteger(index) && state().selected !== index) onSelect(index);
    });
    b.addEventListener('click', () => {
      const index = Number(b.dataset.index);
      if (Number.isInteger(index) && state().selected !== index) onSelect(index);
    });
    b.addEventListener('keydown', (e) => onBoxKey(e, b));
    return b;
  }

  /** Draws the boxes of the page showing as they are now, or as a drag has them. */
  function update() {
    if (destroyed) return;
    const { boxes, selected } = state();
    const ready = isReady();
    if (rendered) rendered.canvas.hidden = !ready;
    failedText.hidden = failed !== page;
    loading.hidden = failed === page || ready || !pdf;
    status.hidden = failedText.hidden && loading.hidden;
    const onPage = onPageIndices(boxes);
    const chosen = onPage.includes(selected) ? selected : -1;
    boxesEl.setAttribute('aria-label', tp('redact_preview_description', onPage.length, page + 1, onPage.length));
    chosenText.textContent = chosen >= 0 ? t('redact_box_chosen', onPage.indexOf(chosen) + 1, onPage.length) : '';
    const shown = ready ? onPage : [];
    // The box being moved or resized shows where the pointer has it, until something else changes
    // or deletes it: then the drag is over, and the box shows as it is now.
    const dragged = draft?.was ? E.findBox(boxes, draft.index, draft.was) : -1;
    if (draft?.was && dragged < 0) {
      draft = null;
      if (gesture) gesture.over = true;
    }
    while (buttons.length > shown.length) {
      const b = buttons.pop();
      if (b === document.activeElement) boxesEl.focus({ preventScroll: true });
      b.remove();
    }
    while (buttons.length < shown.length) {
      const b = boxButton();
      buttons.push(b);
      boxesEl.append(b);
    }
    shown.forEach((index, k) => {
      const b = buttons[k];
      b.dataset.index = String(index);
      place(b, draft && index === dragged ? draft.box : boxes[index]);
      const isChosen = index === chosen;
      b.classList.toggle('is-chosen', isChosen);
      b.setAttribute('aria-pressed', String(isChosen));
      b.setAttribute('aria-label', t('web_redact_box', k + 1, shown.length));
    });
    if (draft && !draft.was && ready) {
      place(draftEl, draft.box);
      draftEl.hidden = false;
    } else {
      draftEl.hidden = true;
    }
    sheet.classList.toggle('is-ready', ready);
  }

  function focusBox(index) {
    const b = buttons.find((x) => Number(x.dataset.index) === index);
    if (b) b.focus({ preventScroll: true });
    return !!b;
  }

  /** Where the focus goes when the box that had it is gone. */
  function focusFallback() {
    boxesEl.focus({ preventScroll: true });
  }

  function onBoxKey(e, b) {
    const index = Number(b.dataset.index);
    if (!Number.isInteger(index)) return;
    const big = e.ctrlKey || e.metaKey ? BIG_STEP : 1;
    const d = E.STEP * big;
    let step = null;
    if (e.shiftKey) {
      if (e.key === 'ArrowRight') step = (box) => E.resized(box, d, 0);
      else if (e.key === 'ArrowLeft') step = (box) => E.resized(box, -d, 0);
      else if (e.key === 'ArrowDown') step = (box) => E.resized(box, 0, d);
      else if (e.key === 'ArrowUp') step = (box) => E.resized(box, 0, -d);
    } else if (e.key === 'ArrowRight') step = (box) => E.moved(box, d, 0);
    else if (e.key === 'ArrowLeft') step = (box) => E.moved(box, -d, 0);
    else if (e.key === 'ArrowDown') step = (box) => E.moved(box, 0, d);
    else if (e.key === 'ArrowUp') step = (box) => E.moved(box, 0, -d);
    if (step && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      onKeyStep(index, step);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      onKeyDelete(index);
      return;
    }
    if (e.key === 'Escape' && state().selected === index) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(-1);
    }
  }

  // Keys anywhere in the editor: zoom, and Page Up / Page Down for the next page.
  el.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('.redact-zoombar')) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); stepZoom(1); } else if (e.key === '-' || e.key === '_') { e.preventDefault(); stepZoom(-1); } else if (e.key === '0') { e.preventDefault(); setZoom(1); } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      onPage(page + (e.key === 'PageDown' ? 1 : -1));
    }
  });

  // ---- Pointers ----

  function pointAt(e) {
    const r = sheet.getBoundingClientRect();
    const w = r.width || 1;
    const hgt = r.height || 1;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, w, h: hgt, fx: x / w, fy: y / hgt };
  }

  /** The chosen box, if it is on the page showing. */
  function chosenOnPage() {
    const { boxes, selected } = state();
    const box = boxes[selected];
    return box && box.page === page ? box : null;
  }

  function onHandle(p) {
    const box = chosenOnPage();
    return !!box && Math.hypot(p.x - box.right * p.w, p.y - box.bottom * p.h) <= HANDLE_REACH;
  }

  function shaped(g, p) {
    const { all, hit, start } = g;
    if (g.handle) return { index: hit, was: all[hit], box: E.withCorner(all[hit], p.fx, p.fy) };
    if (hit >= 0) return { index: hit, was: all[hit], box: E.moved(all[hit], p.fx - start.fx, p.fy - start.fy) };
    return { index: -1, was: null, box: E.between(page, start.fx, start.fy, p.fx, p.fy) };
  }

  /** Where the box touched is now: something else may have deleted it, or a box before it, meanwhile. */
  function touched(g) {
    return g.hit < 0 ? -1 : E.findBox(state().boxes, g.hit, g.all[g.hit]);
  }

  function setCursor(p) {
    if (!isReady()) {
      sheet.style.cursor = '';
      return;
    }
    const { boxes } = state();
    if (onHandle(p)) sheet.style.cursor = 'nwse-resize';
    else if (E.hit(boxes, page, p.fx, p.fy, BOX_REACH / p.w, BOX_REACH / p.h) >= 0) sheet.style.cursor = 'move';
    else sheet.style.cursor = 'crosshair';
  }

  function startPinch() {
    const [a, b] = [...touches.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = sheet.getBoundingClientRect();
    pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom,
      fx: r.width ? (mid.x - r.left) / r.width : 0.5,
      fy: r.height ? (mid.y - r.top) / r.height : 0.5,
    };
  }

  function movePinch() {
    const [a, b] = [...touches.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    zoom = clamp(pinch.zoom * (dist / pinch.dist), 1, MAX_ZOOM);
    layout({ draw: false });
    // The page's point that was between the fingers stays between them, wherever they go.
    const r = sheet.getBoundingClientRect();
    viewport.scrollLeft += r.left + pinch.fx * r.width - mid.x;
    viewport.scrollTop += r.top + pinch.fy * r.height - mid.y;
  }

  sheet.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { sheet.setPointerCapture(e.pointerId); } catch { /* gone already */ }
      if (touches.size === 2) {
        // A second finger: the drag so far is dropped, and the two fingers zoom and move the page.
        e.preventDefault();
        gesture = null;
        draft = null;
        pinched = true;
        startPinch();
        update();
        return;
      }
      if (touches.size > 2 || pinched) return;
    }
    if (gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!isReady()) return;
    const p = pointAt(e);
    const { boxes: all, selected } = state();
    const handle = onHandle(p);
    const hit = handle ? selected : E.hit(all, page, p.fx, p.fy, BOX_REACH / p.w, BOX_REACH / p.h);
    // The page doesn't scroll the screen, and no text is selected: drags on it draw.
    e.preventDefault();
    try { sheet.setPointerCapture(e.pointerId); } catch { /* gone already */ }
    gesture = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, start: p, all, handle, hit, moved: false, over: false };
    if (e.pointerType === 'mouse') sheet.style.cursor = handle ? 'nwse-resize' : hit >= 0 ? 'move' : 'crosshair';
  });

  sheet.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        e.preventDefault();
        movePinch();
        return;
      }
    }
    const g = gesture;
    if (!g || e.pointerId !== g.id) {
      if (!g && e.pointerType === 'mouse' && !e.buttons) setCursor(pointAt(e));
      return;
    }
    if (g.over) return;
    if (!g.moved) {
      const slop = g.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP;
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < slop) return;
      g.moved = true;
      if (g.hit >= 0) {
        const now = touched(g);
        if (now >= 0) onSelect(now);
      }
    }
    e.preventDefault();
    draft = shaped(g, pointAt(e));
    update();
  });

  function finish(e, cancelled) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (pinch && touches.size < 2) {
        pinch = null;
        scheduleDraw(0);
      }
      if (!touches.size) pinched = false;
    }
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    gesture = null;
    const result = draft;
    draft = null;
    if (cancelled || g.over) {
      update();
      return;
    }
    if (!g.moved) {
      const now = touched(g);
      // A tap on a box chooses it; a tap elsewhere lets the chosen one go. A box deleted meanwhile,
      // and another in its place, isn't chosen.
      if (g.hit < 0 || now >= 0) {
        onSelect(now);
        if (now >= 0) focusBox(now);
      }
      update();
      return;
    }
    if (result) {
      const p = pointAt(e);
      if (result.was) {
        onChange(result.index, result.was, result.box);
      } else if ((result.box.right - result.box.left) * p.w >= MIN_DRAWN && (result.box.bottom - result.box.top) * p.h >= MIN_DRAWN) {
        onAdd(result.box);
      }
    }
    update();
    if (e.pointerType === 'mouse') setCursor(pointAt(e));
  }

  sheet.addEventListener('pointerup', (e) => finish(e, false));
  sheet.addEventListener('pointercancel', (e) => finish(e, true));
  // The page let go of the pointer without it lifting (the page went away, say): the drag is dropped.
  sheet.addEventListener('lostpointercapture', (e) => {
    // Only the page's own capture: the one a touch's first target had (which bubbles here) isn't it.
    if (e.target !== sheet) return;
    if ((gesture && e.pointerId === gesture.id) || touches.has(e.pointerId)) finish(e, true);
  });
  // A stray touch or click elsewhere on the page doesn't open the browser's menus over it.
  sheet.addEventListener('contextmenu', (e) => { if (gesture || isReady()) e.preventDefault(); });

  // Ctrl (or ⌘) and the wheel, and a trackpad's pinch, zoom the page around the pointer.
  viewport.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !pdf) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.002;
    setZoom(zoom * Math.exp(-e.deltaY * scale), { x: e.clientX, y: e.clientY });
  }, { passive: false });

  // The focus frame shows for the keyboard only: a box chosen with the pointer, which takes the
  // focus so the keyboard can carry on from it, shows the app's dashed frame.
  const onAnyKey = (e) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) sheet.classList.add('is-keyboard'); };
  const onAnyPointer = () => sheet.classList.remove('is-keyboard');
  document.addEventListener('keydown', onAnyKey, true);
  document.addEventListener('pointerdown', onAnyPointer, true);

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  resizeObserver?.observe(viewport);
  const onWindowResize = () => layout();
  window.addEventListener('resize', onWindowResize);

  updateZoomBar();
  update();

  return {
    el,
    zoomBar,
    /** Starts on a pdf.js document (PdfSource.pdfjs()); null puts it away. */
    setPdf(doc) {
      drawController?.abort();
      clearTimeout(drawTimer);
      pdf = doc;
      if (rendered) release(rendered.canvas);
      rendered = null;
      failed = -1;
      zoom = 1;
      aspect = A4;
      layout({ draw: false });
      update();
    },
    showPage,
    update,
    relayout: () => layout(),
    isReady,
    /** The page showing's frame ({ shownWidth, shownHeight, ... }) once it is drawn, else null. */
    frame: () => (isReady() ? rendered.frame : null),
    focusBox,
    focusFallback,
    /** Whether a box button of the editor has the focus. */
    hasFocus: () => el.contains(document.activeElement),
    zoom: () => zoom,
    setZoom: (z) => setZoom(z),
    /** Stops drawing and lets the picture go. */
    destroy() {
      destroyed = true;
      drawController?.abort();
      clearTimeout(drawTimer);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('keydown', onAnyKey, true);
      document.removeEventListener('pointerdown', onAnyPointer, true);
      if (rendered) release(rendered.canvas);
      rendered = null;
      pdf = null;
    },
  };
}
