// A PDF's pages in a grid (ui/PageGrids.kt): at least 96 px wide, three across on most phones and
// more on wider screens, each a picture of the page (drawn only once it is near the screen, and
// let go again when it is far), turned as it will be, with its number under it. Pages can be chosen
// by tapping them, and moved by a long press and drag (touch), a drag (mouse), Ctrl and the arrow
// keys, or the move-earlier and move-later buttons each page has for keyboards and screen readers.
import { h, announce } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { iconButton, uid } from './ui.js';

/** The space a page's picture gets in its tile, width over height: about a portrait A4 page. */
const TILE_ASPECT = 0.75;
/** How long a touch is held before the page under it lifts, to be dragged. */
const LONG_PRESS_MS = 450;
/** How far a finger may wander while held before it counts as scrolling instead. */
const TOUCH_SLOP = 10;
/** How far a mouse moves with its button down before it drags the page. */
const MOUSE_SLOP = 5;
/** Pages this far beyond the visible area are drawn ahead of being scrolled to. */
const PREFETCH = '600px';
/** Within this distance of the scrolling area's top or bottom, a page being dragged scrolls it. */
const EDGE = 56;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Icons parsed once and copied after: a grid of thousands of pages makes one or two per page.
const iconCopies = new Map();
function iconCopy(name, size) {
  const key = name + '/' + size;
  let svg = iconCopies.get(key);
  if (!svg) iconCopies.set(key, (svg = icon(name, { size })));
  return svg.cloneNode(true);
}

/**
 * @param {object} o
 * @param {number} o.count                     how many pages
 * @param {(i: number, cssWidth: number, opts: { signal: AbortSignal }) => Promise<Node>} o.thumbnail
 * @param {(i: number) => string} [o.label]    under each page (default: its number)
 * @param {(i: number) => string} [o.tileLabel] what a screen reader calls it (default "Page 3")
 * @param {boolean|'single'} [o.selectable]  pages are chosen by tapping them: true, any number
 *   (each a checkbox); 'single', one at a time (a listbox of options, as Reorganize's page)
 * @param {Set<number>} [o.selected] the pages chosen, read on each refresh
 * @param {(i: number) => void} [o.onToggle]   a page was tapped; the grid then redraws it
 * @param {(i: number) => void} [o.onActivate] a page was tapped, in a grid that isn't selectable
 * @param {'primary'|'delete'} [o.selectedStyle] chosen pages framed in the accent colour (default),
 *   or in the error colour, faded behind a delete sign, as Delete pages marks them
 * @param {boolean} [o.reorderable] pages can be moved
 * @param {(from: number, to: number) => (void|false)} [o.onMove] a page moved; false refuses it
 * @param {() => void} [o.onMoveStart]   a drag starts (for one undo step for the whole drag)
 * @param {(from: number, to: number) => void} [o.onMoveEnd]  a drag ended
 * @param {(i: number) => number} [o.rotation]  degrees the page is shown turned clockwise
 * @param {(i: number) => (Node|null)} [o.badge]    a small node at the picture's top corner
 * @param {(i: number) => (Node|null)} [o.overlay]  a node over the picture
 * @param {string} [o.ariaLabel]    the grid's name
 * @returns {HTMLElement} el.refresh(indexes?), el.setCount(n), el.setSelected(set), el.reload(i?),
 *   el.focusIndex(i), el.scrollToIndex(i), el.destroy()
 */
