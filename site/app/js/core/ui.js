// The app's Material 3 components, as the Android app draws them (ui/Options.kt, SegmentLabel.kt and
// the screens' use of Compose Material 3). Every component is built from real elements with their
// roles, works with a keyboard and a screen reader, and takes text already translated.
import { h, clear, ensureCss, announce } from './dom.js';
import { t, tp } from './i18n.js';
import { icon } from './icons.js';
import { toFileItems, fileKind, kindOfName, kindOfType, ACCEPT } from './files.js';

ensureCss(new URL('../../css/components.css', import.meta.url));

let seq = 0;
/** A unique id for labelling one element by another. */
export function uid(prefix = 'ui') {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** h() with the attributes that are null, undefined or false left out. */
function el(tag, attrs, ...children) {
  const clean = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false) clean[k] = v === true ? '' : v;
  return h(tag, clean, ...children);
}

function on(target, type, fn, options) {
  if (fn) target.addEventListener(type, fn, options);
}

const isRtl = (node) => getComputedStyle(node).direction === 'rtl';

// ---------------------------------------------------------------------------------------------
// Text that shrinks to fit (SegmentLabel, BarTitle): one line, smaller until it fits, then "…".

const fitting = new Map();
let fitObserver = null;

function fitText(node, min) {
  const fit = () => {
    if (!node.isConnected) return;
    node.style.fontSize = '';
    let size = parseFloat(getComputedStyle(node).fontSize) || 14;
    let guard = 40;
    while (node.scrollWidth > node.clientWidth + 0.5 && size > min && guard-- > 0) {
      size = Math.max(min, size - 0.5);
      node.style.fontSize = size + 'px';
    }
  };
  fitting.set(node, { fit, width: -1 });
  if (typeof ResizeObserver === 'undefined') return fit;
  fitObserver ??= new ResizeObserver((entries) => {
    // Refitted after this delivery, so the font change can't loop back into the observer.
    const due = [];
    for (const e of entries) {
      const f = fitting.get(e.target);
      if (!f) continue;
      const w = Math.round(e.contentRect.width);
      if (w !== f.width) {
        f.width = w;
        due.push(f.fit);
      }
    }
    if (due.length) requestAnimationFrame(() => due.forEach((fn) => fn()));
  });
  fitObserver.observe(node);
  return fit;
}

// ---------------------------------------------------------------------------------------------
// Buttons

/**
 * A Material 3 button: 'filled' (the main action), 'tonal', 'outlined' or 'text'.
 * Extra options: tone 'danger' (error colour, for destructive text buttons), cls (more classes).
 * Returns the <button>; el.setLabel(text) changes its label.
 */
export function button({ label, icon: name, variant = 'filled', onClick, disabled, type = 'button', tone, cls, ariaLabel } = {}) {
  const b = el('button', {
    type,
    class: ['ui-btn', `ui-btn--${variant}`, tone === 'danger' ? 'ui-btn--danger' : '', cls ?? ''].filter(Boolean).join(' '),
    'aria-label': ariaLabel,
  });
  if (name) b.append(icon(name, { size: 18 }));
  const text = el('span', { class: 'ui-btn-label' }, label ?? '');
  b.append(text);
  b.disabled = !!disabled;
  on(b, 'click', onClick);
  b.setLabel = (s) => { text.textContent = s; };
  return b;
}

/**
 * A 48 px icon button, named for screen readers by `label` (also its tooltip). With `selected`
 * (true/false) it is a toggle button; el.setSelected(b) changes it. variant 'standard' | 'tonal' | 'filled'.
 */
export function iconButton({ icon: name, label, onClick, disabled, selected, variant = 'standard', cls } = {}) {
  const b = el('button', {
    type: 'button',
    class: ['ui-icon-btn', variant !== 'standard' ? `ui-icon-btn--${variant}` : '', cls ?? ''].filter(Boolean).join(' '),
    'aria-label': label,
    title: label,
  }, icon(name, { size: 24 }));
  b.disabled = !!disabled;
  b.setSelected = (s) => {
    b.setAttribute('aria-pressed', String(!!s));
    b.classList.toggle('is-selected', !!s);
  };
  if (selected != null) b.setSelected(selected);
  b.setLabel = (s) => { b.setAttribute('aria-label', s); b.title = s; };
  on(b, 'click', onClick);
  return b;
}

/** An extended floating action button: icon and label, for a screen's main action. */
export function fab({ label, icon: name, onClick, disabled, cls } = {}) {
  const b = el('button', { type: 'button', class: 'ui-fab' + (cls ? ' ' + cls : '') });
  if (name) b.append(icon(name, { size: 24 }));
  const text = el('span', { class: 'ui-fab-label' }, label ?? '');
  b.append(text);
  b.disabled = !!disabled;
  b.setLabel = (s) => { text.textContent = s; };
  on(b, 'click', onClick);
  return b;
}

/**
 * The bar at the bottom of a tool screen holding its main button, full width on phones and kept
 * clear of the phone's gesture bar, as the app's bottomBar.
 */
export function bottomBar(...children) {
  return el('div', { class: 'ui-bottombar' }, ...children);
}

// ---------------------------------------------------------------------------------------------
// Top app bar

/**
 * The top app bar: back arrow (onBack; named backLabel, by default "Back"), a one-line title that
 * shrinks a little and then ends in "…", an optional subtitle, actions and an overflow menu. An
 * action with an icon is an icon button named by its label; one with a label and no icon is a
 * text button (Recent files' "Clear list"). It takes a tint once the page scrolls under it, as the
 * app's pinned bar. Returns the <header>; el.setTitle(text), el.setSubtitle(text|null), el.actions
 * (the buttons, in order).
 */
