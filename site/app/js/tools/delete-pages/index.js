// Delete pages (PageGrids.kt DeletePagesOptions, PdfToolsViewModel.runDeletePages): the pages to
// delete typed like 2,5-7 or marked by tapping them, the two kept in step; how many will go; and
// marking every page says one must stay.
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { textField } from '../../core/ui.js';
import { pageGrid } from '../../core/pagegrid.js';
import { parsePageSelection, pagesToDelete, formatPages } from '../../engine/page-selection.js';
import { mountPdfTool, collapsible, updateSelection } from '../split/frame.js';

/** The pages `text` marks, zero-based; null while it can't be read and isn't blank. */
function marksOf(text, pageCount) {
  if (!String(text ?? '').trim()) return [];
  try {
    return parsePageSelection(text, pageCount);
  } catch {
    return null;
  }
}

/**
 * What a tap on page `index` makes of `text`: the page marked or unmarked, written sorted with
 * runs as ranges ("2,5-7"); `text` as it is while it can't be read (a typo, a range half typed).
 * @param {string} text
 * @param {number} index
 * @param {number} pageCount
 * @returns {string}
 */
export function toggleMark(text, index, pageCount) {
  const now = marksOf(text, pageCount);
  if (!now) return text;
  const set = new Set(now);
  if (set.has(index)) set.delete(index); else set.add(index);
  return formatPages(set);
}

/** The pages `text` marks, as a set; none while it can't be read. */
export function markedPages(text, pageCount) {
  return new Set(marksOf(text, pageCount) ?? []);
}

export function mount(ctx) {
  const build = (src, { engine, refresh }) => {
    const count = src.pageCount;
    let text = '';
    // The pages marked, as the grid shows them (it reads this set).
    const marked = new Set();

    const field = textField({
      label: t('delete_pages_field'),
      helper: t('delete_pages_hint'),
      autocomplete: 'off',
      spellcheck: false,
      onInput: (v) => {
        text = v;
        show();
      },
    });
    field.input.setAttribute('autocapitalize', 'off');
    field.input.setAttribute('autocorrect', 'off');

    // A screen reader says the new count as pages are marked.
    const counted = h('p', { class: 'delete-pages-count', 'aria-live': 'polite' });
    const need = collapsible(h('p', { class: 'delete-pages-need' }, t('pdf_need_page')), { shown: false });
    const status = h('div', { class: 'delete-pages-status' }, counted, need);

    const grid = pageGrid({
      count,
      thumbnail: (i, width, { signal }) => src.thumbnail(i, width, { signal }),
      selectable: true,
      selectedStyle: 'delete',
      selected: marked,
      // "Page 3, Marked to delete": the app's page name and its state.
      tileLabel: (i) => `${t('pdf_page_number', i + 1)}, ${t(marked.has(i) ? 'page_marked_delete' : 'page_kept')}`,
      onToggle: (i) => {
        const next = toggleMark(text, i, count);
        if (next === text) return;
        text = next;
        field.setValue(text);
        show();
      },
      ariaLabel: t('delete_pages_field'),
      moveButtons: false,
    });
    const pages = h('div', { class: 'delete-pages-grid' }, grid);

    function show() {
      updateSelection(grid, marked, markedPages(text, count));
      const label = t('delete_pages_count', marked.size, count);
      if (counted.textContent !== label) counted.textContent = label;
      need.setShown(marked.size === count);
      refresh();
    }
    show();

    return {
      nodes: [field, status, pages],
      ready: () => text.trim() !== '',
      unsaved: () => false,
      prepare: () => pagesToDelete(text, count),
      run: (input, doomed, fileName, hooks) => engine.deletePages(input, { pages: doomed, fileName }, hooks),
      destroy: () => grid.destroy(),
    };
  };

  return mountPdfTool(ctx, {
    id: 'delete-pages',
    namespace: 'delete-pages',
    action: 'pdf_delete_pages_action',
    css: new URL('./delete-pages.css', import.meta.url),
    build,
  });
}
