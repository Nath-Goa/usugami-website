// Split PDF (PdfToolScreen.kt's SplitOptions, PdfToolsViewModel.runSplit): "Selected pages" picked by
// tapping previews or typed like 1,3,5-8, "Custom ranges" like 1-3;5;7-9, "Fixed chunks" of a size,
// or "Every page"; the selected pages or ranges combined into one PDF or each its own.
import { h, isWide } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { chips, switchRow, textField, uid } from '../../core/ui.js';
import { pageGrid } from '../../core/pagegrid.js';
import { parsePageSelection, formatPagesInOrder } from '../../engine/page-selection.js';
import { mountPdfTool, collapsible, updateSelection } from './frame.js';

/** The modes, in the app's order, with their chips' strings. */
const MODES = [
  ['selected', 'pdf_selected'],
  ['custom', 'pdf_custom'],
  ['fixed', 'pdf_fixed'],
  ['every', 'pdf_every_page'],
];

/**
 * The pages `text` names, zero-based and in the order typed, for a page tapped to go in or out of
 * them: null while it can't be read and isn't blank (a typo, a range half typed), so a tap then
 * leaves what was typed as it is (PageGrids.kt tappedOnto).
 * @param {string} text
 * @param {number} pageCount
 * @returns {number[]|null}
 */
export function tappedOnto(text, pageCount) {
  if (!String(text ?? '').trim()) return [];
  try {
    return parsePageSelection(text, pageCount);
  } catch {
    return null;
  }
}

/** The pages `text` names, in the order typed; none while it can't be read (PageGrids.kt typedPages). */
export function typedPages(text, pageCount) {
  return tappedOnto(text, pageCount) ?? [];
}

/**
 * What a tap on page `index` makes of `text`: the page added at the end, or taken out, the others
 * keeping their order and ranges kept short. `text` as it is when it can't be read.
 */
export function tapPage(text, index, pageCount) {
  const now = tappedOnto(text, pageCount);
  if (!now) return text;
  return formatPagesInOrder(now.includes(index) ? now.filter((p) => p !== index) : [...now, index]);
}

const fieldLabel = (mode) => t(mode === 'fixed' ? 'pdf_fixed_hint' : mode === 'custom' ? 'pdf_custom' : 'pdf_selected');
const fieldHint = (mode) => t(mode === 'custom' ? 'pdf_custom_hint' : mode === 'fixed' ? 'pdf_fixed_example' : 'pdf_selected_hint');
const combineLabel = (mode) => t(mode === 'custom' ? 'pdf_combine_ranges' : 'pdf_combine_selected');
const showsField = (mode) => mode !== 'every';
const showsCombine = (mode) => mode === 'selected' || mode === 'custom';

export function mount(ctx) {
  // As the app's switch: on at first, and kept for the next PDF.
  let combine = true;

  const build = (src, { engine }) => {
    const count = src.pageCount;
    // Belong to the PDF they were chosen in.
    let mode = 'selected';
    let text = '';

    const headingId = uid('split-heading');
    const heading = h('h2', { class: 'onepdf-heading', id: headingId }, t('tool_split'));

    // One field for every mode, as the app's: a new mode gives it its label, hint and keyboard.
    const field = textField({
      label: fieldLabel(mode),
      helper: fieldHint(mode),
      value: text,
      autocomplete: 'off',
      spellcheck: false,
      onInput: (v) => {
        text = v;
        showSelection();
      },
    });
    field.classList.add('split-field');
    field.input.setAttribute('autocapitalize', 'off');
    field.input.setAttribute('autocorrect', 'off');
    const fieldFor = (m) => {
      field.setLabel(fieldLabel(m));
      field.setHelper(fieldHint(m));
      // Pages per PDF is a number.
      if (m === 'fixed') field.input.setAttribute('inputmode', 'numeric');
      else field.input.removeAttribute('inputmode');
    };
    const makeCombine = (m) => switchRow({
      label: combineLabel(m),
      checked: combine,
      onChange: (b) => { combine = b; },
    });

    let combineRow = makeCombine(mode);
    const fieldBox = collapsible(field, { cls: 'split-section' });
    const combineBox = collapsible(combineRow, { cls: 'split-section' });

    // Framed in the picker (the order typed, which a combined PDF keeps, is the text's).
    const selected = new Set();
    const grid = pageGrid({
      count,
      thumbnail: (i, width, { signal }) => src.thumbnail(i, width, { signal }),
      selectable: true,
      selected,
      onToggle: (i) => {
        const next = tapPage(text, i, count);
        if (next === text) return;
        text = next;
        field.setValue(text);
        showSelection();
      },
      ariaLabel: t('pdf_selected'),
      moveButtons: false,
    });
    const picker = h('div', { class: 'split-picker' }, grid);
    // On phones the pages are one row, as the app's: up and down don't go to another row.
    picker.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isWide() && e.target.closest?.('.ui-page')) e.stopPropagation();
    }, true);
    const pickerBox = collapsible(picker, { cls: 'split-section' });

    function showSelection() {
      updateSelection(grid, selected, typedPages(text, count));
    }

    const setMode = (m) => {
      if (m === mode) return;
      mode = m;
      text = '';
      field.setValue('');
      // A section closing keeps its words, rather than taking another mode's as it goes.
      if (showsField(m)) fieldFor(m);
      if (showsCombine(m)) {
        combineRow = makeCombine(m);
        combineBox.inner.replaceChildren(combineRow);
      }
      fieldBox.setShown(showsField(m));
      combineBox.setShown(showsCombine(m));
      pickerBox.setShown(m === 'selected');
      showSelection();
    };

    const modes = chips({
      options: MODES.map(([value, key]) => ({ value, label: t(key) })),
      value: mode,
      labelledBy: headingId,
      onChange: setMode,
    });
    modes.classList.add('split-modes');

    const options = h('div', { class: 'split-options' }, modes, fieldBox, combineBox, pickerBox);

    return {
      nodes: [heading, options],
      ready: () => true,
      unsaved: () => false,
      prepare: () => engine.splitGroups({ mode, pages: text, pagesPerFile: text, combine }, count),
      run: (input, groups, fileName, hooks) => engine.splitPdf(input, { groups, fileName }, hooks),
      destroy: () => grid.destroy(),
      // For tests and the screen's own checks.
      get mode() { return mode; },
      get text() { return text; },
    };
  };

  return mountPdfTool(ctx, {
    id: 'split',
    namespace: 'split',
    action: 'pdf_split_action',
    css: new URL('./split.css', import.meta.url),
    build,
  });
}
