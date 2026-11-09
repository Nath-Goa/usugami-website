// Choose a tool (ShareScreen.kt): the PDFs shared to or opened with the app, and under Home's
// headings the tools that take them: every PDF tool for one PDF; for several, Merge PDF and the
// tools that work on several PDFs at once. Those with a password are asked for in turn. The tool
// chosen opens with the PDFs in it, and goes back here when the user leaves it.
import { h } from '../core/dom.js';
import { t, tp, tWeb, formatSize } from '../core/i18n.js';
import { TOOLS, SECTIONS } from '../core/tools.js';
import { onRouteChange } from '../core/router.js';
import { topBar, card, fileCard, linearProgress } from '../core/ui.js';
import { getSharedPdfs, setSharedPdfs, clearSharedPdfs } from '../core/share-inbox.js';

/**
 * Whether the tool takes `count` PDFs shared to the app: any PDF tool takes one; Merge PDF and
 * the tools that work on several PDFs at once take several (ShareScreen.takesShared).
 * @param {string} id
 * @param {number} count
 */
export function takesShared(id, count) {
  const tool = TOOLS[id];
  return !!tool && tool.accepts === 'pdf' && (count === 1 || id === 'merge' || !!tool.batch);
}

/** The PDF tools under their headings as Home shows them, those taking `count` PDFs. */
export function toolsForShared(count) {
  return SECTIONS
    .map((s) => ({ id: s.id, heading: s.heading, tools: s.tools.filter((id) => takesShared(id, count)) }))
    .filter((s) => s.tools.length > 0);
}

/** The PDFs opened here (pdf.js, for their pages and thumbnails), kept while a tool chosen shows. */
const opened = new Map();
let watching = false;

/** Frees what pdf.js holds for a PDF opened here (PdfSource.close() destroys its loading task). */
function closeSource(source) {
  try {
    source?.close();
  } catch {
    // Closed already.
  }
}

function closeAll() {
  for (const source of opened.values()) closeSource(source);
  opened.clear();
}

/** Renders Choose a tool. */
export async function mount(ctx) {
  if (!watching) {
    watching = true;
    // Leaving for anywhere but a tool chosen here lets the PDFs go.
    onRouteChange((route) => {
      if (route?.path !== '/choose' && route?.from !== '/choose') {
        clearSharedPdfs();
        closeAll();
      }
    });
  }
  const { openPdf, reportFileProblems } = await import('../core/pdfdoc.js');
  let alive = true;
  const filesEl = h('div', { class: 'choose-files' });
  const busy = h('div', { class: 'choose-busy' }, linearProgress({ value: null, label: t('web_share_receiving') }));
  const tools = h('div', { class: 'choose-tools' });

  const leave = () => {
    clearSharedPdfs();
    closeAll();
    ctx.back();
  };

  ctx.root.append(
    topBar({ title: t('share_title'), onBack: leave }),
    h('div', { class: 'page', 'data-main': '' }, busy, filesEl, tools));

  const renderTools = (count) => {
    const sections = toolsForShared(count).map((s) => {
        const id = 'choose-section-' + s.id;
        return h('section', { 'aria-labelledby': id, dataset: { section: s.id } },
          h('h2', { class: 'home-section-heading', id }, t(s.heading)),
          h('div', { class: 'home-grid' }, s.tools.map((toolId) => card({
            icon: TOOLS[toolId].icon,
            title: t(TOOLS[toolId].title),
            detail: tWeb(TOOLS[toolId].detail),
            onClick: () => ctx.navigate('/tool/' + toolId, { files: getSharedPdfs(), from: '/choose' }),
          }))));
    });
    const hint = count > 1 ? [h('p', { class: 'choose-hint' }, t('share_several_hint'))] : [];
    tools.replaceChildren(...hint, ...sections);
  };

  const render = () => {
    const items = getSharedPdfs();
    filesEl.replaceChildren(...items.map((item) => {
      const source = opened.get(item);
      const pages = source ? tp('page_count', source.pageCount) : null;
      return fileCard({
        name: item.name,
        detail: pages ? t('result_details', pages, formatSize(item.size)) : formatSize(item.size),
        size: 'small',
        thumbnail: source ? source.thumbnail(0, 44).catch(() => null) : undefined,
        onRemove: () => {
          setSharedPdfs(getSharedPdfs().filter((x) => x !== item));
          closeSource(opened.get(item));
          opened.delete(item);
          // With no PDF left to choose a tool for, the screen goes.
          if (!getSharedPdfs().length) leave();
          else {
            render();
            filesEl.querySelector('button')?.focus();
          }
        },
      });
    }));
    renderTools(items.length);
  };

  // Each PDF is opened, its password asked for in turn; those that can't be are named and left out.
  const openAll = async () => {
    const waiting = getSharedPdfs().filter((item) => !opened.has(item));
    if (!waiting.length) return;
    busy.hidden = false;
    tools.hidden = true;
    const problems = [];
    const dropped = new Set();
    for (const item of waiting) {
      if (!alive) return;
      try {
        const source = await openPdf(item, item.password != null ? { password: item.password } : {});
        if (!source) dropped.add(item);
        else {
          opened.set(item, source);
          // The tool chosen opens it with the password given here.
          if (source.password) item.password = source.password;
        }
      } catch (error) {
        dropped.add(item);
        problems.push({ name: item.name, error });
      }
    }
    if (!alive) return;
    if (problems.length) reportFileProblems(problems);
    setSharedPdfs(getSharedPdfs().filter((item) => !dropped.has(item)));
    busy.hidden = true;
    tools.hidden = false;
    // None could be opened (or each password was cancelled): nothing to choose a tool for.
    if (!getSharedPdfs().length) {
      ctx.navigate('/', { replace: true });
      return;
    }
    render();
  };

  if (!getSharedPdfs().length) {
    // Nothing shared (the page was reloaded, say): Home instead.
    queueMicrotask(() => ctx.navigate('/', { replace: true }));
  } else {
    busy.hidden = true;
    render();
    openAll();
  }
  return {
    unmount() {
      alive = false;
    },
    hasUnsavedWork: () => false,
  };
}
