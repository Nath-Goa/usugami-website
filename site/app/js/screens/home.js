// Home (HomeScreen.kt): Scan document at the top, whose buttons take a photo or pick images to
// make pages of, then the files saved last (if any), a search field, and the tools in their
// sections. While something is typed, what it finds (Scan document too) shows in one list
// instead, and Scan document and the files leave the top. On wider screens the cards make a
// grid, "/" goes to the search field, and files dropped or pasted open as shared files do.
import { h } from '../core/dom.js';
import { t, tp, tWeb } from '../core/i18n.js';
import { icon } from '../core/icons.js';
import { TOOLS, SECTIONS } from '../core/tools.js';
import { search } from '../core/search.js';
import { listRecent, onRecentChange } from '../core/recent.js';
import { topBar, button, card, iconButton, dropZone } from '../core/ui.js';
// Imported up front (ui.js loads it anyway), so the picker opens within the tap: mobile Safari
// doesn't open one after an await, as the tap no longer counts.
import { pickFiles } from '../core/files.js';
import { recentRow } from './recent.js';

/** How many of the files saved last Home shows. */
const HOME_RECENT_FILES = 3;

/** What is typed into the search field: kept while a tool opened from the results shows. */
let savedQuery = '';

/** Every card the search looks through, Scan document first, as on Home. */
const CARDS = ['scan', ...SECTIONS.flatMap((s) => s.tools)];

/** A card's name, then what it does and its hidden keywords; the tools for several files also answer to "batch". */
function cardName(id) {
  return t(TOOLS[id].title);
}

function cardMore(id) {
  const tool = TOOLS[id];
  return `${tWeb(tool.detail)} ${t(tool.keywords)}${tool.batch ? ' ' + t('search_keywords_batch') : ''}`;
}

