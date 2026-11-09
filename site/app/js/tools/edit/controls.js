// Edit PDF's controls (EditPdfOptions.kt): the row of tools, the colours, the chosen item's
// controls (or the pen's while drawing), the row of pages and the text dialog.
import { h, announce } from '../../core/dom.js';
import { t, tWeb } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { iconButton, slider, switchRow, textField, button, bottomSheet, uid } from '../../core/ui.js';
import {
  EDIT_COLORS, PEN_WIDTHS, HIGHLIGHTER_WIDTHS, NUDGE, TEXT_MAX_LENGTH, ShapeKind,
  isBox, size as itemSize, sizeRange, resized, moved, onPage, copy, sameItem, describeKey, canDrawText,
} from '../../engine/edit.js';

/** What a screen reader calls `item`. */
export function describe(item) {
  const [key, arg] = describeKey(item);
  return arg != null ? t(key, arg) : t(key);
}

const formatPoints = (v) => t('web_edit_points', new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v));

// ---- The row of tools ----

/** The shapes, in the app's order, with their names and icons. */
export const SHAPES = [
  { kind: ShapeKind.RECTANGLE, filled: false, label: 'edit_item_rectangle', icon: 'crop_square' },
  { kind: ShapeKind.RECTANGLE, filled: true, label: 'edit_item_filled_rectangle', icon: 'square' },
  { kind: ShapeKind.ELLIPSE, filled: false, label: 'edit_item_ellipse', icon: 'panorama_fish_eye' },
  { kind: ShapeKind.LINE, filled: false, label: 'edit_item_line', icon: 'horizontal_rule' },
  { kind: ShapeKind.ARROW, filled: false, label: 'edit_item_arrow', icon: 'arrow_right_alt' },
];

/**
 * A tool: its icon in a pill that fills while it is on, over its name. `toggle` for a tool that
 * stays on (drawing): it is then a toggle button (aria-pressed).
 */
function toolButton({ iconName, label, toggle = false, onClick, menuButton = false }) {
  const b = h('button', {
    type: 'button',
    class: 'edit-tool',
    'aria-pressed': toggle ? 'false' : null,
    'aria-haspopup': menuButton ? 'menu' : null,
    'aria-expanded': menuButton ? 'false' : null,
    onClick,
  }, h('span', { class: 'edit-tool-pill', 'aria-hidden': 'true' }, icon(iconName, { size: 24 })), h('span', { class: 'edit-tool-label' }, label));
  b.setOn = (on) => {
    if (toggle) b.setAttribute('aria-pressed', String(!!on));
    b.classList.toggle('is-on', !!on);
  };
  return b;
}