export function topBar({ title, subtitle, onBack, backLabel, actions = [], menu: items, backDisabled } = {}) {
  const bar = el('header', { class: 'ui-topbar' });
  let back = null;
  if (onBack) {
    back = iconButton({ icon: 'arrow_back', label: backLabel ?? t('back'), onClick: onBack, cls: 'ui-topbar-nav', disabled: backDisabled });
    bar.append(back);
  }
  const heading = el('h1', { class: 'ui-topbar-title' }, title ?? '');
  const sub = el('p', { class: 'ui-topbar-subtitle' }, subtitle ?? '');
  sub.hidden = !subtitle;
  const titles = el('div', { class: 'ui-topbar-titles' }, heading, sub);
  bar.append(titles);
  const fit = fitText(heading, 16);
  const buttons = actions.map((a) => (a.icon || !a.label
    ? iconButton({ icon: a.icon, label: a.label, onClick: a.onClick, disabled: a.disabled, selected: a.selected })
    : button({ label: a.label, variant: 'text', onClick: a.onClick, disabled: a.disabled, cls: 'ui-topbar-text' })));
  const tail = el('div', { class: 'ui-topbar-actions' }, ...buttons);
  if (items?.length) {
    const more = iconButton({ icon: 'more_vert', label: t('web_more_options') });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => menu(more, typeof items === 'function' ? items() : items));
    tail.append(more);
  }
  bar.append(tail);
  bar.setTitle = (s) => { heading.textContent = s; fit(); };
  bar.setSubtitle = (s) => { sub.textContent = s ?? ''; sub.hidden = !s; };
  bar.actions = buttons;
  bar.back = back;

  // Tinted while whatever scrolls it (an ancestor, or the page) is scrolled down.
  const onScroll = (e) => {
    if (!bar.isConnected) {
      document.removeEventListener('scroll', onScroll, true);
      return;
    }
    const target = e.target === document ? document.scrollingElement : e.target;
    if (target && target.contains?.(bar)) bar.classList.toggle('is-scrolled', target.scrollTop > 0);
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // A bar put on a page already scrolled starts tinted.
  requestAnimationFrame(() => {
    for (let n = bar.parentElement; n; n = n.parentElement) {
      if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) { bar.classList.add('is-scrolled'); return; }
    }
    if ((document.scrollingElement?.scrollTop ?? 0) > 0) bar.classList.add('is-scrolled');
  });
  return bar;
}

// ---------------------------------------------------------------------------------------------
// Choosing one of several: segmented buttons, filter chips (radio groups), and dropdown chips.

/** Wires up a radio group of buttons: roving focus, arrow keys choose (as radio buttons do). */
function radioGroup(group, options, buttons, value, onChange) {
  let current = value;
  const enabled = () => buttons.filter((b) => !b.disabled);
  const render = () => {
    const anyChecked = options.some((o) => o.value === current);
    buttons.forEach((b, i) => {
      const checked = options[i].value === current;
      b.setAttribute('aria-checked', String(checked));
      b.classList.toggle('is-selected', checked);
      b.tabIndex = checked || (!anyChecked && b === enabled()[0]) ? 0 : -1;
    });
  };
  const choose = (i, notify) => {
    const v = options[i].value;
    const changed = v !== current;
    current = v;
    render();
    if (notify && changed) onChange?.(v);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => choose(i, true));
    b.addEventListener('keydown', (e) => {
      const list = enabled();
      const at = list.indexOf(b);
      if (at < 0) return;
      const rtl = isRtl(group);
      let next = null;
      if (e.key === 'ArrowRight') next = at + (rtl ? -1 : 1);
      else if (e.key === 'ArrowLeft') next = at + (rtl ? 1 : -1);
      else if (e.key === 'ArrowDown') next = at + 1;
      else if (e.key === 'ArrowUp') next = at - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      else return;
      e.preventDefault();
      next = (next + list.length) % list.length;
      const target = list[next];
      target.focus();
      choose(buttons.indexOf(target), true);
    });
  });
  render();
  group.setValue = (v) => { current = v; render(); };
  Object.defineProperty(group, 'value', { get: () => current, configurable: true });
  group.setDisabled = (v, d) => {
    // setDisabled(true) turns off the whole group; setDisabled(value, true) one option.
    if (d === undefined) buttons.forEach((b) => { b.disabled = !!v; });
    else { const i = options.findIndex((o) => o.value === v); if (i >= 0) buttons[i].disabled = !!d; }
    render();
  };
}

/**
 * Segmented buttons: options share the row's width, the chosen one filled. As in the app there is
 * no check mark, and a label too long for its segment shrinks to fit (down to 8 px) before it ends
 * in "…". A radio group: arrow keys choose. el.setValue(v), el.value.
 * @param {{ options: { value: any, label: string, icon?: string, disabled?: boolean }[], value: any, onChange?: (v: any) => void, label?: string }} o
 */
export function segmented({ options, value, onChange, label, labelledBy } = {}) {
  const group = el('div', { class: 'ui-segmented', role: 'radiogroup', 'aria-label': label, 'aria-labelledby': labelledBy });
  group.style.setProperty('--segments', String(options.length));
  const buttons = options.map((o) => {
    const text = el('span', { class: 'ui-segment-label' }, o.label);
    const b = el('button', { type: 'button', role: 'radio', class: 'ui-segment' }, o.icon ? icon(o.icon, { size: 18 }) : null, text);
    b.disabled = !!o.disabled;
    fitText(text, 8);
    return b;
  });
  group.append(...buttons);
  radioGroup(group, options, buttons, value, onChange);
  return group;
}

/**
 * Single-choice filter chips: the chosen one is filled and shows a check mark. They wrap onto
 * more lines when they don't fit. A radio group: arrow keys choose. el.setValue(v), el.value.
 */
export function chips({ options, value, onChange, label, labelledBy } = {}) {
  const group = el('div', { class: 'ui-chips', role: 'radiogroup', 'aria-label': label, 'aria-labelledby': labelledBy });
  const buttons = options.map((o) => {
    const b = el('button', { type: 'button', role: 'radio', class: 'ui-chip ui-chip--filter' },
      el('span', { class: 'ui-chip-check', 'aria-hidden': 'true' }, icon('check', { size: 18 })),
      o.icon ? icon(o.icon, { size: 18 }) : null,
      el('span', { class: 'ui-chip-label' }, o.label));
    b.disabled = !!o.disabled;
    return b;
  });
  group.append(...buttons);
  radioGroup(group, options, buttons, value, onChange);
  return group;
}

/**
 * A chip showing "Label: Value" with a ▾ that opens a menu of the options (Options.kt OptionChip):
 * the chosen one has a check mark and is announced as checked. An option's `short` text, when it
 * has one, is what the chip shows ("Fit" for "Fit (same as image)").
 * el.setValue(v); el.setDisabled(disabled, shownText?) turns it off, showing shownText as its value
 * meanwhile (the orientation chip says "Same as image" while the page size is Fit).
 */
