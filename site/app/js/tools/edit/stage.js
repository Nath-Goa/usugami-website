// Edit PDF's page (EditPreview.kt): the page drawn as it is shown, with what was added drawn on it as
// the PDF will have it, and the touches that choose, move, resize and draw. With a finger, a pen or
// a mouse: touching an item chooses it and dragging moves it, the chosen item's handles change its
// size or shape, and a tap elsewhere lets go of it; a swipe that starts off the items scrolls the
// screen. While drawing, a finger, pen or mouse draws. The page can be zoomed in (buttons, pinch, or
// Ctrl and the mouse wheel) to place things precisely. Each item is also a button a screen reader or
// the keyboard can find and choose.
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import {
  bounds, handles, pick, dragHandle, moved, describeKey, drawItem, drawLiveStroke, Handle,
} from '../../engine/edit.js';

/** How far the chosen item's frame stands off what it covers, in CSS pixels. */
const HANDLE_GAP = 4;
const HANDLE_RADIUS = 6;
/** How close a touch must come to an item to pick it, in CSS pixels; a handle half as far again. */
const REACH = 12;
/** Points of a stroke closer together than this on the screen (CSS pixels) add nothing. */
const MIN_STEP = 2;
/** How far a finger (or the mouse) moves before a touch is a drag rather than a tap. */
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 3;

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

/** The largest picture of the page drawn, in pixels: a side and an area. */
const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const density = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

/**
 * Where an item's handles show, in points: a box's and a line's on its corners and ends, and text's
 * and a drawing's on the corner of the frame around them, `gap` points out, clear of the ink.
 */
function handleSpots(item, gap) {
  return handles(item).map(([handle, x, y]) => (item.type === 'text' || item.type === 'ink' ? [handle, x + gap, y + gap] : [handle, x, y]));
}

const CURSORS = {
  [Handle.TOP_LEFT]: 'nwse-resize', [Handle.BOTTOM_RIGHT]: 'nwse-resize',
  [Handle.TOP_RIGHT]: 'nesw-resize', [Handle.BOTTOM_LEFT]: 'nesw-resize',
  [Handle.START]: 'crosshair', [Handle.END]: 'crosshair',
};

/**
 * The page preview.
 * @param {{
 *   look: { text(item): object|null, picture(item): ImageBitmap|null },
 *   onSelect(id: number|null): void, onBegin(): void, onDrag(was: object, next: object): boolean, onEnd(): void,
 *   onStroke(points: number[], page: number): void, inkRoom(): number, onFull(): void,
 *   busy(): boolean, onZoom?(zoom: number): void,
 * }} hooks
 */