/** Text, Draw, Highlight, Shape and Picture, each an icon over its name. */
export function toolbar({ onText, onMode, onShape, onPicture }) {
  const text = toolButton({ iconName: 'text_fields', label: t('edit_text'), onClick: () => onText() });
  const draw = toolButton({ iconName: 'gesture', label: t('edit_draw'), toggle: true, onClick: () => onMode('pen') });
  const highlight = toolButton({ iconName: 'border_color', label: t('edit_highlight'), toggle: true, onClick: () => onMode('highlighter') });
  const shape = toolButton({ iconName: 'category', label: t('edit_shape'), menuButton: true, onClick: () => onShape(shape) });
  const picture = toolButton({ iconName: 'add_photo_alternate', label: t('edit_picture'), onClick: () => onPicture() });
  const el = h('div', { class: 'edit-tools', role: 'toolbar', 'aria-label': t('web_edit_tools') }, text, draw, highlight, shape, picture);
  const all = [text, draw, highlight, shape, picture];
  // A toolbar is one stop for Tab; the arrow keys move along it.
  let at = 0;
  const focusAt = (i) => {
    at = (i + all.length) % all.length;
    all.forEach((b, j) => { b.tabIndex = j === at ? 0 : -1; });
    all[at].focus();
  };
  all.forEach((b, j) => {
    b.tabIndex = j === 0 ? 0 : -1;
    b.addEventListener('focus', () => {
      at = j;
      all.forEach((x, k) => { x.tabIndex = k === j ? 0 : -1; });
    });
  });
  el.addEventListener('keydown', (e) => {
    const rtl = getComputedStyle(el).direction === 'rtl';
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) { e.preventDefault(); e.stopPropagation(); focusAt(at + 1); }
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) { e.preventDefault(); e.stopPropagation(); focusAt(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(all.length - 1); }
  });
  // One word in a fifth of the screen: with a large font size, or a long word, it shrinks (to 8 px)
  // rather than being cut, as the app's labels do.
  const fit = () => {
    for (const b of all) {
      const label = b.querySelector('.edit-tool-label');
      label.style.fontSize = '';
      const style = getComputedStyle(b);
      // Fractional widths: an overflow of part of a pixel already ends the word in "…".
      const room = b.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const range = document.createRange();
      range.selectNodeContents(label);
      let size = parseFloat(getComputedStyle(label).fontSize) || 12;
      while (range.getBoundingClientRect().width > room - 0.5 && size > 8) {
        size = Math.max(8, size - 0.5);
        label.style.fontSize = size + 'px';
      }
    }
  };
  let fitWidth = -1;
  const fitter = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w !== fitWidth) {
      fitWidth = w;
      requestAnimationFrame(fit);
    }
  }) : null;
  fitter?.observe(el);
  el.destroy = () => fitter?.disconnect();
  el.update = ({ mode, enabled, importing }) => {
    for (const b of all) b.disabled = !enabled;
    picture.disabled = !enabled || importing;
    draw.setOn(mode === 'pen');
    highlight.setOn(mode === 'highlighter');
  };
  el.shapeButton = shape;
  el.pictureButton = picture;
  return el;
}

// ---- Colours ----

/** The colours, each a radio button named after its colour. Six fit across a phone. */
export function colorSwatches({ value, onSelect }) {
  const name = uid('edit-colors');
  const group = h('div', { class: 'edit-colors', role: 'radiogroup', 'aria-label': t('web_edit_color') });
  const buttons = EDIT_COLORS.map((c) => {
    const b = h('button', {
      type: 'button',
      role: 'radio',
      class: ['edit-swatch', `edit-swatch--${c.id}`],
      'aria-label': t(c.label),
      title: t(c.label),
      'aria-checked': 'false',
      dataset: { color: c.color, group: name },
      style: { '--swatch': c.color },
    }, h('span', { class: 'edit-swatch-dot', 'aria-hidden': 'true' }, icon('check', { size: 20 })));
    b.addEventListener('click', () => {
      set(c.color);
      onSelect(c.color);
    });
    return b;
  });
  group.append(...buttons);
  let current = null;
  const set = (color) => {
    // A colour that isn't one of the six shows as black, as the app does.
    const chosen = EDIT_COLORS.find((c) => c.color === String(color).toLowerCase()) ?? EDIT_COLORS[0];
    current = chosen.color;
    buttons.forEach((b, i) => {
      const on = EDIT_COLORS[i].color === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-checked', on);
    });
  };
  group.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    e.stopPropagation();
    const rtl = getComputedStyle(group).direction === 'rtl';
    let step = keys[e.key];
    if (rtl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step = -step;
    const at = EDIT_COLORS.findIndex((c) => c.color === current);
    const next = EDIT_COLORS[(at + step + EDIT_COLORS.length) % EDIT_COLORS.length];
    set(next.color);
    buttons[EDIT_COLORS.indexOf(next)].focus();
    onSelect(next.color);
  });
  set(value);
  group.setValue = set;
  return group;
}

// ---- A slider that is one change for Undo ----

/**
 * A slider whose drag (or each step with the keys) is one change: onBegin() before the first
 * value, onValue(v) for each, onEnd(last) once let go, with the last value onValue had (or null).
 */