export function dropdown({ label, options, value, onChange, disabled } = {}) {
  let current = value;
  let note = null;
  const text = el('span', { class: 'ui-chip-label' });
  const chip = el('button', { type: 'button', class: 'ui-chip ui-chip--assist ui-dropdown', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    text, el('span', { class: 'ui-chip-trailing', 'aria-hidden': 'true' }, icon('arrow_drop_down', { size: 18 })));
  const render = () => {
    const o = options.find((x) => x.value === current);
    text.textContent = t('option_value', label, note ?? (o ? (o.short ?? o.label) : ''));
  };
  chip.addEventListener('click', () => {
    menu(chip, options.map((o) => ({
      label: o.label,
      icon: o.icon,
      checked: o.value === current,
      disabled: o.disabled,
      onClick: () => {
        const changed = o.value !== current;
        current = o.value;
        render();
        if (changed) onChange?.(o.value);
      },
    })), { radio: true });
  });
  chip.disabled = !!disabled;
  render();
  chip.setValue = (v) => { current = v; render(); };
  chip.setDisabled = (d, shown = null) => { chip.disabled = !!d; note = d ? shown : null; render(); };
  Object.defineProperty(chip, 'value', { get: () => current, configurable: true });
  return chip;
}

// ---------------------------------------------------------------------------------------------
// Switches, sliders and text fields

/**
 * A row with a label (and a detail line under it) and a switch at its end; tapping anywhere on the
 * row flips it. The switch is role=switch, named by the label and described by the detail.
 * el.setChecked(b), el.setDisabled(b), el.checked, el.switch (the button).
 */
export function switchRow({ label, detail, checked, onChange, disabled } = {}) {
  const id = uid('switch');
  const sw = el('button', {
    type: 'button', role: 'switch', class: 'ui-switch',
    'aria-labelledby': id + '-label', 'aria-describedby': detail ? id + '-detail' : null,
  }, el('span', { class: 'ui-switch-thumb' }, icon('check', { size: 16 })));
  const labelEl = el('span', { class: 'ui-switch-label', id: id + '-label' }, label);
  const detailEl = detail ? el('span', { class: 'ui-switch-detail', id: id + '-detail' }, detail) : null;
  const row = el('div', { class: 'ui-switch-row' }, el('div', { class: 'ui-switch-text' }, labelEl, detailEl), sw);
  let state = !!checked;
  const render = () => {
    sw.setAttribute('aria-checked', String(state));
    row.classList.toggle('is-checked', state);
  };
  row.addEventListener('click', () => {
    if (sw.disabled) return;
    state = !state;
    render();
    // The switch keeps the focus, so a keyboard user can flip it again.
    if (document.activeElement !== sw) sw.focus({ preventScroll: true });
    onChange?.(state);
  });
  sw.disabled = !!disabled;
  row.classList.toggle('is-disabled', !!disabled);
  render();
  row.setChecked = (b) => { state = !!b; render(); };
  row.setDisabled = (b) => { sw.disabled = !!b; row.classList.toggle('is-disabled', !!b); };
  row.setDetail = (s) => { if (detailEl) detailEl.textContent = s; };
  Object.defineProperty(row, 'checked', { get: () => state, configurable: true });
  row.switch = sw;
  return row;
}

/**
 * A labelled slider (<input type=range>) showing its value as `format(value)` beside the label,
 * which a screen reader hears too. onChange follows the thumb as it moves; onCommit gets the value
 * once it is let go. el.setValue(v), el.value, el.input.
 */
export function slider({ label, min = 0, max = 100, step = 1, value = min, onChange, onCommit, format = (v) => String(v), disabled } = {}) {
  const id = uid('slider');
  const input = el('input', { type: 'range', class: 'ui-slider-input', id, min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.disabled = !!disabled;
  const shown = el('span', { class: 'ui-slider-value', 'aria-hidden': 'true' });
  const wrap = el('div', { class: 'ui-slider' },
    el('div', { class: 'ui-slider-head' }, el('label', { class: 'ui-slider-label', for: id }, label), shown),
    input);
  const render = () => {
    const v = Number(input.value);
    const text = format(v);
    shown.textContent = text;
    input.setAttribute('aria-valuetext', text);
    const span = Number(max) - Number(min);
    input.style.setProperty('--fill', (span > 0 ? ((v - min) / span) * 100 : 0) + '%');
  };
  input.addEventListener('input', () => { render(); onChange?.(Number(input.value)); });
  input.addEventListener('change', () => onCommit?.(Number(input.value)));
  render();
  wrap.setValue = (v) => { input.value = String(v); render(); };
  wrap.setDisabled = (b) => { input.disabled = !!b; };
  Object.defineProperty(wrap, 'value', { get: () => Number(input.value), configurable: true });
  wrap.input = input;
  return wrap;
}

/**
 * An outlined text field with a floating label, as the app's OutlinedTextField: an optional suffix
 * (".pdf"), helper text under it, or an error in its place (announced as it appears).
 * More options: type ('text', 'password', 'number', ...), autocomplete, maxLength, multiline (a
 * <textarea>), disabled, spellcheck, onChange (on blur after a change).
 * el.setValue(v), el.setError(text|null), el.setHelper(text), el.setLabel(text), el.value, el.input.
 */
export function textField({
  label, value = '', suffix, prefix, helper, error, placeholder, inputmode, onInput, onEnter, onChange,
  type = 'text', autocomplete, maxLength, multiline, disabled, spellcheck, rows = 3,
} = {}) {
  const id = uid('field');
  const supportId = id + '-support';
  const suffixId = suffix ? id + '-suffix' : null;
  const input = multiline
    ? el('textarea', { class: 'ui-field-input', id, rows: String(rows) })
    : el('input', { class: 'ui-field-input', id, type });
  if (inputmode) input.setAttribute('inputmode', inputmode);
  if (autocomplete) input.setAttribute('autocomplete', autocomplete);
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  if (spellcheck != null) input.spellcheck = !!spellcheck;
  if (type === 'password') {
    // A password keyboard shows no suggestions and learns nothing typed here.
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
  }
  input.setAttribute('aria-describedby', [suffixId, supportId].filter(Boolean).join(' '));
  input.value = value ?? '';
  input.disabled = !!disabled;
  const labelEl = el('label', { class: 'ui-field-label', for: id }, label ?? '');
  const legendText = el('span', {}, label ?? '');
  const outline = el('fieldset', { class: 'ui-field-outline', 'aria-hidden': 'true' }, el('legend', {}, legendText));
  const box = el('div', { class: 'ui-field-box' },
    prefix ? el('span', { class: 'ui-field-prefix' }, prefix) : null,
    input,
    suffix ? el('span', { class: 'ui-field-suffix', id: suffixId }, suffix) : null,
    labelEl, outline);
  const support = el('div', { class: 'ui-field-support', id: supportId, 'aria-live': 'polite' });
  const field = el('div', { class: 'ui-field' + (multiline ? ' ui-field--multiline' : '') + (label ? '' : ' ui-field--nolabel') }, box, support);
  let helperText = helper ?? '';
  let errorText = error ?? null;
  const render = () => {
    field.classList.toggle('is-filled', input.value !== '' || !!placeholder);
    field.classList.toggle('is-error', !!errorText);
    if (errorText) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    support.textContent = errorText || helperText || '';
    support.hidden = !support.textContent;
  };
  input.addEventListener('input', () => { render(); onInput?.(input.value); });
  if (onChange) input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !multiline && !e.isComposing) {
      if (onEnter) { e.preventDefault(); onEnter(input.value); }
    }
  });
  // Tapping the box (around the input, the suffix) puts the cursor in the field.
  box.addEventListener('mousedown', (e) => {
    if (e.target !== input) { e.preventDefault(); input.focus(); }
  });
  render();
  field.setValue = (v) => { input.value = v ?? ''; render(); };
  field.setError = (s) => { errorText = s || null; render(); };
  field.setHelper = (s) => { helperText = s ?? ''; render(); };
  // The floating label and the gap the outline leaves for it change together.
  field.setLabel = (s) => {
    labelEl.textContent = s ?? '';
    legendText.textContent = s ?? '';
    field.classList.toggle('ui-field--nolabel', !s);
  };
  field.setDisabled = (b) => { input.disabled = !!b; field.classList.toggle('is-disabled', !!b); };
  field.focus = (o) => input.focus(o);
  Object.defineProperty(field, 'value', { get: () => input.value, configurable: true });
  field.input = input;
  return field;
}