export function createStage(hooks) {
  const sheet = h('div', { class: 'edit-sheet' });
  const nodes = h('div', { class: 'edit-nodes' });
  sheet.append(nodes);
  const viewport = h('div', { class: 'edit-viewport' }, sheet);
  const canvas = h('canvas', { class: 'edit-canvas', 'aria-hidden': 'true' });
  const frame = h('div', { class: 'edit-frame', role: 'group' }, viewport, canvas);
  const el = h('div', { class: 'edit-stage' }, frame);

  let src = null;           // the PdfSource
  let index = 0;            // the page shown
  let size = { width: 595, height: 842, box: null, rotation: 0 };   // until the page's size is known, A4
  let known = false;
  let items = [];           // the items on this page, in drawing order
  let selected = null;      // the chosen item, on this page
  let mode = 'select';
  let style = null;
  let zoom = 1;
  let cssWidth = 0;         // the page's size on the screen at zoom 1, CSS pixels
  let cssHeight = 0;
  let base = null;          // { canvas, index, scale }: the page drawn whole
  let detail = null;        // { canvas, index, zoom, x, y, w, h }: the part showing, drawn sharp when zoomed in
  let baseTask = null;
  let detailTask = null;
  let detailTimer = 0;
  let renderToken = 0;
  let frameRequest = 0;
  let gesture = null;
  let pinch = null;
  let focused = null;       // the id of the item whose button has the keyboard focus
  let destroyed = false;
  const nodeById = new Map();

  const scale = () => (cssWidth / size.width) * zoom;   // CSS pixels per point, zoomed

  // ---- Size and zoom ----

  /** Lays the page out for the room there is: as wide as the screen, but at most `tallest` high. */
  const layout = () => {
    if (destroyed) return;
    const room = el.clientWidth || frame.parentElement?.clientWidth || 320;
    const wide = matchMedia('(min-width: 840px)').matches;
    const vh = window.innerHeight || 800;
    // On phones at most half the screen high, so the tools above or the chosen item's controls below
    // show with it (as the app); on wide screens as tall as fits between the bars with what is around it.
    let tallest = clamp(vh * 0.5, 240, 560);
    if (wide) {
      const top = el.isConnected ? el.getBoundingClientRect().top + window.scrollY : 200;
      const below = hooks.below?.() ?? 120;
      tallest = clamp(vh - top - below, 320, 1100);
    }
    const aspect = size.width / size.height;
    const w = Math.max(80, Math.min(room, tallest * aspect));
    const hgt = w / aspect;
    if (Math.abs(w - cssWidth) < 0.5 && Math.abs(hgt - cssHeight) < 0.5) return;
    const keep = cssWidth > 0 ? centre() : null;
    cssWidth = w;
    cssHeight = hgt;
    frame.style.width = w + 'px';
    frame.style.height = hgt + 'px';
    applyZoom(keep);
    // Drawn again when it is now noticeably bigger on the screen than it was drawn.
    if (src && (!base || base.scale < (cssWidth / size.width) * density() * 0.8)) renderBase();
    redraw();
  };

  /** The point of the page in the middle of what shows, in points. */
  const centre = () => {
    const s = scale();
    return [(viewport.scrollLeft + viewport.clientWidth / 2) / s, (viewport.scrollTop + viewport.clientHeight / 2) / s];
  };

  /** Sizes the sheet for the zoom, with `keep` (a point of the page) where it was on the screen. */
  const applyZoom = (keep, at = null) => {
    sheet.style.width = cssWidth * zoom + 'px';
    sheet.style.height = cssHeight * zoom + 'px';
    viewport.classList.toggle('is-zoomed', zoom > 1);
    if (keep) {
      const s = scale();
      const ax = at ? at[0] : viewport.clientWidth / 2;
      const ay = at ? at[1] : viewport.clientHeight / 2;
      viewport.scrollLeft = keep[0] * s - ax;
      viewport.scrollTop = keep[1] * s - ay;
    }
  };

  /**
   * Zooms to `z` (1 to ZOOM_MAX), keeping the point under `at` (CSS pixels in the page's frame;
   * by default its middle) where it is.
   */
  const setZoom = (z, at = null) => {
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(z - zoom) < 0.001) return;
    const s = scale();
    const ax = at ? at[0] : viewport.clientWidth / 2;
    const ay = at ? at[1] : viewport.clientHeight / 2;
    const keep = [(viewport.scrollLeft + ax) / s, (viewport.scrollTop + ay) / s];
    zoom = z;
    applyZoom(keep, [ax, ay]);
    redraw();
    scheduleDetail();
    hooks.onZoom?.(zoom);
  };

  // ---- Drawing the page ----

  /** The pdf.js pages drawn, so what pdf.js keeps of them (decoded images, operator lists) can be let go. */
  const drawnPages = new Set();
  const pdfPage = async () => {
    const page = await (await src.pdfjs()).getPage(index + 1);
    drawnPages.add(page);
    return page;
  };

  /**
   * Lets pdf.js free what it keeps of the pages drawn but `keep` (the page showing, drawn again
   * sharp as it is zoomed): a scanned page's decoded image alone can be 30 MB. A page still being
   * drawn is freed by pdf.js once that ends.
   */
  const releasePages = (keep = null) => {
    for (const page of drawnPages) {
      if (page === keep) continue;
      try { page.cleanup(); } catch { /* the document is closed already */ }
      drawnPages.delete(page);
    }
  };

  /** A pdf.js viewport showing exactly the crop box the PDF's edits are placed on. */
  const viewportFor = (page, pxPerPoint, offsetX = 0, offsetY = 0) => {
    const unit = page.getViewport({ scale: 1 });
    if (!size.box) return page.getViewport({ scale: pxPerPoint, offsetX, offsetY });
    const Viewport = unit.constructor;
    return new Viewport({ viewBox: size.box, userUnit: 1, scale: pxPerPoint, rotation: size.rotation, offsetX, offsetY, dontFlip: false });
  };

  const renderBase = async () => {
    const token = ++renderToken;
    baseTask?.cancel?.();
    baseTask = null;
    detail = null;
    if (!src || src.closed) return;
    try {
      const page = await pdfPage();
      if (token !== renderToken || destroyed) return;
      // Another page showing now: what pdf.js kept of those shown before goes.
      releasePages(page);
      let pxPerPoint = (Math.max(cssWidth, 160) / size.width) * density();
      pxPerPoint = Math.min(pxPerPoint, MAX_SIDE / size.width, MAX_SIDE / size.height, Math.sqrt(MAX_AREA / (size.width * size.height)));
      const vp = viewportFor(page, pxPerPoint);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width));
      c.height = Math.max(1, Math.round(vp.height));
      // With alpha, so text is smoothed in grey: coloured LCD fringes would show once the picture is scaled.
      const g = c.getContext('2d', { alpha: true });
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      const task = page.render({ canvas: c, viewport: vp, background: '#ffffff' });
      baseTask = task;
      await task.promise;
      if (token !== renderToken || destroyed) return;
      // The page last drawn stays while the next one is drawn, instead of flashing blank.
      base = { canvas: c, index, scale: pxPerPoint };
      frame.classList.add('is-drawn');
      redraw();
      scheduleDetail();
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException' && token === renderToken && !destroyed) {
        // A page pdf.js can't draw stays white; what is added still shows on it.
        frame.classList.add('is-drawn');
        redraw();
      }
    }
  };

  /** Once zooming and scrolling rest, the part showing is drawn again sharp. */
  const scheduleDetail = () => {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(renderDetail, 160);
  };

  const renderDetail = async () => {
    if (!src || src.closed || destroyed || !base) return;
    const s = scale();
    const need = s * density();
    if (need <= base.scale * 1.05) {
      detail = null;
      redraw();
      return;
    }
    const token = renderToken;
    detailTask?.cancel?.();
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const x = viewport.scrollLeft / s;
    const y = viewport.scrollTop / s;
    try {
      const page = await pdfPage();
      if (token !== renderToken || destroyed) return;
      const vp = viewportFor(page, need, -x * need, -y * need);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(vw * density()));
      c.height = Math.max(1, Math.ceil(vh * density()));
      // With alpha, so text is smoothed in grey: coloured LCD fringes would show once the picture is scaled.
      const g = c.getContext('2d', { alpha: true });
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      const task = page.render({ canvas: c, viewport: vp, background: '#ffffff' });
      detailTask = task;
      await task.promise;
      if (token !== renderToken || destroyed) return;
      detail = { canvas: c, index, zoom, x, y, w: c.width / need, h: c.height / need };
      redraw();
    } catch {
      // Cancelled by a newer one, or a page pdf.js can't draw: the whole page's picture stays.
    }
  };

  const redraw = () => {
    if (frameRequest || destroyed) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      paint();
    });
  };

  const paint = () => {
    const d = density();
    const cw = viewport.clientWidth || Math.round(cssWidth);
    const ch = viewport.clientHeight || Math.round(cssHeight);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    const pw = Math.max(1, Math.round(cw * d));
    const ph = Math.max(1, Math.round(ch * d));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, pw, ph);
    const s = scale();
    const sx = viewport.scrollLeft;
    const sy = viewport.scrollTop;
    // Points on the page to the canvas's pixels.
    ctx.setTransform(d * s, 0, 0, d * s, -sx * d, -sy * d);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (base && base.index === index) ctx.drawImage(base.canvas, 0, 0, size.width, size.height);
    if (detail && detail.index === index && Math.abs(detail.zoom - zoom) < 0.001) ctx.drawImage(detail.canvas, detail.x, detail.y, detail.w, detail.h);
    for (const item of items) drawItem(ctx, item, hooks.look);
    if (gesture?.kind === 'draw' && gesture.points.length) {
      drawLiveStroke(ctx, gesture.points, gesture.color, gesture.width, gesture.highlighter);
    }
    // The chosen item's frame and handles show what can be dragged. They aren't part of the PDF.
    const primary = getComputedStyle(el).getPropertyValue('--primary').trim() || '#b3261e';
    ctx.setTransform(d, 0, 0, d, -sx * d, -sy * d);
    const focusItem = focused != null ? items.find((it) => it.id === focused) : null;
    if (focusItem && focusItem !== selected) {
      const b = bounds(focusItem);
      ctx.strokeStyle = primary;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(b.x * s - HANDLE_GAP - 2, b.y * s - HANDLE_GAP - 2, b.width * s + 2 * HANDLE_GAP + 4, b.height * s + 2 * HANDLE_GAP + 4);
    }
    if (selected && mode === 'select') {
      const b = bounds(selected);
      ctx.strokeStyle = primary;
      ctx.lineWidth = focused === selected.id ? 2.5 : 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x * s - HANDLE_GAP, b.y * s - HANDLE_GAP, b.width * s + 2 * HANDLE_GAP, b.height * s + 2 * HANDLE_GAP);
      ctx.setLineDash([]);
      for (const [, x, y] of handleSpots(selected, HANDLE_GAP / s)) {
        ctx.beginPath();
        ctx.arc(x * s, y * s, HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = primary;
        ctx.stroke();
      }
    }
  };

  // ---- Items as buttons, for screen readers and the keyboard ----

  const renderNodes = () => {
    // The smaller ones come last, on top, so one inside a bigger one (text in a box) can be reached.
    const order = items.map((it) => ({ it, b: bounds(it) })).sort((a, b) => b.b.width * b.b.height - a.b.width * a.b.height);
    const seen = new Set();
    for (const { it, b } of order) {
      seen.add(it.id);
      let node = nodeById.get(it.id);
      if (!node) {
        node = h('button', { type: 'button', class: 'edit-node', tabindex: '0', dataset: { id: it.id } });
        // Chosen with the keyboard or a screen reader (presses on the page are taken by the
        // sheet): the item is scrolled to when zoomed in. A press never scrolls.
        node.addEventListener('click', () => {
          const id = Number(node.dataset.id);
          hooks.onSelect(id);
          stage.reveal(id);
        });
        node.addEventListener('focus', () => { focused = Number(node.dataset.id); redraw(); });
        node.addEventListener('blur', () => { if (focused === Number(node.dataset.id)) focused = null; redraw(); });
        nodeById.set(it.id, node);
      }
      const [key, arg] = describeKey(it);
      node.setAttribute('aria-label', arg != null ? t(key, arg) : t(key));
      node.setAttribute('aria-pressed', String(selected?.id === it.id));
      node.style.left = (b.x / size.width) * 100 + '%';
      node.style.top = (b.y / size.height) * 100 + '%';
      node.style.width = (b.width / size.width) * 100 + '%';
      node.style.height = (b.height / size.height) * 100 + '%';
    }
    for (const [id, node] of nodeById) {
      if (!seen.has(id)) {
        node.remove();
        nodeById.delete(id);
      }
    }
    // Put in order only when it changed: moving a button in the page takes its focus away.
    const wanted = order.map(({ it }) => nodeById.get(it.id));
    const now = Array.from(nodes.children);
    if (wanted.length !== now.length || wanted.some((n, i) => n !== now[i])) {
      const active = document.activeElement;
      nodes.append(...wanted);
      if (active && wanted.includes(active) && document.activeElement !== active) active.focus({ preventScroll: true });
    }
  };

  // ---- Touches ----

  const toPoint = (e) => {
    const r = sheet.getBoundingClientRect();
    const s = r.width / size.width;
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  };

  /** What a touch at page point p takes: { handle, grip } of the chosen item, an item, or null. */
  const grab = (p) => {
    const s = scale();
    const reach = REACH / s;
    if (selected && mode === 'select') {
      const corners = new Map(handles(selected).map(([hd, x, y]) => [hd, [x, y]]));
      const near = handleSpots(selected, HANDLE_GAP / s).find(([, x, y]) => Math.hypot(x - p[0], y - p[1]) <= 1.5 * reach);
      if (near) {
        const [cx, cy] = corners.get(near[0]);
        // Where the handle's corner is from the finger: it moves as far as the finger does, rather
        // than jumping under it (text's and a drawing's handle shows beside the corner).
        return { item: selected, handle: near[0], grip: [cx - p[0], cy - p[1]] };
      }
    }
    const hit = pick(items, p[0], p[1], reach, selected?.id ?? null);
    return hit ? { item: hit, handle: null, grip: [0, 0] } : null;
  };

  const usable = () => known && !hooks.busy();

  const onPointerDown = (e) => {
    if (destroyed || !usable()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (gesture) {
      // One finger draws; others are ignored. A second finger on a drag ends it (a pinch follows).
      if (gesture.kind !== 'draw' && e.pointerType === 'touch') finishGesture(false);
      return;
    }
    if (pinch) return;
    const p = toPoint(e);
    if (mode !== 'select') {
      startStroke(e, p);
      return;
    }
    const taken = grab(p);
    if (!taken) {
      // Off every item: a tap lets go of the chosen one, a swipe scrolls (a mouse drags the page about when zoomed in).
      gesture = { kind: 'none', id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, moved: false, scroll: [viewport.scrollLeft, viewport.scrollTop] };
      if (e.pointerType === 'mouse') {
        e.preventDefault();
        // The keys (Delete, arrows, Ctrl+Z) then work on the page.
        frame.focus({ preventScroll: true });
        sheet.setPointerCapture?.(e.pointerId);
      }
      return;
    }
    e.preventDefault();
    if (taken.item.id !== selected?.id) hooks.onSelect(taken.item.id);
    if (e.pointerType === 'mouse') nodeById.get(taken.item.id)?.focus({ preventScroll: true });
    gesture = {
      kind: 'item', id: e.pointerId, type: e.pointerType, start: taken.item, last: taken.item,
      handle: taken.handle, grip: taken.grip, down: p, x0: e.clientX, y0: e.clientY, dragging: false, over: false,
    };
    try { sheet.setPointerCapture?.(e.pointerId); } catch { /* the pointer went already */ }
  };

  const startStroke = (e, p) => {
    let room = hooks.inkRoom();
    if (room <= 0) {
      hooks.onFull();
      return;
    }
    e.preventDefault();
    if (e.pointerType === 'mouse') frame.focus({ preventScroll: true });
    const highlighter = mode === 'highlighter';
    gesture = {
      kind: 'draw', id: e.pointerId, page: index, points: [], room, highlighter,
      color: highlighter ? style.highlighterColor : style.penColor,
      width: highlighter ? style.highlighterWidth : style.penWidth,
    };
    try { sheet.setPointerCapture?.(e.pointerId); } catch { /* the pointer went already */ }
    addPoint(p);
    redraw();
  };

  const addPoint = (p) => {
    const g = gesture;
    const px = clamp(p[0], 0, size.width);
    const py = clamp(p[1], 0, size.height);
    const n = g.points.length;
    const minStep = MIN_STEP / scale();
    if (g.room <= 0 || (n >= 2 && Math.hypot(px - g.points[n - 2], py - g.points[n - 1]) < minStep)) return;
    g.points.push(px, py);
    g.room--;
  };

  const onPointerMove = (e) => {
    const g = gesture;
    if (!g) {
      if (e.pointerType === 'mouse' && usable()) hover(e);
      return;
    }
    if (e.pointerId !== g.id) return;
    if (g.kind === 'draw') {
      // Points between frames make the curve smoother.
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) addPoint(toPoint(ev));
      redraw();
      return;
    }
    const slop = g.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP;
    const far = Math.hypot(e.clientX - g.x0, e.clientY - g.y0) >= slop;
    if (g.kind === 'none') {
      if (far) g.moved = true;
      if (g.type === 'mouse' && g.moved && zoom > 1) {
        viewport.scrollLeft = g.scroll[0] - (e.clientX - g.x0);
        viewport.scrollTop = g.scroll[1] - (e.clientY - g.y0);
      }
      return;
    }
    if (g.over) return;
    // A tap only chooses: a finger that doesn't mean to drag still moves a pixel or two, which
    // mustn't move the item, or take the place of Redo.
    if (!g.dragging) {
      if (!far) return;
      g.dragging = true;
      hooks.onBegin();
    }
    const p = toPoint(e);
    const next = g.handle
      ? dragHandle(g.start, g.handle, p[0] + g.grip[0], p[1] + g.grip[1], size.width, size.height)
      : moved(g.start, p[0] - g.down[0], p[1] - g.down[1], size.width, size.height);
    // Each step goes on from the item as the last one left it. Changed some other way meanwhile
    // (a colour picked, another page, the drag undone), it is left as it is now, and the drag is over.
    if (!hooks.onDrag(g.last, next)) {
      g.over = true;
      g.dragging = false;
      hooks.onEnd();
      return;
    }
    g.last = next;
  };

  const finishGesture = (completed) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    try { sheet.releasePointerCapture?.(g.id); } catch { /* not captured */ }
    if (g.kind === 'none') {
      if (completed && !g.moved) hooks.onSelect(null);
    } else if (g.kind === 'item') {
      if (g.dragging) hooks.onEnd();
    } else if (g.kind === 'draw') {
      // A stroke cut short (the browser took the touch) isn't kept, and isn't left drawn either.
      if (completed && g.points.length) hooks.onStroke(g.points.slice(), g.page);
      redraw();
    }
  };

  const onPointerUp = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    if (gesture.kind === 'draw') addPoint(toPoint(e));
    finishGesture(true);
  };

  const onPointerCancel = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    finishGesture(false);
  };

  /** A mouse over the page: the cursor says what pressing would do. */
  const hover = (e) => {
    if (mode !== 'select') {
      sheet.style.cursor = 'crosshair';
      return;
    }
    const taken = grab(toPoint(e));
    sheet.style.cursor = taken ? (taken.handle ? CURSORS[taken.handle] : 'move') : (zoom > 1 ? 'grab' : '');
  };

  // A touch that starts on an item (or on the chosen one's handle) drags it rather than scrolling
  // the screen; one that starts elsewhere scrolls. Two fingers zoom the page.
  const onTouchStart = (e) => {
    if (!usable()) return;
    if (e.touches.length >= 2) {
      if (mode === 'select' && (!gesture || gesture.kind !== 'draw')) {
        if (e.cancelable) e.preventDefault();
        startPinch(e);
      }
      return;
    }
    if (mode !== 'select') {
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (grab(toPoint(e.touches[0])) && e.cancelable) e.preventDefault();
  };

  const touchMid = (e) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    const r = viewport.getBoundingClientRect();
    return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
  };

  const startPinch = (e) => {
    const m = touchMid(e);
    pinch = { zoom, d: Math.max(1, m.d), x: m.x, y: m.y };
  };

  const onTouchMove = (e) => {
    if (!pinch || e.touches.length < 2) return;
    if (e.cancelable) e.preventDefault();
    const m = touchMid(e);
    setZoom(pinch.zoom * (m.d / pinch.d), [m.x, m.y]);
    viewport.scrollLeft -= m.x - pinch.x;
    viewport.scrollTop -= m.y - pinch.y;
    pinch.x = m.x;
    pinch.y = m.y;
    redraw();
  };

  const onTouchEnd = (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      scheduleDetail();
    }
  };

  // Ctrl (or ⌘) and the wheel, or a trackpad's pinch, zoom about the mouse.
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !known) return;
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setZoom(zoom * Math.exp(-step * 0.0025), [e.clientX - r.left, e.clientY - r.top]);
  };

  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerUp);
  sheet.addEventListener('pointercancel', onPointerCancel);
  sheet.addEventListener('lostpointercapture', (e) => { if (gesture && e.pointerId === gesture.id && gesture.kind !== 'none') onPointerCancel(e); });
  sheet.addEventListener('touchstart', onTouchStart, { passive: false });
  sheet.addEventListener('touchmove', onTouchMove, { passive: false });
  sheet.addEventListener('touchend', onTouchEnd);
  sheet.addEventListener('touchcancel', onTouchEnd);
  sheet.addEventListener('contextmenu', (e) => { if (mode !== 'select' || gesture) e.preventDefault(); });
  sheet.addEventListener('dragstart', (e) => e.preventDefault());
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('scroll', () => {
    redraw();
    scheduleDetail();
  }, { passive: true });

  const resize = new ResizeObserver(() => layout());
  resize.observe(el);
  const onWindowResize = () => layout();
  window.addEventListener('resize', onWindowResize);

  const stage = {
    el,
    frame,
    sheet,
    viewport,
    canvas,

    /** Shows page `i` of `source`, `pageSize` ({ width, height, box, rotation }) as shown, or null while unknown. */
    setPage(source, i, pageSize) {
      const samePage = source === src && i === index;
      const sameSize = pageSize && known && pageSize.width === size.width && pageSize.height === size.height && String(pageSize.box) === String(size.box);
      src = source;
      index = i;
      known = !!pageSize;
      if (pageSize) size = { width: pageSize.width, height: pageSize.height, box: pageSize.box ?? null, rotation: pageSize.rotation ?? 0 };
      frame.setAttribute('aria-label', t('edit_preview_description', i + 1));
      if (samePage && sameSize && base) return;
      if (!samePage) {
        cancelGesture();
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
      }
      cssWidth = 0;
      layout();
      renderBase();
    },

    /** The items on the page, and the chosen one (or null). */
    setItems(list, chosenId) {
      items = list;
      selected = chosenId != null ? list.find((it) => it.id === chosenId) ?? null : null;
      renderNodes();
      redraw();
    },

    setMode(m, s) {
      if (m !== mode && gesture?.kind === 'draw') cancelGesture();
      const changed = m !== mode;
      mode = m;
      style = s;
      el.classList.toggle('is-drawing', mode !== 'select');
      frame.dataset.mode = mode;
      // Only when the mode changes: every step of a drag comes through here too, and would put the
      // plain arrow back in place of the move or resize cursor.
      if (changed) sheet.style.cursor = mode !== 'select' ? 'crosshair' : '';
      redraw();
    },

    setZoom,
    get zoom() { return zoom; },
    get known() { return known; },
    get size() { return size; },
    get drawing() { return gesture?.kind === 'draw'; },
    /** How many pdf.js pages the stage keeps what pdf.js decoded of (for tests: the page showing only). */
    get keptPages() { return drawnPages.size; },
    /** The button standing for item `id`, for the focus. */
    nodeOf: (id) => nodeById.get(id) ?? null,
    redraw,
    layout,
    /** Shows the item `id`'s box, scrolled to when zoomed in. */
    reveal(id) {
      const it = items.find((x) => x.id === id);
      if (!it || zoom <= 1) return;
      const b = bounds(it);
      const s = scale();
      const left = b.x * s;
      const top = b.y * s;
      if (left < viewport.scrollLeft || left + b.width * s > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left - 24;
      if (top < viewport.scrollTop || top + b.height * s > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top - 24;
    },
    destroy() {
      destroyed = true;
      cancelGesture();
      clearTimeout(detailTimer);
      cancelAnimationFrame(frameRequest);
      baseTask?.cancel?.();
      detailTask?.cancel?.();
      resize.disconnect();
      window.removeEventListener('resize', onWindowResize);
      releasePages();
      base = null;
      detail = null;
    },
  };

  /** Drops what a finger is doing (the page changed, say): a drag ends, a stroke isn't kept. */
  function cancelGesture() {
    if (!gesture) return;
    finishGesture(false);
  }

  return stage;
}
