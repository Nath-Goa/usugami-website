// Add page numbers (PdfToolScreen.kt and PdfEditOptions.kt's PageNumberOptions, PdfToolsViewModel's
// runPageNumbers and runPageNumbersAll): where the numbers go on a small page with a spot for each
// place, their size, and the pages to skip, for one PDF or several numbered the same way.
import { h, ensureCss } from '../../core/dom.js';
import { t, loadStrings } from '../../core/i18n.js';
import { segmented, textField, snackbar, uid } from '../../core/ui.js';
import { UserError } from '../../core/errors.js';
// Only the layout and the choices: the engine (pdf-lib, the text engine) loads once a PDF is added.
import {
  numberedPages, numberedEach, PAGE_NUMBER_POSITIONS, DEFAULT_POSITION, DEFAULT_SIZE,
} from '../../engine/stamps-layout.js';
import { mountStampTool, optionHeading, loadStampsEngine } from './stamp-screen.js';

const POSITIONS = Object.keys(PAGE_NUMBER_POSITIONS);
const POSITION_LABELS = {
  'top-left': 'position_top_left',
  'top-center': 'position_top_center',
  'top-right': 'position_top_right',
  'bottom-left': 'position_bottom_left',
  'bottom-center': 'position_bottom_center',
  'bottom-right': 'position_bottom_right',
};

/** Renders Add page numbers into ctx.root. */
export async function mount(ctx) {
  await Promise.all([loadStrings('page-numbers'), ensureCss(new URL('./page-numbers.css', import.meta.url))]);
  // Kept while the tool is open, as the app keeps them through rotation.
  const state = { position: DEFAULT_POSITION, size: DEFAULT_SIZE, skip: '' };

  return mountStampTool(ctx, {
    id: 'page-numbers',
    action: 'pdf_page_numbers_action',
    actionMany: 'pdf_page_numbers_action_many',
    forAllHint: 'page_numbers_for_all_hint',
    options: () => pageNumberOptions(state),
    async prepare(sources) {
      // The pages to skip are checked before anything is made, against the longest PDF.
      const counts = sources.map((s) => s.pageCount);
      let numbered;
      try {
        numbered = counts.length > 1 ? numberedEach(state.skip, counts) : [numberedPages(state.skip, counts[0])];
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        snackbar(t(e.key, ...e.args));
        return null;
      }
      if (numbered.every((pages) => !pages.length)) {
        snackbar(t('page_numbers_all_skipped'));
        return null;
      }
      const longest = Math.max(...counts);
      const { position, size, skip } = state;
      const { addPageNumbers } = await loadStampsEngine();
      // Each PDF reads the pages to skip as checked here; one with every page skipped is left out,
      // and the batch names it (batch_nothing_to_number).
      return (src, index, name, hooks) => addPageNumbers(
        { name: src.name, bytes: src.bytes, password: src.password },
        { skip, skipAgainst: longest, position, size, fileName: name },
        hooks,
      );
    },
  });
}

/** The choices: Position, Size and Pages to skip, with the note under it. */
function pageNumberOptions(state) {
  const positionId = uid('pn-position');
  const sizeId = uid('pn-size');
  const picker = positionPicker({
    value: state.position,
    labelledBy: positionId,
    onChange: (v) => { state.position = v; },
  });
  const sizes = segmented({
    labelledBy: sizeId,
    value: state.size,
    options: [
      { value: 'small', label: t('number_size_small') },
      { value: 'medium', label: t('number_size_medium') },
      { value: 'large', label: t('number_size_large') },
    ],
    onChange: (v) => { state.size = v; },
  });
  const skip = textField({
    label: t('page_numbers_skip'),
    helper: t('page_numbers_skip_hint'),
    value: state.skip,
    autocomplete: 'off',
    spellcheck: false,
    onInput: (v) => { state.skip = v; },
  });
  const note = h('p', { class: 'page-numbers-note' }, t('page_numbers_note'));
  const el = h('div', { class: 'stamps-options page-numbers-options' },
    optionHeading(t('page_numbers_position'), positionId), picker,
    optionHeading(t('page_numbers_size'), sizeId), sizes,
    h('div', { class: 'page-numbers-skip' }, skip, note));
  return { el, ready: () => true };
}

/**
 * A small page with a spot in each of the six places a number can go (PositionPicker): the chosen
 * spot shows a number; each spot is a radio button named after its place. The arrow keys move
 * between the places as they sit on the page.
 */
function positionPicker({ value, onChange, labelledBy }) {
  let current = value;
  const sheet = h('div', { class: 'page-numbers-sheet', role: 'radiogroup', 'aria-labelledby': labelledBy });
  // Grey bars stand for the page's text.
  const lines = h('div', { class: 'page-numbers-lines', 'aria-hidden': 'true' },
    ...[1, 1, 0.85, 1, 0.6].map((w) => h('span', { class: 'page-numbers-line', style: { width: `${w * 100}%` } })));
  sheet.append(lines);
  const spots = POSITIONS.map((position) => {
    const spot = h('button', {
      type: 'button',
      role: 'radio',
      class: `page-numbers-spot page-numbers-spot--${position}`,
      'aria-label': t(POSITION_LABELS[position]),
      dataset: { position },
    }, h('span', { class: 'page-numbers-dot', 'aria-hidden': 'true' }, h('span', { class: 'page-numbers-digit' }, '1')));
    spot.addEventListener('click', () => choose(position, false));
    spot.addEventListener('keydown', (e) => onKey(e, position));
    sheet.append(spot);
    return spot;
  });
  // The chosen place in words; the spots already tell a screen reader.
  const words = h('span', { class: 'page-numbers-chosen', 'aria-hidden': 'true' });
  const render = () => {
    spots.forEach((spot, i) => {
      const on = POSITIONS[i] === current;
      spot.setAttribute('aria-checked', String(on));
      spot.classList.toggle('is-selected', on);
      spot.tabIndex = on ? 0 : -1;
    });
    words.textContent = t(POSITION_LABELS[current]);
  };
  const choose = (position, focus) => {
    const changed = position !== current;
    current = position;
    render();
    if (focus) spots[POSITIONS.indexOf(position)].focus();
    if (changed) onChange?.(position);
  };
  // The spots are the page's own left and right, in any language, and so are the arrow keys.
  const onKey = (e, position) => {
    const { top, column } = PAGE_NUMBER_POSITIONS[position];
    let row = top ? 0 : 1;
    let col = column;
    switch (e.key) {
      case 'ArrowRight': col += 1; break;
      case 'ArrowLeft': col -= 1; break;
      case 'ArrowDown': row += 1; break;
      case 'ArrowUp': row -= 1; break;
      case 'Home': row = 0; col = 0; break;
      case 'End': row = 1; col = 2; break;
      default: return;
    }
    e.preventDefault();
    // Past the end of a row goes on to the next one, as radio buttons go round.
    if (col > 2) { col = 0; row += 1; }
    if (col < 0) { col = 2; row -= 1; }
    row = (row + 2) % 2;
    const next = POSITIONS.find((p) => PAGE_NUMBER_POSITIONS[p].top === (row === 0) && PAGE_NUMBER_POSITIONS[p].column === col);
    choose(next, true);
  };
  render();
  const el = h('div', { class: 'page-numbers-picker' }, sheet, words);
  el.setValue = (v) => { current = v; render(); };
  Object.defineProperty(el, 'value', { get: () => current });
  return el;
}