/** A linear progress indicator; fraction null for one that runs without end. el.setValue(f|null). */
export function linearProgress({ value = null, label } = {}) {
  const bar = el('div', { class: 'ui-progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('div', { class: 'ui-progress-bar' }));
  bar.setValue = (f) => {
    const known = typeof f === 'number' && Number.isFinite(f);
    bar.classList.toggle('is-indeterminate', !known);
    if (known) {
      const pct = Math.max(0, Math.min(1, f)) * 100;
      bar.style.setProperty('--value', pct + '%');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    } else {
      bar.removeAttribute('aria-valuenow');
    }
  };
  bar.setValue(value);
  return bar;
}

// ---------------------------------------------------------------------------------------------
// Cards and lists

/**
 * A tool card as on Home: icon, title and detail; the whole card is one button (or a link, with
 * href). `trailing` is a node at the end, outside the button. Returns the card.
 */
export function card({ icon: name, title, detail, onClick, href, trailing } = {}) {
  const text = el('span', { class: 'ui-card-text' },
    el('span', { class: 'ui-card-title' }, title),
    detail ? el('span', { class: 'ui-card-detail' }, detail) : null);
  const lead = name ? el('span', { class: 'ui-card-icon', 'aria-hidden': 'true' }, icon(name, { size: 26 })) : null;
  const main = href
    ? el('a', { class: 'ui-card-main', href }, lead, text)
    : onClick ? el('button', { type: 'button', class: 'ui-card-main' }, lead, text) : el('div', { class: 'ui-card-main' }, lead, text);
  on(main, 'click', onClick);
  return el('div', { class: 'ui-card' + (onClick || href ? ' is-clickable' : '') }, main, trailing ? el('div', { class: 'ui-card-trailing' }, trailing) : null);
}

/**
 * A picked file as the app's input cards show it: a thumbnail (a node, or a promise of one, shown
 * as it arrives over a placeholder), its name on up to two lines, a detail line ("3 pages · 619 kB"),
 * a Remove button named after it, and optional `actions` (nodes) under it. `options` (a node) goes
 * between the name and the actions. size 'large' (58×78, the default) or 'small' (44×58).
 * el.setDetail(text), el.setName(text), el.setThumbnail(node|promise), el.body (where options go).
 */
export function fileCard({ name, detail, thumbnail, onRemove, actions, options, size = 'large', placeholderIcon = 'picture_as_pdf' } = {}) {
  const thumb = el('div', { class: 'ui-file-thumb ui-file-thumb--' + size, 'aria-hidden': 'true' }, icon(placeholderIcon, { size: 24 }));
  const nameEl = el('span', { class: 'ui-file-name' }, name);
  const detailEl = el('span', { class: 'ui-file-detail' }, detail ?? '');
  detailEl.hidden = !detail;
  const head = el('div', { class: 'ui-file-head' }, thumbnail !== null ? thumb : null, el('div', { class: 'ui-file-text' }, nameEl, detailEl));
  let removeBtn = null;
  if (onRemove) {
    removeBtn = iconButton({ icon: 'close', label: t('remove_file', name), onClick: onRemove });
    head.append(removeBtn);
  }
  const body = el('div', { class: 'ui-file-body' });
  if (options) body.append(options);
  const cardEl = el('div', { class: 'ui-file-card' }, head, body);
  if (actions?.length) cardEl.append(el('div', { class: 'ui-file-actions' }, ...actions));
  body.hidden = !options;
  let token = 0;
  const setThumbnail = (node) => {
    const mine = ++token;
    Promise.resolve(node).then((n) => {
      if (mine !== token || !n) return;
      n.classList?.add('ui-fade-in');
      clear(thumb);
      thumb.append(n);
      thumb.classList.add('has-picture');
    }, () => { /* the placeholder stays */ });
  };
  if (thumbnail) setThumbnail(thumbnail);
  cardEl.setDetail = (s) => { detailEl.textContent = s ?? ''; detailEl.hidden = !s; };
  cardEl.setName = (s) => { nameEl.textContent = s; removeBtn?.setLabel(t('remove_file', s)); };
  cardEl.setThumbnail = setThumbnail;
  cardEl.body = body;
  cardEl.removeButton = removeBtn;
  return cardEl;
}

/**
 * A Material list item: a leading icon (or any `leading` node), title, detail line and a trailing
 * node. With onClick (or href) the item is one button, the trailing node outside it.
 */
export function listItem({ icon: name, leading, title, detail, trailing, onClick, href } = {}) {
  const lead = leading ?? (name ? el('span', { class: 'ui-list-icon', 'aria-hidden': 'true' }, icon(name, { size: 24 })) : null);
  const text = el('span', { class: 'ui-list-text' },
    el('span', { class: 'ui-list-title' }, title),
    detail ? el('span', { class: 'ui-list-detail' }, detail) : null);
  const main = href
    ? el('a', { class: 'ui-list-main', href }, lead, text)
    : onClick ? el('button', { type: 'button', class: 'ui-list-main' }, lead, text) : el('div', { class: 'ui-list-main' }, lead, text);
  on(main, 'click', onClick);
  return el('div', { class: 'ui-list-item' + (onClick || href ? ' is-clickable' : '') }, main, trailing ? el('div', { class: 'ui-list-trailing' }, trailing) : null);
}

/** A section heading over a group of items (Home's "Create PDF", say). level: heading level (2). */
export function sectionHeading(text, { level = 2 } = {}) {
  return el(`h${Math.min(6, Math.max(2, level))}`, { class: 'ui-section-heading' }, text);
}

// ---------------------------------------------------------------------------------------------
// Picking files: the empty state and dropping or pasting files

/**
 * What a screen shows before it has a file: an icon, a title, a detail line and buttons
 * (`actions`). With onClick and no actions the whole card is one button, as the app's "Choose PDF"
 * card. With onFiles it is also a drop zone (see dropZone: accept, multiple), and on computers it
 * says files can be dropped on it.
 */
export function emptyState({ icon: name = 'add', title, detail, actions = [], onClick, onFiles, accept, multiple = true } = {}) {
  const parts = [
    el('span', { class: 'ui-empty-icon', 'aria-hidden': 'true' }, icon(name, { size: 36 })),
    el('span', { class: 'ui-empty-title' }, title),
    detail ? el('span', { class: 'ui-empty-detail' }, detail) : null,
    onFiles ? el('span', { class: 'ui-empty-drop' }, t('web_drop_hint')) : null,
  ];
  let root;
  if (onClick && !actions.length) {
    root = el('button', { type: 'button', class: 'ui-empty is-clickable' }, ...parts);
    root.addEventListener('click', onClick);
  } else {
    root = el('div', { class: 'ui-empty' }, ...parts, actions.length ? el('div', { class: 'ui-empty-actions' }, ...actions) : null);
  }
  if (onFiles) root.detachDrop = dropZone(root, { accept, multiple, onFiles });
  return root;
}

/** Whether the FileItem is of the kind(s) `accept` names (a kind, a list of kinds, an accept string or a test). */
export function accepts(accept, item) {
  if (accept == null || accept === '' || accept === '*') return true;
  if (typeof accept === 'function') return !!accept(item);
  if (Array.isArray(accept)) return accept.some((a) => accepts(a, item));
  if (ACCEPT[accept]) return fileKind(item) === accept;
  // An accept string: ".pdf,application/pdf,image/*".
  const kind = fileKind(item);
  return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((token) => {
    if (token.startsWith('.')) return kindOfName('x' + token) === kind || item.name?.toLowerCase().endsWith(token);
    if (token.endsWith('/*')) return (item.type ?? '').toLowerCase().startsWith(token.slice(0, -1)) || (token === 'image/*' && kind === 'image');
    return (item.type ?? '').toLowerCase() === token || kindOfType(token) === kind;
  });
}

const pasteZones = [];
let pasteListening = false;

function onPaste(e) {
  const files = e.clipboardData?.files;
  if (!files?.length) return;
  // Pasting into a text field is left to it, and nothing is taken while a dialog is open.
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName) && !['range', 'checkbox', 'radio', 'button', 'file'].includes(active.type))) return;
  for (let i = pasteZones.length - 1; i >= 0; i--) {
    const z = pasteZones[i];
    if (!z.target.isConnected) { pasteZones.splice(i, 1); continue; }
    if (!z.target.getClientRects().length || z.target.closest('[inert]')) continue;
    const dialog = document.querySelector('dialog[open]');
    if (dialog && !dialog.contains(z.target)) return;
    e.preventDefault();
    z.handle(files);
    return;
  }
}