function changeSlider({ label, range, value, step, onBegin, onValue, onEnd }) {
  let moving = false;
  let last = null;
  const s = slider({
    label,
    min: range.min,
    max: range.max > range.min ? range.max : range.min + 1,
    step,
    value,
    format: formatPoints,
    onChange: (v) => {
      if (!moving) {
        moving = true;
        onBegin();
      }
      last = v;
      onValue(v);
    },
    onCommit: () => finish(),
  });
  s.classList.add('edit-slider');
  const finish = () => {
    if (!moving) return;
    moving = false;
    const v = last;
    last = null;
    onEnd(v);
  };
  // Let go of without a change event (the pointer left the window, say): the change ends there.
  s.input.addEventListener('pointerup', () => setTimeout(finish, 0));
  s.input.addEventListener('blur', finish);
  // A range of one value has nothing to choose.
  s.setRange = (r, v) => {
    s.input.min = String(r.min);
    s.input.max = String(r.max > r.min ? r.max : r.min + 1);
    s.setDisabled(!(r.max > r.min));
    if (!moving) s.setValue(Math.min(Math.max(v, r.min), r.max));
  };
  s.setRange(range, value);
  s.finish = finish;
  Object.defineProperty(s, 'moving', { get: () => moving });
  return s;
}

// ---- The chosen item's controls, or the pen's ----

/**
 * The chosen item's controls: what it is (said by a screen reader as it is chosen), delete, change
 * the text, move it a step at a time, its size, line width, fill and colour. While drawing, the
 * pen's or highlighter's line width and colour.
 * @param {{
 *   onChange(item): void, onMove(dx, dy): void, onBegin(): void, onStep(item): void, onEnd(): void,
 *   onDelete(): void, onEditText(): void, onStyle(style): void,
 * }} hooks
 */
