// The pages in a row to choose from (the app's PageStrip in SignOptions.kt): each a radio button
// named after its number, with a picture of the page, and a dot under the number of the pages
// that have boxes ("Has boxes" for a screen reader). A row that scrolls sideways on phones; on wide
// screens the pages wrap, in a box that scrolls. Pictures are drawn only for the pages near the
// ones in view, and let go once far away, so a long PDF stays light.
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';

/** A page's picture fits this box, in CSS pixels (the app's 72 dp card, 92 dp tall). */
const THUMB_WIDTH = 70;
const THUMB_HEIGHT = 92;

/**
 * @param {object} o
 * @param {object} o.source        the PdfSource (its thumbnail(index, cssWidth, { maxCssHeight, signal }))
 * @param {number} o.count         pages
 * @param {number} o.selected      the page chosen
 * @param {string} o.labelledBy    the id of the strip's heading
 * @param {string} o.markedId      the id of an element saying "Has boxes"
 * @param {(index: number) => void} o.onSelect
 * @returns {HTMLElement} el.setSelected(index, { scroll }), el.setMarked(Set), el.destroy()
 */
export function pageStrip({ source, count, selected = 0, labelledBy, markedId, onSelect }) {
  const el = h('div', { class: 'redact-strip', role: 'radiogroup', 'aria-labelledby': labelledBy });
  const items = [];
  let current = selected;
  let marked = new Set();
  let destroyed = false;

  for (let i = 0; i < count; i++) {
    const thumb = h('span', { class: 'redact-strip-thumb', 'aria-hidden': 'true' });
    const dot = h('span', { class: 'redact-strip-dot', hidden: true });
    const b = h('button', {
      type: 'button',
      role: 'radio',
      class: 'redact-strip-page',
      'aria-label': t('pdf_page_number', i + 1),
      'aria-checked': 'false',
      tabindex: '-1',
      dataset: { index: i },
    }, thumb, h('span', { class: 'redact-strip-num', 'aria-hidden': 'true' }, h('span', {}, String(i + 1)), dot));
    b.addEventListener('click', () => choose(i, false));
    items.push({ b, thumb, dot, loading: null, picture: null });
    el.append(b);
  }

  function choose(i, focus) {
    if (i < 0 || i >= count) return;
    if (focus) items[i].b.focus({ preventScroll: true });
    if (i !== current) onSelect(i);
    scrollTo(i);
  }

  el.addEventListener('keydown', (e) => {
    const at = items.findIndex((it) => it.b === document.activeElement);
    if (at < 0) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    let next = null;
    if (e.key === 'ArrowRight') next = at + (rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft') next = at + (rtl ? 1 : -1);
    else if (e.key === 'ArrowDown') next = at + 1;
    else if (e.key === 'ArrowUp') next = at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    choose(Math.max(0, Math.min(count - 1, next)), true);
  });

  /** Scrolls the strip, and only the strip, so page `i` is in view. */
  function scrollTo(i) {
    const b = items[i]?.b;
    if (!b || !el.clientWidth) return;
    if (getComputedStyle(el).direction === 'rtl') {
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    const pad = 8;
    if (el.scrollWidth > el.clientWidth + 1) {
      if (b.offsetLeft < el.scrollLeft + pad) el.scrollLeft = b.offsetLeft - pad;
      else if (b.offsetLeft + b.offsetWidth > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = b.offsetLeft + b.offsetWidth - el.clientWidth + pad;
    }
    if (el.scrollHeight > el.clientHeight + 1) {
      if (b.offsetTop < el.scrollTop + pad) el.scrollTop = b.offsetTop - pad;
      else if (b.offsetTop + b.offsetHeight > el.scrollTop + el.clientHeight - pad) el.scrollTop = b.offsetTop + b.offsetHeight - el.clientHeight + pad;
    }
  }

  function render() {
    items.forEach((it, i) => {
      const on = i === current;
      it.b.setAttribute('aria-checked', String(on));
      it.b.tabIndex = on ? 0 : -1;
      const has = marked.has(i);
      it.dot.hidden = !has;
      if (has && markedId) it.b.setAttribute('aria-describedby', markedId);
      else it.b.removeAttribute('aria-describedby');
    });
  }

  // ---- Pictures, near the pages in view ----

  function load(it, i) {
    if (it.picture || it.loading || destroyed) return;
    const controller = new AbortController();
    it.loading = controller;
    source.thumbnail(i, THUMB_WIDTH, { maxCssHeight: THUMB_HEIGHT, signal: controller.signal }).then((canvas) => {
      if (it.loading !== controller) return;
      it.loading = null;
      if (destroyed) return;
      canvas.classList.add('ui-fade-in');
      it.picture = canvas;
      it.thumb.append(canvas);
    }, () => {
      if (it.loading === controller) it.loading = null;
    });
  }

  function unload(it) {
    it.loading?.abort();
    it.loading = null;
    if (it.picture) {
      it.picture.width = 0;
      it.picture.height = 0;
      it.picture.remove();
      it.picture = null;
    }
  }

  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const i = Number(entry.target.dataset.index);
      const it = items[i];
      if (!it) continue;
      if (entry.isIntersecting) load(it, i);
      else unload(it);
    }
  }, { root: el, rootMargin: '400px' }) : null;
  if (observer) items.forEach((it) => observer.observe(it.b));
  else items.slice(0, 50).forEach((it, i) => load(it, i));

  render();
  // As the app's row, it starts with the page before the chosen one at its start.
  requestAnimationFrame(() => scrollTo(Math.max(0, current - 1)));

  el.setSelected = (i, { scroll = true } = {}) => {
    current = i;
    render();
    if (scroll) scrollTo(i);
  };
  el.setMarked = (set) => {
    marked = set;
    render();
  };
  el.destroy = () => {
    destroyed = true;
    observer?.disconnect();
    items.forEach(unload);
  };
  return el;
}