// Files dropped outside a drop zone would otherwise open in the tab, leaving the app.
let guardInstalled = false;
function installDropGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
}

/**
 * Makes `target` take files dropped on it, and pasted while it shows (the most recent drop zone on
 * screen takes a paste). Files of another kind than `accept` (a kind such as 'pdf', a list of
 * kinds, or an accept string) are left out, and a snackbar names them; with multiple false only
 * the first is taken. onFiles(fileItems) gets the rest. While files are dragged over it, the target
 * has the class is-dragover. Returns a function that stops it.
 */
export function dropZone(target, { accept, multiple = true, onFiles, paste = true } = {}) {
  installDropGuard();
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const handle = async (fileList) => {
    const items = await toFileItems(fileList, {
      onUnreadable: (bad) => snackbar(tp('web_files_unreadable', bad.length, bad.length)),
    });
    const taken = items.filter((i) => accepts(accept, i));
    const left = items.filter((i) => !taken.includes(i));
    if (left.length) snackbar(tp('share_unsupported', left.length, left.length, left.map((i) => i.name).join(', ')));
    const chosen = multiple ? taken : taken.slice(0, 1);
    if (chosen.length) onFiles?.(chosen);
  };
  const enter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    target.classList.add('is-dragover');
  };
  const over = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) target.classList.remove('is-dragover');
  };
  const drop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    target.classList.remove('is-dragover');
    if (e.dataTransfer.files?.length) handle(e.dataTransfer.files);
  };
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  const zone = { target, handle };
  if (paste) {
    pasteZones.push(zone);
    if (!pasteListening) {
      pasteListening = true;
      document.addEventListener('paste', onPaste);
    }
  }
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', over);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
    const i = pasteZones.indexOf(zone);
    if (i >= 0) pasteZones.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------------------------
// Dialogs: one modal <dialog> filling the screen, its surface inside. Escape and a tap outside
// close it (unless it can't be dismissed), Tab stays inside it, and the focus goes back to where
// it was when it closes.