export function pageGrid(o) {
  const opts = {
    label: (i) => String(i + 1),
    tileLabel: (i) => t('pdf_page_number', i + 1),
    selectedStyle: 'primary',
    moveButtons: true,
    ...o,
  };
  // 'multi': checkboxes in a list; 'single': options of a listbox, which holds nothing else (no
  // move buttons: Ctrl and the arrow keys move a page there).
  const mode = opts.selectable === 'single' ? 'single' : opts.selectable ? 'multi' : null;
  const withMoveButtons = opts.reorderable && opts.moveButtons && mode !== 'single';
  let count = Math.max(0, opts.count | 0);
  let selected = opts.selected ?? new Set();
  const hintId = uid('pagegrid-hint');
  const grid = h('div', {
    class: `ui-pagegrid ui-pagegrid--${opts.selectedStyle}` + (opts.reorderable ? ' is-reorderable' : '') + (mode === 'single' ? ' is-single' : ''),
    role: mode === 'single' ? 'listbox' : 'list',
  });
  if (opts.ariaLabel) grid.setAttribute('aria-label', opts.ariaLabel);
  const hint = h('span', { id: hintId, class: 'ui-visually-hidden' }, t('web_reorder_hint'));
  // Read only as the pages' description (aria-describedby reads it while hidden), so a grid whose
  // pages can't be moved doesn't say how to move them, and a list holds only its items.
  hint.hidden = true;
  /** @type {Tile[]} in the order shown */
  let tiles = [];
  let active = 0;
  let observer = null;
  let observerRoot;

  // -------------------------------------------------------------------------------------------
  // Tiles

  class Tile {
    constructor(index) {
      this.index = index;
      this.angle = 0;
      this.controller = null;
      this.node = null;
      this.aspect = null;
      // What the tile shows now, so a redraw only touches what changed: a grid of thousands of
      // pages is redrawn on every tap.
      this.shown = {};
      this.button = h('button', { type: 'button', class: 'ui-page' });
      if (mode === 'multi') this.button.setAttribute('role', 'checkbox');
      else if (mode === 'single') this.button.setAttribute('role', 'option');
      if (opts.reorderable) this.button.setAttribute('aria-describedby', hintId);
      this.turn = h('div', { class: 'ui-page-turn' });
      this.placeholder = h('span', { class: 'ui-page-placeholder', 'aria-hidden': 'true' }, iconCopy('picture_as_pdf', 24));
      this.picture = h('div', { class: 'ui-page-picture' }, this.placeholder, this.turn);
      this.badgeEl = h('div', { class: 'ui-page-badge' });
      this.badgeEl.hidden = true;
      this.overlayEl = h('div', { class: 'ui-page-overlay', 'aria-hidden': 'true' });
      this.labelEl = h('span', { class: 'ui-page-label', 'aria-hidden': 'true' });
      this.button.append(this.picture, this.badgeEl, this.overlayEl, this.labelEl);
      this.wrap = h('div', { class: 'ui-page-tile', role: mode === 'single' ? 'none' : 'listitem' }, this.button);
      if (withMoveButtons) {
        this.earlier = iconButton({ icon: 'arrow_back', label: '', cls: 'ui-page-move' });
        this.later = iconButton({ icon: 'arrow_forward', label: '', cls: 'ui-page-move' });
        this.earlier.addEventListener('click', () => moveBy(this, -1, this.earlier));
        this.later.addEventListener('click', () => moveBy(this, 1, this.later));
        this.wrap.append(h('div', { class: 'ui-page-moves' }, this.earlier, this.later));
      }
      this.wrap.tile = this;
      this.update();
    }

    /** Draws the tile for its page again (label, name, choice, badge, overlay, turn, tab stop). */
    update() {
      const i = this.index;
      const s = this.shown;
      const label = opts.label(i);
      if (label !== s.label) this.labelEl.textContent = s.label = label;
      const name = opts.tileLabel(i);
      if (name !== s.name) this.button.setAttribute('aria-label', s.name = name);
      const chosen = selected.has(i);
      if (chosen !== s.chosen) {
        s.chosen = chosen;
        if (mode === 'multi') this.button.setAttribute('aria-checked', String(chosen));
        else if (mode === 'single') this.button.setAttribute('aria-selected', String(chosen));
        this.wrap.classList.toggle('is-selected', chosen);
      }
      const b = opts.badge?.(i) ?? null;
      if (b !== s.badge) {
        s.badge = b;
        this.badgeEl.replaceChildren(...(b ? [b] : []));
        this.badgeEl.hidden = !b;
      }
      let ov = opts.overlay?.(i) ?? null;
      // Delete pages' sign, made once per tile: CSS shows it on the pages marked.
      if (!ov && opts.selectedStyle === 'delete') ov = this.deleteSign ??= h('span', { class: 'ui-page-delete-sign' }, iconCopy('delete', 24));
      if (ov !== s.overlay) {
        s.overlay = ov;
        this.overlayEl.replaceChildren(...(ov ? [ov] : []));
      }
      if (this.earlier) {
        if (i !== s.moveIndex) {
          s.moveIndex = i;
          this.earlier.setLabel(t('move_page_earlier', i + 1));
          this.later.setLabel(t('move_page_later', i + 1));
        }
        const first = i === 0;
        const last = i === count - 1;
        if (this.earlier.disabled !== first) this.earlier.disabled = first;
        if (this.later.disabled !== last) this.later.disabled = last;
      }
      this.setRotation(opts.rotation?.(i) ?? 0);
      const isActive = i === active;
      if (isActive !== s.active) {
        s.active = isActive;
        const tab = isActive ? 0 : -1;
        this.button.tabIndex = tab;
        if (this.earlier) {
          this.earlier.tabIndex = tab;
          this.later.tabIndex = tab;
        }
      }
    }

    /** Turns the picture to `deg`, the short way round, and sized to fit the tile turned. */
    setRotation(deg) {
      const target = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
      const now = ((this.angle % 360) + 360) % 360;
      let delta = target - now;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      this.angle += delta;
      this.applyTurn();
    }

    applyTurn() {
      let scale = 1;
      if (this.aspect && Math.abs(this.angle) % 180 === 90) {
        // The picture fits the box upright (aspect a, box B): turned, it must fit across the other way.
        const a = this.aspect;
        const B = TILE_ASPECT;
        const w = a > B ? B : a;
        const hgt = a > B ? B / a : 1;
        scale = Math.min(B / hgt, 1 / w);
      }
      const transform = `rotate(${this.angle}deg)` + (scale !== 1 ? ` scale(${scale.toFixed(4)})` : '');
      if (transform !== this.shown.transform) this.turn.style.transform = this.shown.transform = transform;
    }

    load() {
      if (this.node || this.controller || !opts.thumbnail) return;
      const controller = new AbortController();
      this.controller = controller;
      const width = this.picture.clientWidth || 112;
      let p;
      try {
        p = Promise.resolve(opts.thumbnail(this.index, width, { signal: controller.signal }));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then((node) => {
        if (this.controller !== controller || controller.signal.aborted || !node) return;
        this.controller = null;
        this.node = node;
        const w = node.width || node.naturalWidth;
        const hgt = node.height || node.naturalHeight;
        this.aspect = w && hgt ? w / hgt : null;
        node.classList?.add('ui-fade-in');
        this.turn.replaceChildren(node);
        this.picture.classList.add('has-picture');
        this.applyTurn();
      }, () => {
        if (this.controller === controller) this.controller = null;
      });
    }

    unload() {
      this.controller?.abort();
      this.controller = null;
      if (this.node) {
        this.node = null;
        this.turn.replaceChildren();
        this.picture.classList.remove('has-picture');
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Drawing pages as they come near

  const findScroller = (node) => {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  };

  // Tiles off screen aren't laid out (content-visibility, components.css): they are given the
  // height a tile on screen has, so the grid's height and the scrolling stay right.
  let sizeObserver = null;
  let sizeFrame = 0;
  const measureTile = () => {
    sizeFrame = 0;
    const tile = tiles[active] ?? tiles[0];
    const height = tile?.wrap.isConnected ? tile.wrap.getBoundingClientRect().height : 0;
    if (height > 0) grid.style.setProperty('--ui-tile-h', Math.round(height) + 'px');
  };

  const observe = () => {
    if (observer) return;
    measureTile();
    if (typeof ResizeObserver === 'function') {
      sizeObserver = new ResizeObserver(() => { if (!sizeFrame) sizeFrame = requestAnimationFrame(measureTile); });
      sizeObserver.observe(grid);
    }
    observerRoot = findScroller(grid);
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const tile = e.target.tile;
        if (!tile) continue;
        if (e.isIntersecting) tile.load(); else tile.unload();
      }
    }, { root: observerRoot, rootMargin: `${PREFETCH} 0px` });
    for (const tile of tiles) observer.observe(tile.wrap);
  };

  // The grid is added to the page after it is made: start watching once it is there.
  let destroyed = false;
  let tries = 0;
  const waitForPage = () => {
    if (destroyed) return;
    if (grid.isConnected) observe();
    else if (tries++ < 600) requestAnimationFrame(waitForPage);
    else observe();
  };
  requestAnimationFrame(waitForPage);

  // -------------------------------------------------------------------------------------------
  // Building and refreshing

  const build = () => {
    for (const tile of tiles) { tile.unload(); observer?.unobserve(tile.wrap); }
    tiles = [];
    active = Math.min(active, Math.max(0, count - 1));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const tile = new Tile(i);
      tiles.push(tile);
      frag.append(tile.wrap);
    }
    grid.replaceChildren(hint, frag);
    if (observer) for (const tile of tiles) observer.observe(tile.wrap);
  };

  const refreshRange = (a, b) => {
    for (let i = Math.max(0, a); i <= Math.min(count - 1, b); i++) tiles[i].update();
  };

  const setActive = (i) => {
    const before = active;
    active = Math.max(0, Math.min(count - 1, i));
    tiles[before]?.update();
    tiles[active]?.update();
  };

  // -------------------------------------------------------------------------------------------
  // Choosing and moving

  grid.addEventListener('click', (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
      return;
    }
    const button = e.target.closest('.ui-page');
    if (!button || !grid.contains(button)) return;
    const tile = button.closest('.ui-page-tile').tile;
    setActive(tile.index);
    if (mode === 'single') {
      // The page chosen before is let go of: both are drawn again.
      const before = [...selected];
      opts.onToggle?.(tile.index);
      grid.refresh([...before, tile.index]);
    } else if (mode) {
      opts.onToggle?.(tile.index);
      tile.update();
    } else {
      opts.onActivate?.(tile.index);
    }
  }, true);

  grid.addEventListener('focusin', (e) => {
    const wrap = e.target.closest?.('.ui-page-tile');
    if (wrap?.tile && wrap.tile.index !== active) setActive(wrap.tile.index);
  });

  const columns = () => {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols || 1);
  };

  grid.addEventListener('keydown', (e) => {
    const button = e.target.closest?.('.ui-page');
    if (!button) return;
    const tile = button.closest('.ui-page-tile').tile;
    const i = tile.index;
    const rtl = getComputedStyle(grid).direction === 'rtl';
    const cols = columns();
    let to = null;
    switch (e.key) {
      case 'ArrowRight': to = i + (rtl ? -1 : 1); break;
      case 'ArrowLeft': to = i + (rtl ? 1 : -1); break;
      case 'ArrowDown': to = i + cols; break;
      case 'ArrowUp': to = i - cols; break;
      case 'Home': to = 0; break;
      case 'End': to = count - 1; break;
      default: return;
    }
    e.preventDefault();
    to = Math.max(0, Math.min(count - 1, to));
    if ((e.ctrlKey || e.metaKey) && opts.reorderable) {
      move(i, to, { focus: 'tile', say: true });
    } else if (to !== i) {
      setActive(to);
      tiles[to].button.focus();
      tiles[to].button.scrollIntoView?.({ block: 'nearest' });
    }
  });

  const moveBy = (tile, by, focusButton) => {
    const from = tile.index;
    const to = from + by;
    if (to < 0 || to >= count) return;
    move(from, to, { focus: focusButton === tile.earlier ? 'earlier' : 'later', say: true });
  };

  /** Moves the page at `from` to `to`: tells onMove, then moves its tile, the others gliding along. */
  const move = (from, to, { focus, say, animate = true } = {}) => {
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return false;
    if (opts.onMove?.(from, to) === false) return false;
    const before = animate && !reducedMotion() ? rects() : null;
    const [tile] = tiles.splice(from, 1);
    tiles.splice(to, 0, tile);
    const next = tiles[to + 1]?.wrap ?? null;
    grid.insertBefore(tile.wrap, next);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) tiles[i].index = i;
    if (active === from) active = to;
    else if (active >= lo && active <= hi) active += from < to ? -1 : 1;
    refreshRange(lo, hi);
    if (before) glide(before, tile);
    if (focus === 'tile') {
      setActive(to);
      tile.button.focus({ preventScroll: true });
      tile.button.scrollIntoView?.({ block: 'nearest' });
    } else if (focus === 'earlier' || focus === 'later') {
      setActive(to);
      const target = focus === 'earlier' && !tile.earlier.disabled ? tile.earlier
        : focus === 'later' && !tile.later.disabled ? tile.later : tile.button;
      target.focus({ preventScroll: true });
    }
    if (say) announce(t('web_page_moved', to + 1, count));
    return true;
  };

  /** Where the tiles on screen are, to glide them from there after a move (FLIP). */
  const rects = () => {
    const map = new Map();
    const vh = window.innerHeight;
    for (const tile of tiles) {
      const r = tile.wrap.getBoundingClientRect();
      if (r.bottom >= -50 && r.top <= vh + 50) map.set(tile, r);
    }
    return map;
  };

  const glide = (before, skip) => {
    for (const [tile, r] of before) {
      if (tile === skip && dragging) continue;
      const now = tile.wrap.getBoundingClientRect();
      const dx = r.left - now.left;
      const dy = r.top - now.top;
      if (!dx && !dy) continue;
      tile.wrap.style.transition = 'none';
      tile.wrap.style.transform = `translate(${dx}px, ${dy}px)`;
      tile.wrap.getBoundingClientRect();
      tile.wrap.style.transition = '';
      tile.wrap.style.transform = '';
    }
  };

  // -------------------------------------------------------------------------------------------
  // Dragging: a mouse drags at once, a finger after a long press. The grid scrolls when the page
  // is held near its top or bottom.

  let press = null;
  let dragging = null;
  let suppressClick = false;
  let scrollFrame = 0;

  grid.addEventListener('pointerdown', (e) => {
    if (!opts.reorderable || dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const button = e.target.closest('.ui-page');
    if (!button || !grid.contains(button)) return;
    const tile = button.closest('.ui-page-tile').tile;
    press = { tile, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0, downAt: e.timeStamp };
    if (e.pointerType !== 'mouse') {
      press.timer = setTimeout(() => {
        if (press?.tile === tile) startDrag(press.x, press.y);
      }, LONG_PRESS_MS);
    }
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  });

  // Once a page is lifted, the finger moves it instead of scrolling the page.
  grid.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  grid.addEventListener('contextmenu', (e) => { if (press || dragging) e.preventDefault(); });

  const onPointerMove = (e) => {
    if (press && e.pointerId === press.id && !dragging) {
      const dist = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
      if (press.type === 'mouse') {
        if (dist > MOUSE_SLOP) startDrag(press.x0, press.y0);
      } else if (dist > TOUCH_SLOP) {
        // The finger moved before the long press: it is scrolling.
        cancelPress();
        return;
      } else {
        press.x = e.clientX;
        press.y = e.clientY;
      }
    }
    if (dragging && e.pointerId === dragging.id) {
      e.preventDefault();
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      track();
      autoScroll();
    }
  };

  const onPointerUp = (e) => {
    // A tap whose lifting waited behind other work (thumbnails being drawn) can come after the long
    // press timer has lifted the page: by when the finger really lifted, it is still a tap.
    if (dragging && e.pointerId === dragging.id) endDrag(dragging.held && e.timeStamp - dragging.downAt < LONG_PRESS_MS && dragging.tile.index === dragging.from);
    else if (press && e.pointerId === press.id) cancelPress();
  };

  const onPointerCancel = (e) => {
    if (dragging && e.pointerId === dragging.id) endDrag();
    else if (press && e.pointerId === press.id) cancelPress();
  };

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
    if (!dragging) removeWindowListeners();
  };

  const removeWindowListeners = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  };

  const slotOf = (tile) => {
    // Where the tile's place in the grid is on screen, without the shift it is drawn with.
    const g = grid.getBoundingClientRect();
    return {
      left: g.left + grid.clientLeft + tile.wrap.offsetLeft - grid.scrollLeft,
      top: g.top + grid.clientTop + tile.wrap.offsetTop - grid.scrollTop,
    };
  };

  const startDrag = (x, y) => {
    if (!press) return;
    const tile = press.tile;
    clearTimeout(press.timer);
    const slot = slotOf(tile);
    // The grid's places, in its own coordinates: the k-th tile's place stays the k-th place
    // whichever page is in it, so they are measured once.
    const slots = tiles.map((t) => ({ left: t.wrap.offsetLeft, top: t.wrap.offsetTop, right: t.wrap.offsetLeft + t.wrap.offsetWidth, bottom: t.wrap.offsetTop + t.wrap.offsetHeight }));
    dragging = { tile, id: press.id, from: tile.index, x, y, dx: x - slot.left, dy: y - slot.top, slots, held: press.type !== 'mouse', downAt: press.downAt };
    press = null;
    tile.wrap.classList.add('is-dragging');
    grid.classList.add('is-dragging');
    setActive(tile.index);
    try { navigator.vibrate?.(10); } catch { /* not allowed */ }
    opts.onMoveStart?.();
    track();
  };

  /** The place the pointer is over, from the grid's places (not where tiles are drawn while they glide). */
  const placeAt = (d) => {
    const g = grid.getBoundingClientRect();
    const x = d.x - g.left - grid.clientLeft + grid.scrollLeft;
    const y = d.y - g.top - grid.clientTop + grid.scrollTop;
    for (let k = 0; k < d.slots.length; k++) {
      const s = d.slots[k];
      if (x >= s.left && x < s.right && y >= s.top && y < s.bottom) return k;
    }
    return -1;
  };

  /** Draws the lifted page under the pointer, and moves it to the place it is held over. */
  const track = () => {
    const d = dragging;
    if (!d) return;
    const k = placeAt(d);
    if (k >= 0 && k !== d.tile.index) move(d.tile.index, k, { animate: true });
    const slot = slotOf(d.tile);
    d.tile.wrap.style.transform = `translate(${d.x - d.dx - slot.left}px, ${d.y - d.dy - slot.top}px)`;
  };

  const scroller = () => {
    const own = getComputedStyle(grid);
    if (/(auto|scroll)/.test(own.overflowY) && grid.scrollHeight > grid.clientHeight + 1) return grid;
    return findScroller(grid.parentElement) ?? document.scrollingElement;
  };

  const autoScroll = () => {
    if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      const d = dragging;
      if (!d) return;
      const s = scroller();
      const isDoc = s === document.scrollingElement;
      const top = isDoc ? 0 : s.getBoundingClientRect().top;
      const bottom = isDoc ? window.innerHeight : s.getBoundingClientRect().bottom;
      let speed = 0;
      if (d.y < top + EDGE) speed = -Math.ceil(((top + EDGE - d.y) / EDGE) * 14);
      else if (d.y > bottom - EDGE) speed = Math.ceil(((d.y - (bottom - EDGE)) / EDGE) * 14);
      if (!speed) return;
      const before = s.scrollTop;
      s.scrollTop += speed;
      if (s.scrollTop !== before) track();
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  };

  /** Puts the lifted page down; `tap`: it was a tap after all, so its click chooses the page. */
  const endDrag = (tap = false) => {
    const d = dragging;
    if (!d) return;
    dragging = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    removeWindowListeners();
    const wrap = d.tile.wrap;
    wrap.classList.remove('is-dragging');
    grid.classList.remove('is-dragging');
    // The page settles into its place.
    wrap.style.transform = '';
    if (!tap) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
    }
    const to = d.tile.index;
    opts.onMoveEnd?.(d.from, to);
    if (to !== d.from) announce(t('web_page_moved', to + 1, count));
    d.tile.button.focus({ preventScroll: true });
  };

  // -------------------------------------------------------------------------------------------

  build();

  // Only the pages named (a number, or a list or set of them), or all; each tile touches only what changed.
  grid.refresh = (indexes) => {
    if (indexes == null) {
      refreshRange(0, count - 1);
      return;
    }
    for (const i of typeof indexes === 'number' ? [indexes] : indexes) tiles[i]?.update();
  };
  grid.setCount = (n) => {
    count = Math.max(0, n | 0);
    build();
  };
  grid.setSelected = (set) => {
    selected = set ?? new Set();
    grid.refresh();
  };
  grid.reload = (i) => {
    const list = i == null ? tiles : [tiles[i]].filter(Boolean);
    for (const tile of list) {
      tile.unload();
      if (observer) { observer.unobserve(tile.wrap); observer.observe(tile.wrap); }
    }
  };
  grid.focusIndex = (i) => {
    if (!tiles[i]) return;
    setActive(i);
    tiles[i].button.focus();
  };
  grid.scrollToIndex = (i, { behavior } = {}) => {
    tiles[i]?.wrap.scrollIntoView({ block: 'nearest', behavior: behavior ?? (reducedMotion() ? 'auto' : 'smooth') });
  };
  grid.move = (from, to) => move(from, to, { say: false });
  grid.destroy = () => {
    destroyed = true;
    observer?.disconnect();
    sizeObserver?.disconnect();
    cancelAnimationFrame(sizeFrame);
    for (const tile of tiles) tile.unload();
    removeWindowListeners();
  };
  Object.defineProperty(grid, 'count', { get: () => count, configurable: true });
  return grid;
}