export function properties(hooks) {
  const el = h('div', { class: 'edit-props' });
  const itemBox = h('div', { class: 'edit-props-item' });
  const penBox = h('div', { class: 'edit-props-pen' });
  el.append(itemBox, penBox);
  itemBox.hidden = true;
  penBox.hidden = true;

  let built = null;        // what the item's controls were made for: { id, shape }
  let penBuilt = null;
  let parts = null;
  let pen = null;
  // Kept current by update(): the controls read them when used.
  let state = { item: null, mode: 'select', style: null, pageWidth: 595, pageHeight: 842 };
  // The controls change nothing once their item is no longer chosen (it went, or another page shows).
  const ifChosen = (fn) => { if (state.item) fn(state.item); };

  /** What decides which controls an item gets. */
  const shapeOf = (item) => `${item.type}:${isBox(item)}:${item.type === 'shape' && item.filled}:${item.type === 'ink' && item.highlighter}`;

  const lineWidthOf = (item) => {
    if (item.type === 'ink') return item.width;
    if (item.type === 'shape') return isBox(item) && item.filled ? null : item.width;
    return null;
  };
  const colorOf = (item) => (item.type === 'picture' ? null : item.color);

  const buildItem = (item) => {
    const title = h('p', { class: 'edit-props-title' });
    const editBtn = item.type === 'text' ? iconButton({ icon: 'edit', label: t('edit_text_change'), onClick: () => ifChosen(() => hooks.onEditText()) }) : null;
    const deleteBtn = iconButton({ icon: 'delete', label: t('edit_delete'), onClick: () => ifChosen(() => hooks.onDelete()) });
    const head = h('div', { class: 'edit-props-head' }, title, editBtn, deleteBtn);
    const nudges = [
      ['west', 'edit_move_left', -1, 0],
      ['north', 'edit_move_up', 0, -1],
      ['south', 'edit_move_down', 0, 1],
      ['east', 'edit_move_right', 1, 0],
    ].map(([name, label, dx, dy]) => {
      const b = iconButton({
        icon: name,
        label: t(label),
        onClick: () => ifChosen(() => {
          const step = NUDGE * Math.min(state.pageWidth, state.pageHeight);
          hooks.onMove(dx * step, dy * step);
        }),
      });
      b.dataset.dx = String(dx);
      b.dataset.dy = String(dy);
      return b;
    });
    const nudgeRow = h('div', { class: 'edit-nudges' }, ...nudges);
    const range = sizeRange(item, state.pageWidth, state.pageHeight);
    const sizeSlider = changeSlider({
      label: t('sign_size'),
      range,
      value: itemSize(item),
      step: item.type === 'text' ? 0.5 : 1,
      onBegin: () => hooks.onBegin(),
      onValue: (v) => ifChosen((it) => hooks.onStep(resized(it, v, state.pageWidth, state.pageHeight))),
      onEnd: (v) => {
        hooks.onEnd();
        ifChosen((it) => { if (it.type === 'text') hooks.onStyle({ ...state.style, textSize: v ?? it.size }); });
      },
    });
    let widthSlider = null;
    const lw = lineWidthOf(item);
    if (lw != null) {
      const highlighter = item.type === 'ink' && item.highlighter;
      widthSlider = changeSlider({
        label: t('edit_thickness'),
        range: highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS,
        value: lw,
        step: 0.5,
        onBegin: () => hooks.onBegin(),
        onValue: (v) => ifChosen((it) => hooks.onStep(onPage(copy(it, { width: v }), state.pageWidth, state.pageHeight))),
        onEnd: (v) => {
          hooks.onEnd();
          ifChosen((it) => {
            const chosen = v ?? lineWidthOf(it);
            if (it.type === 'shape') hooks.onStyle({ ...state.style, shapeWidth: chosen });
            else if (it.highlighter) hooks.onStyle({ ...state.style, highlighterWidth: chosen });
            else hooks.onStyle({ ...state.style, penWidth: chosen });
          });
        },
      });
    }
    let fill = null;
    if (isBox(item)) {
      fill = switchRow({
        label: t('edit_fill'),
        checked: item.filled,
        onChange: (b) => ifChosen((it) => hooks.onChange(copy(it, { filled: b }))),
      });
      fill.classList.add('edit-fill');
    }
    let colors = null;
    if (colorOf(item) != null) {
      colors = colorSwatches({
        value: colorOf(item),
        onSelect: (color) => ifChosen((it) => {
          hooks.onChange(copy(it, { color }));
          if (it.type === 'text') hooks.onStyle({ ...state.style, textColor: color });
          else if (it.type === 'ink') hooks.onStyle(it.highlighter ? { ...state.style, highlighterColor: color } : { ...state.style, penColor: color });
          else hooks.onStyle({ ...state.style, shapeColor: color });
        }),
      });
    }
    itemBox.replaceChildren(...[head, nudgeRow, sizeSlider, widthSlider, fill, colors].filter(Boolean));
    return { title, nudges, sizeSlider, widthSlider, fill, colors };
  };

  const buildPen = (highlighter) => {
    const width = changeSlider({
      label: t('edit_thickness'),
      range: highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS,
      value: highlighter ? state.style.highlighterWidth : state.style.penWidth,
      step: 0.5,
      onBegin: () => {},
      onValue: (v) => hooks.onStyle(state.mode === 'highlighter' ? { ...state.style, highlighterWidth: v } : { ...state.style, penWidth: v }),
      onEnd: () => {},
    });
    const colors = colorSwatches({
      value: highlighter ? state.style.highlighterColor : state.style.penColor,
      onSelect: (color) => hooks.onStyle(state.mode === 'highlighter' ? { ...state.style, highlighterColor: color } : { ...state.style, penColor: color }),
    });
    penBox.replaceChildren(width, colors);
    return { width, colors };
  };

  /** Shows the controls for `item` (chosen, or null), or the pen's while drawing. */
  el.update = (next) => {
    const was = state.item;
    state = { ...state, ...next };
    const item = state.item;
    if (item && state.mode === 'select') {
      const shape = shapeOf(item);
      if (!built || built.id !== item.id || built.shape !== shape) {
        parts?.sizeSlider.finish();
        parts?.widthSlider?.finish();
        parts = buildItem(item);
        built = { id: item.id, shape };
      }
      const label = describe(item);
      parts.title.textContent = label;
      // A screen reader says it is chosen as soon as it is.
      if (!was || was.id !== item.id) announce(t('edit_selected', label));
      for (const b of parts.nudges) {
        const dx = Number(b.dataset.dx);
        const dy = Number(b.dataset.dy);
        const step = NUDGE * Math.min(state.pageWidth, state.pageHeight);
        // Off once the item is against that edge of the page.
        b.disabled = sameItem(moved(item, dx * step, dy * step, state.pageWidth, state.pageHeight), item);
      }
      parts.sizeSlider.setRange(sizeRange(item, state.pageWidth, state.pageHeight), itemSize(item));
      const lw = lineWidthOf(item);
      if (parts.widthSlider && lw != null && !parts.widthSlider.moving) parts.widthSlider.setValue(lw);
      parts.fill?.setChecked(item.filled);
      if (parts.colors) parts.colors.setValue(colorOf(item));
      itemBox.hidden = false;
    } else {
      if (parts) {
        parts.sizeSlider.finish();
        parts.widthSlider?.finish();
      }
      parts = null;
      built = null;
      itemBox.hidden = true;
      itemBox.replaceChildren();
    }
    const drawing = !item && state.mode !== 'select';
    if (drawing) {
      const highlighter = state.mode === 'highlighter';
      if (penBuilt !== state.mode) {
        pen = buildPen(highlighter);
        penBuilt = state.mode;
      } else if (!pen.width.moving) {
        pen.width.setValue(highlighter ? state.style.highlighterWidth : state.style.penWidth);
      }
      pen.colors.setValue(highlighter ? state.style.highlighterColor : state.style.penColor);
      penBox.hidden = false;
    } else {
      penBox.hidden = true;
      penBox.replaceChildren();
      penBuilt = null;
      pen = null;
    }
    el.hidden = itemBox.hidden && penBox.hidden;
  };
  el.hidden = true;
  return el;
}