let openModals = 0;

function focusables(root) {
  return Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length && !n.closest('[hidden]'));
}

/**
 * Opens a modal dialog around `surface`. Returns { dialog, close(result), closed: Promise<result> }.
 * dismissible: Escape and a tap on the scrim close it with `dismissResult`.
 */
function openModal(surface, { cls = '', role = 'dialog', labelledBy, describedBy, dismissible = true, dismissResult = null, initialFocus } = {}) {
  const dialog = el('dialog', { class: 'ui-dialog ' + cls, role: role === 'dialog' ? null : role, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, 'aria-modal': 'true' }, surface);
  const previous = document.activeElement;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let done = false;
  const close = (result) => {
    if (done) return;
    done = true;
    dialog.classList.add('is-closing');
    const finish = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      openModals = Math.max(0, openModals - 1);
      if (!openModals) document.documentElement.classList.remove('ui-modal-open');
      if (previous && previous.isConnected && typeof previous.focus === 'function' && !document.querySelector('dialog[open]:not(.is-closing)')?.contains(document.activeElement)) {
        previous.focus({ preventScroll: true });
      }
      resolveClosed(result);
    };
    const ms = parseFloat(getComputedStyle(dialog).getPropertyValue('--ui-exit')) || 0;
    if (ms > 0) setTimeout(finish, ms); else finish();
  };
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissible) close(dismissResult);
  });
  // A tap on the scrim, outside the surface.
  let downOnScrim = false;
  dialog.addEventListener('pointerdown', (e) => { downOnScrim = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && downOnScrim && dismissible) close(dismissResult);
    downOnScrim = false;
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables(surface);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !surface.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !surface.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  document.body.append(dialog);
  openModals++;
  document.documentElement.classList.add('ui-modal-open');
  dialog.showModal();
  const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  (target ?? focusables(surface)[0] ?? surface).focus?.({ preventScroll: true });
  return { dialog, close, closed };
}

/**
 * A Material alert dialog: title, message (text or a node), and its buttons at the end: `dismiss`
 * (if given) and `confirm`. destructive: the confirm button is in the error colour and the focus
 * starts on the other one. Escape or a tap outside dismisses. Resolves true when confirmed.
 */
export function alertDialog({ title, message, confirm, dismiss, destructive } = {}) {
  const id = uid('alert');
  const cancelBtn = dismiss ? button({ label: dismiss, variant: 'text' }) : null;
  const okBtn = button({ label: confirm ?? t('ok'), variant: 'text', tone: destructive ? 'danger' : null });
  const surface = el('div', { class: 'ui-dialog-surface ui-alert' },
    title ? el('h2', { class: 'ui-dialog-title', id: id + '-title' }, title) : null,
    message != null ? el('div', { class: 'ui-dialog-body', id: id + '-body' }, message) : null,
    el('div', { class: 'ui-dialog-actions' }, cancelBtn, okBtn));
  const modal = openModal(surface, {
    role: 'alertdialog',
    labelledBy: title ? id + '-title' : null,
    describedBy: message != null ? id + '-body' : null,
    dismissResult: false,
    initialFocus: destructive && cancelBtn ? cancelBtn : okBtn,
  });
  cancelBtn?.addEventListener('click', () => modal.close(false));
  okBtn.addEventListener('click', () => modal.close(true));
  return modal.closed.then((r) => r === true);
}

/**
 * Asks for a PDF's password (PdfToolScreen's PasswordDialog): "“name” is protected. Enter its
 * password to continue.", a password field, Cancel and Open PDF (off while the field is empty).
 * `wrong` shows "That password didn't open the PDF." under the field; typing clears it.
 * With `check(password): Promise<boolean>` the dialog stays open while the password is tried and
 * says so in place when it is wrong, resolving only with one that works; an error check throws
 * closes the dialog and rejects with it. Aborting `signal` (the screen asking is left) closes it.
 * Resolves with the password, or null when cancelled.
 */
export function passwordDialog({ fileName, wrong = false, check, signal } = {}) {
  const id = uid('password');
  const field = textField({
    label: t('pdf_password_hint'),
    type: 'password',
    autocomplete: 'off',
    error: wrong ? t('pdf_wrong_password') : null,
    onInput: () => { field.setError(null); render(); },
    onEnter: () => { if (canUnlock()) unlock(); },
  });
  const cancelBtn = button({ label: t('cancel'), variant: 'text' });
  const okBtn = button({ label: t('pdf_unlock'), variant: 'text' });
  const surface = el('div', { class: 'ui-dialog-surface ui-alert ui-password' },
    el('h2', { class: 'ui-dialog-title', id: id + '-title' }, t('pdf_password_title')),
    el('div', { class: 'ui-dialog-body' }, el('p', { id: id + '-body' }, t('pdf_password_body', fileName)), field),
    el('div', { class: 'ui-dialog-actions' }, cancelBtn, okBtn));
  let unlocking = false;
  const canUnlock = () => field.value !== '' && !unlocking;
  const render = () => { okBtn.disabled = !canUnlock(); };
  const modal = openModal(surface, { labelledBy: id + '-title', describedBy: id + '-body', dismissResult: null, initialFocus: field.input });
  const unlock = async () => {
    const password = field.value;
    if (!check) { modal.close(password); return; }
    unlocking = true;
    render();
    surface.setAttribute('aria-busy', 'true');
    let ok = false;
    try {
      ok = await check(password);
    } catch (e) {
      failure = e;
      modal.close(null);
      return;
    }
    unlocking = false;
    surface.removeAttribute('aria-busy');
    if (ok) { modal.close(password); return; }
    field.setError(t('pdf_wrong_password'));
    field.input.select();
    render();
  };
  let failure = null;
  cancelBtn.addEventListener('click', () => modal.close(null));
  okBtn.addEventListener('click', () => { if (canUnlock()) unlock(); });
  render();
  // Gone with the screen that asked: nothing more is tried, and nobody is told of a failure.
  const onAbort = () => modal.close(null);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return modal.closed.then((r) => {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) return null;
    if (failure) throw failure;
    return r;
  });
}

/**
 * A modal bottom sheet: from the bottom of the screen on phones (with a handle; swiping it down
 * closes the sheet), a dialog in the middle on wide screens. `content` is a node (or nodes),
 * `actions` buttons along its bottom. Escape or a tap outside closes it (dismissible), then
 * onClose() is called. Returns { el (the surface), dialog, close(), closed }.
 */