/** Renders Home. */
export async function mount(ctx) {
  const { root, navigate } = ctx;
  let step = ctx.step;
  let query = step === 'search' ? savedQuery : '';
  savedQuery = query;
  /** Set while Home goes back a history step itself (the search emptied), not the user. */
  let popping = false;

  const openTool = (id) => navigate('/tool/' + id);

  /**
   * Picks images for a scan. A photo goes through the app's photo flow (Discard photo, Take
   * another, Done); uploaded images through the crop screen one after another.
   */
  const pickForScan = async ({ camera = false, ...options }) => {
    const files = await pickFiles({ accept: 'image', ...options });
    if (!files.length) return;
    if (camera) navigate('/tool/scan', { files, params: { camera: '1' } });
    else navigate('/tool/scan', { files });
  };

  /** Scan document: the theme's main colour, a button that takes a photo and one that picks images. */
  const scanCard = () => {
    const id = 'scan-title-' + Math.random().toString(36).slice(2, 8);
    return h('section', { class: 'scan-card', 'aria-labelledby': id },
      h('div', { class: 'scan-card-head' },
        icon(TOOLS.scan.icon, { size: 48 }),
        h('div', null,
          h('h2', { class: 'scan-card-title', id }, t(TOOLS.scan.title)),
          h('p', { class: 'scan-card-detail' }, t(TOOLS.scan.detail)))),
      h('div', { class: 'scan-card-buttons' },
        // The phone's own camera app takes the photo; on a computer this picks an image.
        button({ label: t('add_from_camera'), icon: 'photo_camera', variant: 'filled', onClick: () => pickForScan({ camera: true, capture: 'environment', multiple: false }) }),
        button({ label: t('scan_upload'), icon: 'photo_library', variant: 'outlined', onClick: () => pickForScan({ multiple: true }) })));
  };

  const toolCard = (id) => card({
    icon: TOOLS[id].icon,
    title: t(TOOLS[id].title),
    detail: tWeb(TOOLS[id].detail),
    onClick: () => openTool(id),
  });

  // The top bar: Usugami, and Settings.
  const bar = topBar({
    title: t('home_title'),
    actions: [{ icon: 'settings_outline', label: t('settings'), onClick: () => navigate('/settings') }],
  });

  // Scan document and the files saved last.
  const recentBox = h('div', { class: 'home-recent' });
  const top = h('div', { class: 'home-top' }, scanCard(), recentBox);

  // Changes can come quickly one after another: only the last look at the list is drawn.
  let recentSeq = 0;
  const renderRecent = async () => {
    const mine = ++recentSeq;
    const files = await listRecent();
    if (mine !== recentSeq) return;
    top.classList.toggle('has-recent', files.length > 0);
    if (!files.length) {
      recentBox.replaceChildren();
      recentBox.hidden = true;
      return;
    }
    recentBox.hidden = false;
    const headingId = 'home-recent-title';
    const seeAll = button({ label: t('recent_see_all'), variant: 'text', onClick: () => navigate('/recent') });
    const now = new Date();
    recentBox.replaceChildren(
      h('section', { 'aria-labelledby': headingId },
        h('div', { class: 'home-recent-head' }, h('h2', { id: headingId }, t('recent_title')), seeAll),
        h('ul', { class: 'recent-list' }, files.slice(0, HOME_RECENT_FILES).map((f) => recentRow(f, now)))));
  };

  // The search field.
  const input = h('input', {
    type: 'search',
    id: 'home-search',
    placeholder: t('home_search_hint'),
    'aria-label': t('home_search_hint'),
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: query,
  });
  const clearButton = iconButton({ icon: 'close', label: t('home_search_clear'), onClick: () => { setQuery(''); input.focus(); } });
  clearButton.classList.add('home-search-clear');
  const keyHint = h('kbd', { class: 'home-search-key', 'aria-hidden': 'true' }, '/');
  const searchBox = h('div', { class: 'home-search', role: 'search' },
    h('span', { class: 'home-search-icon', 'aria-hidden': 'true' }, icon('search')),
    input, keyHint, clearButton);

  // What a search finds, under a line saying how many (read out as the user types).
  const count = h('p', { class: 'home-results-count', 'aria-live': 'polite', role: 'status' });
  const found = h('div', { class: 'home-grid' });
  const results = h('div', { class: 'home-results' }, count, found);

  // The tools in their sections.
  const sections = h('div', { class: 'home-sections' }, SECTIONS.map((s) => {
    const id = 'home-section-' + s.id;
    return h('section', { 'aria-labelledby': id, dataset: { section: s.id } },
      h('h2', { class: 'home-section-heading', id }, t(s.heading)),
      h('div', { class: 'home-grid' }, s.tools.map(toolCard)));
  }));

  const renderSearch = () => {
    const searching = query.trim() !== '';
    top.hidden = searching;
    sections.hidden = searching;
    results.hidden = !searching;
    clearButton.hidden = query === '';
    keyHint.hidden = query !== '';
    if (!searching) {
      found.replaceChildren();
      count.textContent = '';
      return;
    }
    const hits = search(CARDS, query, cardName, cardMore);
    count.classList.toggle('is-none', hits.length === 0);
    count.textContent = hits.length ? tp('home_search_results', hits.length) : t('home_search_none', query.trim());
    found.replaceChildren(...hits.map((id) => (id === 'scan' ? scanCard() : toolCard(id))));
  };

  /** Sets the search, keeping a history step while there is one, so Back clears it first. */
  function setQuery(value) {
    const had = query !== '';
    query = value;
    savedQuery = value;
    if (input.value !== value) input.value = value;
    renderSearch();
    if (!had && value !== '' && step !== 'search') {
      ctx.pushStep('search');
      step = 'search';
    } else if (had && value === '' && step === 'search') {
      popping = true;
      ctx.popStep();
    }
  }

  input.addEventListener('input', () => setQuery(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      setQuery('');
    } else if (e.key === 'Enter') {
      // The keyboard's search key just closes the keyboard.
      input.blur();
    }
  });

  // "/" goes to the search field, as on many sites, unless the user is typing elsewhere.
  const onKey = (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    input.focus();
    input.select();
  };
  document.addEventListener('keydown', onKey);

  const page = h('div', { class: 'page home-page', 'data-main': '' },
    h('p', { class: 'home-subtitle' }, tWeb('home_subtitle')),
    top, searchBox, results, sections);
  root.append(bar, page);
  await renderRecent();
  renderSearch();
  const stopRecent = onRecentChange(() => { renderRecent(); });
  // On a computer, files dropped or pasted on Home open as files shared to the app do.
  const stopDrop = dropZone(page, {
    accept: () => true,
    multiple: true,
    onFiles: async (items) => {
      const { receiveFiles } = await import('../core/share-inbox.js');
      await receiveFiles(items);
    },
  });

  return {
    unmount() {
      document.removeEventListener('keydown', onKey);
      stopRecent();
      stopDrop();
    },
    hasUnsavedWork: () => false,
    /** Back while searching clears the search (the app's BackHandler); Forward brings it back. */
    onStep(next) {
      step = next;
      if (next === null) {
        if (popping) {
          popping = false;
          // Typed again before the step was gone: it is wanted after all.
          if (query !== '') {
            ctx.pushStep('search');
            step = 'search';
          }
        } else if (query !== '') {
          query = '';
          savedQuery = '';
          input.value = '';
          renderSearch();
        }
      } else if (next === 'search' && query === '' && savedQuery) {
        query = savedQuery;
        input.value = query;
        renderSearch();
      }
    },
  };
}