// ---- The row of pages ----

/**
 * The PDF's pages in a row (SignOptions.kt PageStrip): each a radio button with its preview and
 * number, those with something added marked. Previews are drawn as they come into view.
 */
export function pageStrip({ count, thumbnail, onSelect }) {
  const list = h('div', { class: 'edit-strip', role: 'radiogroup', 'aria-label': t('web_edit_pages') });
  const editedId = uid('edit-edited');
  const editedNote = h('span', { class: 'visually-hidden', id: editedId }, t('edit_page_edited'));
  const tiles = [];
  let selected = 0;
  let marked = new Set();
  const controllers = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.index);
      const tile = tiles[i];
      if (e.isIntersecting && !tile.drawn && !controllers.has(i)) {
        const controller = new AbortController();
        controllers.set(i, controller);
        thumbnail(i, 72, { signal: controller.signal, maxCssHeight: 92 }).then((canvas) => {
          tile.thumb.replaceChildren(canvas);
          tile.drawn = true;
        }, () => {}).finally(() => controllers.delete(i));
      } else if (!e.isIntersecting && controllers.has(i)) {
        controllers.get(i).abort();
        controllers.delete(i);
      }
    }
  }, { root: null, rootMargin: '300px' });
  for (let i = 0; i < count; i++) {
    const thumb = h('span', { class: 'edit-strip-thumb', 'aria-hidden': 'true' });
    const number = h('span', { class: 'edit-strip-number', 'aria-hidden': 'true' }, String(i + 1));
    const dot = h('span', { class: 'edit-strip-dot', 'aria-hidden': 'true' });
    const b = h('button', {
      type: 'button', role: 'radio', class: 'edit-strip-page', 'aria-checked': 'false',
      'aria-label': t('pdf_page_number', i + 1), tabindex: '-1', dataset: { index: i },
      onClick: () => onSelect(i),
    }, thumb, h('span', { class: 'edit-strip-label' }, number, dot));
    tiles.push({ el: b, thumb, drawn: false });
    list.append(b);
    observer.observe(b);
  }
  list.append(editedNote);
  list.addEventListener('keydown', (e) => {
    const vertical = list.classList.contains('is-vertical') || getComputedStyle(list).flexDirection === 'column';
    const rtl = getComputedStyle(list).direction === 'rtl';
    const next = { ArrowDown: vertical ? 1 : 0, ArrowUp: vertical ? -1 : 0, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, Home: 'first', End: 'last' }[e.key];
    if (next == null || next === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = next === 'first' ? 0 : next === 'last' ? count - 1 : Math.min(count - 1, Math.max(0, selected + next));
    onSelect(target);
    tiles[target].el.focus();
  });
  let shown = '';
  list.update = (index, edited) => {
    // Only when the page or the edited pages changed: this runs at each step of a drag.
    const key = `${index}:${[...edited].sort((a, b) => a - b).join(',')}`;
    if (key === shown) return;
    shown = key;
    selected = index;
    marked = edited;
    tiles.forEach((tile, i) => {
      const on = i === index;
      tile.el.setAttribute('aria-checked', String(on));
      tile.el.tabIndex = on ? 0 : -1;
      tile.el.classList.toggle('is-selected', on);
      const isMarked = marked.has(i);
      tile.el.classList.toggle('is-marked', isMarked);
      if (isMarked) tile.el.setAttribute('aria-describedby', editedId);
      else tile.el.removeAttribute('aria-describedby');
    });
  };
  list.reveal = (index) => {
    const tile = tiles[index]?.el;
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) {
      tile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  list.destroy = () => {
    observer.disconnect();
    for (const c of controllers.values()) c.abort();
    controllers.clear();
  };
  return list;
}

// ---- The text dialog ----

/**
 * Asks for the text to add, or the new text of a text already on the page (EditTextDialog): Done
 * is off while the text is blank or has characters no font can draw (said under the field).
 * Returns a promise of the text, trimmed, or null when cancelled; its close() cancels it.
 */
export function textDialog({ initial = '', title }) {
  let close = () => {};
  const result = new Promise((resolve) => {
    let answered = false;
    const done = button({ label: t('sign_done'), variant: 'text', onClick: () => finish(field.value.trim()) });
    const cancel = button({ label: t('cancel'), variant: 'text', onClick: () => finish(null) });
    const field = textField({
      label: t('edit_text'),
      value: initial.slice(0, TEXT_MAX_LENGTH),
      multiline: true,
      rows: 3,
      maxLength: TEXT_MAX_LENGTH,
      onInput: () => check(),
    });
    field.input.setAttribute('autocapitalize', 'sentences');
    field.classList.add('edit-text-field');
    const check = () => {
      const drawable = canDrawText(field.value);
      // Shown here: a message under the dialog would be hidden by it and by the keyboard.
      field.setError(drawable ? null : tWeb('watermark_no_font'));
      done.disabled = !field.value.trim() || !drawable;
    };
    const sheet = bottomSheet({
      title,
      content: field,
      actions: [cancel, done],
      cls: 'edit-text-sheet',
      onClose: () => finish(null),
    });
    // Ctrl+Enter is Done, as a multi-line field keeps Enter for new lines.
    field.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !done.disabled) {
        e.preventDefault();
        finish(field.value.trim());
      }
    });
    function finish(value) {
      // Done tapped again before the dialog has gone adds or changes nothing more.
      if (answered) return;
      answered = true;
      sheet.close();
      // Once it has gone and given the focus back, so what follows can move the focus on.
      sheet.closed.then(() => resolve(value));
    }
    check();
    requestAnimationFrame(() => {
      field.input.focus();
      const end = field.input.value.length;
      field.input.setSelectionRange?.(end, end);
    });
    close = () => finish(null);
  });
  result.close = () => close();
  return result;
}