export function bottomSheet({ title, content, actions, onClose, dismissible = true, cls } = {}) {
  const id = uid('sheet');
  const handle = el('div', { class: 'ui-sheet-handle', 'aria-hidden': 'true' });
  const head = el('div', { class: 'ui-sheet-head' }, handle, title ? el('h2', { class: 'ui-dialog-title', id: id + '-title' }, title) : null);
  const body = el('div', { class: 'ui-sheet-body' }, ...[].concat(content ?? []));
  const surface = el('div', { class: 'ui-dialog-surface ui-sheet' + (cls ? ' ' + cls : '') }, head, body,
    actions?.length ? el('div', { class: 'ui-dialog-actions ui-sheet-actions' }, ...actions) : null);
  const modal = openModal(surface, { cls: 'ui-dialog--sheet', labelledBy: title ? id + '-title' : null, dismissible });
  modal.closed.then(() => onClose?.());
  // Swiping the handle or the title down drags the sheet, and far enough closes it.
  let startY = null;
  let dy = 0;
  head.addEventListener('pointerdown', (e) => {
    if (!dismissible || e.button > 0) return;
    // Not a text selection or a drag of the title.
    e.preventDefault();
    startY = e.clientY;
    dy = 0;
    head.setPointerCapture?.(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    surface.style.transform = dy ? `translateY(${dy}px)` : '';
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    surface.style.transform = '';
    if (dy > Math.min(160, surface.offsetHeight / 3)) modal.close(null);
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  return { el: surface, dialog: modal.dialog, body, close: () => modal.close(null), closed: modal.closed };
}

/**
 * A dialog showing work under way, as the app's "Working on your PDF…": its title, a progress bar
 * (fraction null: one that runs without end), a line saying how far it is (announced as it
 * changes) and a second line, and Cancel when cancellable. Like the app's, it only shows once the
 * work has taken `delay` ms (400), so quick work doesn't flash a dialog; the screen takes no input
 * meanwhile. Escape doesn't cancel. Returns { el, update(fraction|null, label?, detail?), setTitle(text), close() }.
 */
export function progressDialog({ title, cancellable = true, onCancel, delay = 400 } = {}) {
  const id = uid('progress');
  const bar = linearProgress({ value: null, label: title });
  const label = el('p', { class: 'ui-progress-label', 'aria-live': 'polite' });
  const detail = el('p', { class: 'ui-progress-detail' });
  label.hidden = true;
  detail.hidden = true;
  const titleEl = el('h2', { class: 'ui-dialog-title', id: id + '-title' }, title ?? '');
  const cancelBtn = cancellable ? button({ label: t('cancel'), variant: 'text' }) : null;
  const surface = el('div', { class: 'ui-dialog-surface ui-alert ui-progress-dialog' },
    titleEl,
    el('div', { class: 'ui-dialog-body' }, bar, el('div', { class: 'ui-progress-text' }, label, detail)),
    cancelBtn ? el('div', { class: 'ui-dialog-actions' }, cancelBtn) : null);
  surface.tabIndex = -1;
  const modal = openModal(surface, { cls: 'ui-dialog--progress', labelledBy: id + '-title', dismissible: false, initialFocus: cancelBtn ?? surface });
  const timer = setTimeout(() => modal.dialog.classList.add('is-shown'), Math.max(0, delay));
  if (delay <= 0) modal.dialog.classList.add('is-shown');
  cancelBtn?.addEventListener('click', () => {
    cancelBtn.disabled = true;
    cancelBtn.setLabel(t('cancelling'));
    onCancel?.();
  });
  return {
    el: surface,
    dialog: modal.dialog,
    update(fraction, text, second) {
      bar.setValue(fraction);
      if (text !== undefined) { label.textContent = text ?? ''; label.hidden = !text; }
      if (second !== undefined) { detail.textContent = second ?? ''; detail.hidden = !second; }
    },
    setTitle(s) { titleEl.textContent = s; },
    close() {
      clearTimeout(timer);
      modal.close(null);
      return modal.closed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Menus

let openMenu = null;

/**
 * A popup menu at `anchorEl`, as the app's DropdownMenu: items [{ label, icon?, onClick, disabled?,
 * checked? }]. Arrow keys, Home and End move through it, a letter jumps to an item starting with
 * it, Escape or a tap outside closes it, and the focus goes back to the anchor. With { radio: true }
 * the items are announced as checked or not (checked ones show a check mark at the end).
 * An item tapped again while the menu goes away does nothing more. Returns { el, close() }.
 */
export function menu(anchorEl, items, { radio = false } = {}) {
  openMenu?.close(false);
  const container = anchorEl.closest('dialog[open]') ?? document.body;
  const list = el('div', { class: 'ui-menu', role: 'menu' });
  const scrim = el('div', { class: 'ui-menu-scrim' });
  const buttons = [];
  let closed = false;
  const close = (focusAnchor = true) => {
    if (closed) return;
    closed = true;
    if (openMenu === handle) openMenu = null;
    scrim.remove();
    list.remove();
    window.removeEventListener('resize', onResize);
    if (anchorEl.hasAttribute('aria-expanded')) anchorEl.setAttribute('aria-expanded', 'false');
    if (focusAnchor && anchorEl.isConnected) anchorEl.focus({ preventScroll: true });
  };
  for (const item of items) {
    if (item === 'divider' || item?.divider) { list.append(el('div', { class: 'ui-menu-divider', role: 'separator' })); continue; }
    const b = el('button', {
      type: 'button',
      class: 'ui-menu-item' + (item.checked ? ' is-checked' : ''),
      role: radio ? 'menuitemradio' : 'menuitem',
      'aria-checked': radio ? String(!!item.checked) : null,
      tabindex: '-1',
    },
    item.icon ? el('span', { class: 'ui-menu-icon', 'aria-hidden': 'true' }, icon(item.icon, { size: 24 })) : null,
    el('span', { class: 'ui-menu-label' }, item.label),
    radio && item.checked ? el('span', { class: 'ui-menu-check', 'aria-hidden': 'true' }, icon('check', { size: 24 })) : null);
    b.disabled = !!item.disabled;
    b.addEventListener('click', () => {
      if (closed) return;
      close(true);
      item.onClick?.();
    });
    buttons.push(b);
    list.append(b);
  }
  const enabled = () => buttons.filter((b) => !b.disabled);
  list.addEventListener('keydown', (e) => {
    const ok = enabled();
    const at = ok.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); ok[(at + 1) % ok.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ok[(at - 1 + ok.length) % ok.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); ok[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); ok[ok.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const from = Math.max(0, at);
      for (let i = 1; i <= ok.length; i++) {
        const b = ok[(from + i) % ok.length];
        if (b.textContent.trim().toLowerCase().startsWith(k)) { b.focus(); break; }
      }
    }
  });
  scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); close(true); });
  scrim.addEventListener('click', (e) => e.preventDefault());
  container.append(scrim, list);
  const place = () => {
    const r = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    list.style.maxHeight = Math.max(120, vh - 16) + 'px';
    const mw = list.offsetWidth;
    const mh = Math.min(list.scrollHeight, vh - 16);
    const rtl = isRtl(anchorEl);
    let left = rtl ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    let top = r.bottom + 2;
    if (top + mh > vh - 8) top = r.top - mh - 2 >= 8 ? r.top - mh - 2 : Math.max(8, vh - mh - 8);
    list.style.left = left + 'px';
    list.style.top = top + 'px';
  };
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  place();
  if (anchorEl.hasAttribute('aria-expanded')) anchorEl.setAttribute('aria-expanded', 'true');
  const first = buttons.find((b) => b.classList.contains('is-checked') && !b.disabled) ?? enabled()[0];
  first?.focus({ preventScroll: true });
  const handle = { el: list, close: () => close(true) };
  openMenu = handle;
  return handle;
}

// ---------------------------------------------------------------------------------------------
// Snackbars: one at a time at the bottom, the next once it has gone, each announced politely.

const snackQueue = [];
let snackHost = null;
let snackShowing = null;

function host() {
  if (snackHost?.isConnected) return snackHost;
  snackHost = el('div', { class: 'ui-snackbar-host' });
  // In the top layer where browsers have one, so a snackbar shows above an open dialog too.
  if (typeof snackHost.showPopover === 'function') snackHost.setAttribute('popover', 'manual');
  document.body.append(snackHost);
  return snackHost;
}

/**
 * How far up from the bottom of the screen a tool's bottom bar (bottomBar(): its main button)
 * reaches, or 0 when none is there: snackbars show above it, as the app's Scaffold puts its
 * snackbar host above its bottom bar. Only a bar on screen and at the bottom counts.
 */
function bottomBarRoom() {
  const bottom = document.documentElement.clientHeight || window.innerHeight;
  let room = 0;
  for (const bar of document.querySelectorAll('.ui-bottombar')) {
    const r = bar.getBoundingClientRect();
    if (!r.height || r.top >= bottom || r.bottom < bottom - 2) continue;
    if (getComputedStyle(bar).visibility === 'hidden') continue;
    room = Math.max(room, bottom - r.top);
  }
  return Math.ceil(room);
}

// While a snackbar shows, its place follows the bars that come and go (a result screen replacing
// the tool, a bar sliding in). Screens can still lift it with --snackbar-offset; the higher wins.
let liftTimer = 0;
function placeSnacks() {
  snackHost?.style.setProperty('--ui-snackbar-lift', bottomBarRoom() + 'px');
}
function followBars(on) {
  if (on && !liftTimer) {
    liftTimer = setInterval(placeSnacks, 250);
    window.addEventListener('resize', placeSnacks);
  } else if (!on && liftTimer) {
    clearInterval(liftTimer);
    liftTimer = 0;
    window.removeEventListener('resize', placeSnacks);
  }
}

function showNextSnack() {
  if (snackShowing || !snackQueue.length) return;
  const s = snackQueue.shift();
  snackShowing = s;
  const hostEl = host();
  placeSnacks();
  followBars(true);
  hostEl.append(s.el);
  if (hostEl.hasAttribute('popover')) {
    try { if (hostEl.matches(':popover-open')) hostEl.hidePopover(); hostEl.showPopover(); } catch { /* not shown in the top layer */ }
  }
  requestAnimationFrame(() => s.el.classList.add('is-shown'));
  announce(s.message);
  s.start();
}

/**
 * Shows a message at the bottom of the screen for a few seconds (longer for a long one, or one with
 * an action), one at a time. `action` is a button label; onAction() is called when it is tapped.
 * It shows above the screen's bottom bar (see bottomBar) while one is there.
 * Returns the snackbar element: el.dismiss(), el.result (a promise of 'action' or 'dismissed').
 */
export function snackbar(message, { action, onAction, duration } = {}) {
  const text = String(message ?? '');
  const ms = duration ?? (action ? 10000 : Math.max(4000, Math.min(10000, 2000 + text.length * 50)));
  const node = el('div', { class: 'ui-snackbar' }, el('span', { class: 'ui-snackbar-text' }, text));
  let resolve;
  node.result = new Promise((r) => { resolve = r; });
  let timer = null;
  let left = ms;
  let since = 0;
  let gone = false;
  const dismiss = (how = 'dismissed') => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    const i = snackQueue.indexOf(entry);
    if (i >= 0) snackQueue.splice(i, 1);
    node.classList.remove('is-shown');
    resolve(how);
    setTimeout(() => {
      node.remove();
      if (snackShowing === entry) {
        snackShowing = null;
        if (!snackQueue.length) {
          followBars(false);
          if (snackHost?.hasAttribute('popover')) { try { snackHost.hidePopover(); } catch { /* already hidden */ } }
        }
        showNextSnack();
      }
    }, 160);
  };
  if (action) {
    const b = button({ label: action, variant: 'text', cls: 'ui-snackbar-action' });
    b.addEventListener('click', () => { onAction?.(); dismiss('action'); });
    node.append(b);
  }
  const entry = {
    el: node,
    message: action ? `${text} ${action}` : text,
    start() { since = Date.now(); timer = setTimeout(() => dismiss(), left); },
  };
  // Held while pointed at or focused, so it can be read and its action reached.
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; left = Math.max(1500, left - (Date.now() - since)); } };
  const resume = () => { if (!timer && !gone && snackShowing === entry) entry.start(); };
  node.addEventListener('pointerenter', pause);
  node.addEventListener('pointerleave', resume);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', resume);
  node.dismiss = () => dismiss();
  snackQueue.push(entry);
  showNextSnack();
  return node;
}
