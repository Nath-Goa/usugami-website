// Moving between screens with the address's hash: #/ (Home), #/tool/<id>, #/recent, #/settings,
// #/settings/about, #/settings/about/licenses, #/choose (Choose a tool) and #/language (the first
// launch's language choice). Each screen is a module whose mount(ctx) renders into ctx.root, loaded
// when first shown. The browser's Back goes back as the app's back arrow does, and asks first when
// the screen has unsaved work; with a dialog or menu open it closes that instead, as Android's Back.
import { TOOLS } from './tools.js';
import { h } from './dom.js';
import { t, onLanguageChange } from './i18n.js';
import { icon } from './icons.js';

const jsBase = new URL('../', import.meta.url);

/** The app's own screens: route name → module (relative to js/) and depth (for the slide's way). */
const SCREENS = {
  home: { module: 'screens/home.js', depth: 0 },
  recent: { module: 'screens/recent.js', depth: 1 },
  settings: { module: 'screens/settings.js', depth: 1 },
  about: { module: 'screens/about.js', depth: 2 },
  licenses: { module: 'screens/licenses.js', depth: 3 },
  choose: { module: 'screens/choose.js', depth: 1 },
  language: { module: 'screens/language.js', depth: 0 },
};

const PATHS = {
  '/': 'home',
  '/recent': 'recent',
  '/settings': 'settings',
  '/settings/about': 'about',
  '/settings/about/licenses': 'licenses',
  '/choose': 'choose',
  '/language': 'language',
};

let container = null;
/** The screen showing. */
let current = null;
let navToken = 0;
/** Home's scroll position when it was left, restored when it shows again. */
let homeScroll = null;
/** Set when the user already agreed to leave, so the Back that follows doesn't ask again. */
let skipGuardOnce = false;
/** A history change is being answered (the discard question): others wait their turn. */
let asking = false;
/** The history entry (state and address) of the screen and step showing, put back when a Back only closes something. */
let shownState = null;
let shownUrl = '';
/** Set while the router moves through history itself, so that move isn't taken for the user's Back. */
let ownMove = false;
let ownMoveTimer = 0;
/** A screen to show once the history has gone back over the steps of the one it replaces. */
let pendingReplace = null;
const routeListeners = new Set();

/**
 * Splits '/tool/split?x=1' into its route: { path, name, id?, query }, or null for an address the
 * app has no screen for.
 * @param {string} path
 */
export function parsePath(path) {
  const [rawPath, rawQuery = ''] = String(path || '/').replace(/^#/, '').split('?');
  let p = '/' + rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const query = Object.fromEntries(new URLSearchParams(rawQuery));
  if (p in PATHS) return { path: p, name: PATHS[p], query };
  const m = p.match(/^\/tool\/([a-z0-9-]+)$/);
  if (m && Object.prototype.hasOwnProperty.call(TOOLS, m[1])) return { path: p, name: 'tool', id: m[1], query };
  return null;
}

function hashPath() {
  return decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
}

/** Where the app's back arrow leads from `route` when there is no page of the app to go back to. */
function parentOf(route, from) {
  if (route.name === 'tool') return from === '/choose' ? '/choose' : '/';
  if (route.name === 'licenses') return '/settings/about';
  if (route.name === 'about') return '/settings';
  if (route.name === 'home' || route.name === 'language') return null;
  return '/';
}

function moduleUrl(route) {
  const rel = route.name === 'tool' ? TOOLS[route.id].module : SCREENS[route.name].module;
  return new URL(rel, jsBase).href;
}

function depthOf(route, from) {
  if (route.name === 'tool') return from === '/choose' ? 2 : 1;
  return SCREENS[route.name].depth;
}

function hasUnsavedWork() {
  try {
    return !!current?.handle?.hasUnsavedWork?.();
  } catch {
    return false;
  }
}

/**
 * The screen's own wording of the discard question (handle.discardQuestion(): { title, message?,
 * confirm?, dismiss? }), or null for the generic one.
 */
function ownDiscardQuestion() {
  try {
    const question = current?.handle?.discardQuestion?.();
    return question && typeof question === 'object' && question.title ? question : null;
  } catch {
    return null;
  }
}

/**
 * Asks whether to discard the screen's unsaved work, as the app does when leaving a tool: the
 * screen's own question when it has one (Images to PDF's "Discard these images?"), else
 * "Discard your changes?".
 */
async function askDiscard() {
  const own = ownDiscardQuestion();
  const ui = await import('./ui.js');
  return !!(await ui.alertDialog({
    title: own?.title ?? t('tool_discard_title'),
    ...(own?.message ? { message: own.message } : {}),
    confirm: own?.confirm ?? t('discard'),
    dismiss: own?.dismiss ?? t('keep'),
    // A screen's own question may ask with plain buttons (Images to PDF's "Discard these images?").
    destructive: own?.destructive ?? true,
  }));
}

/** Notes the history entry showing now, to put it back after a Back that only closes something. */
function noteEntry() {
  shownState = history.state;
  shownUrl = location.href;
}

/** Whether the address and history entry are still the ones showing (an echo of our own change). */
function atShownEntry() {
  return location.href === shownUrl && (history.state?.idx ?? 0) === (shownState?.idx ?? 0)
    && (history.state?.step ?? null) === (shownState?.step ?? null);
}

/** Marks the next history move as the router's own (Back over steps, after Discard...). */
function moveOwn(fn) {
  ownMove = true;
  clearTimeout(ownMoveTimer);
  // In case the move doesn't happen (nothing to go back to), the mark doesn't stay.
  ownMoveTimer = setTimeout(() => { ownMove = false; }, 2000);
  fn();
}

/**
 * Puts the entry showing back after the browser's Back or Forward moved away from it while it
 * must stay (a dialog or menu was closed instead, or a question is being asked).
 */
function restoreEntry(state) {
  const from = state?.idx ?? 0;
  const to = shownState?.idx ?? 0;
  if (shownState && from > to) {
    // Forward: back again to it.
    moveOwn(() => history.go(to - from));
  } else {
    history.pushState(shownState ?? { usugami: 1, idx: current?.idx ?? 0 }, '', shownUrl || location.href);
  }
}

/** Closes the kit's popup menu showing, if any (it goes with the screen it was opened on). */
function closeMenu() {
  const scrim = document.querySelector('.ui-menu-scrim');
  if (!scrim) return false;
  // The kit's menu closes on a press on its scrim.
  try {
    scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  } catch {
    scrim.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  }
  // One that didn't close goes anyway.
  if (scrim.isConnected) {
    scrim.remove();
    for (const m of document.querySelectorAll('.ui-menu')) m.remove();
  }
  return true;
}

const closing = (d) => d.classList.contains('is-closing') || !d.open || !d.isConnected;

/**
 * Closes the popup menu or the topmost dialog showing, as Android's Back does before it leaves a
 * screen: a dialog is dismissed as its Cancel or Keep would. Returns true when one closed; a
 * dialog that can't be dismissed (the progress of work under way) stays, and Back goes on as
 * without it.
 */
function closeTopOverlay() {
  if (closeMenu()) return true;
  const open = Array.from(document.querySelectorAll('dialog[open]')).filter((d) => !closing(d));
  const top = open[open.length - 1];
  if (!top) return false;
  // Kit dialogs (and the signature pad) answer 'cancel' as Escape does.
  top.dispatchEvent(new Event('cancel', { cancelable: true }));
  return closing(top);
}

function emitRouteChange() {
  const route = currentRoute();
  for (const fn of routeListeners) {
    try {
      fn(route);
    } catch (e) {
      setTimeout(() => { throw e; });
    }
  }
}

/**
 * The screen showing: { path, name, id (tools), params, step, from }, or null before the first.
 */
export function currentRoute() {
  if (!current) return null;
  return { path: current.path, name: current.route.name, id: current.route.id, params: current.params, step: current.step, from: current.from };
}

/** The handle the screen showing returned from mount(), or null while it is still loading. */
export function currentHandle() {
  return current?.handle ?? null;
}

/**
 * Calls `fn(route)` each time a new screen starts showing. Returns an unsubscribe function.
 * @param {(route: ReturnType<typeof currentRoute>) => void} fn
 */
export function onRouteChange(fn) {
  routeListeners.add(fn);
  return () => routeListeners.delete(fn);
}

function focusHeading(root) {
  const heading = root.querySelector('h1') ?? root.querySelector('h2, [role="heading"]');
  const target = heading ?? root;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}

/** A screen of the shell's own for a tool that couldn't be opened, with a way back. */
function showProblem(root, route, kind) {
  const name = route.name === 'tool' ? t(TOOLS[route.id].title) : t('home_title');
  const key = { missing: 'web_tool_unavailable', network: 'web_tool_load_failed', crash: 'web_tool_crashed' }[kind];
  root.replaceChildren(
    h('header', { class: 'shell-bar' },
      h('button', { type: 'button', class: 'shell-icon-button', 'aria-label': t('back'), onClick: () => back() }, icon('arrow_back')),
      h('h1', { class: 'shell-bar-title' }, name)),
    h('main', { 'data-main': '' },
      h('div', { class: 'shell-problem', role: 'alert' },
        icon(kind === 'network' ? 'cloud_off' : 'error_outline', { size: 48 }),
        h('p', null, t(key, name)),
        h('div', { class: 'shell-problem-actions' },
          kind === 'missing' ? null : h('button', { type: 'button', class: 'shell-button shell-button-filled', onClick: () => navigate(route.path + queryString(route.query), { force: true }) }, t('web_try_again')),
          h('button', { type: 'button', class: 'shell-button shell-button-outlined', onClick: () => navigate('/', { replace: true }) }, t('web_go_home'))))),
  );
  markMain(root);
  setTitle(route, root);
}

/**
 * Makes the screen's content its main landmark: the element marked data-main gets role=main when
 * the screen has no <main>, and id="content" (where the skip link leads) when it has no id.
 */
function markMain(root) {
  let main = root.querySelector('main, [role="main"]');
  if (!main) {
    main = root.querySelector('[data-main]');
    main?.setAttribute('role', 'main');
  }
  if (main && !main.id && !document.getElementById('content')) main.id = 'content';
}

/** The tab's title: the screen's name and Usugami ("Merge PDF – Usugami"); just Usugami on Home. */
function setTitle(route, root) {
  let name = null;
  if (route.name === 'tool') name = t(TOOLS[route.id].title);
  else if (route.name !== 'home') name = root?.querySelector('h1')?.textContent?.trim() || null;
  document.title = name ? t('web_page_title', name) : t('app_name');
}

function queryString(query) {
  const q = new URLSearchParams(query ?? {}).toString();
  return q ? '?' + q : '';
}

/** Why a module couldn't be imported: it isn't there, the network failed, or it broke. */
async function whyNotLoaded(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.status === 404 ? 'missing' : (res.ok ? 'crash' : 'network');
  } catch {
    return 'network';
  }
}

/** Shows the screen for `path`, unmounting the one before. */
async function show(path, state, { files = null, params = null, initial = false } = {}) {
  const token = ++navToken;
  let route = parsePath(path);
  if (!route) {
    // An address the app has no screen for: Home instead.
    const home = { usugami: 1, idx: state?.idx ?? 0 };
    history.replaceState(home, '', location.pathname + location.search + '#/');
    route = parsePath('/');
    state = home;
  }
  const from = state?.from ?? null;
  const depth = depthOf(route, from);
  const prev = current;
  // A menu opened on the screen being left goes with it.
  closeMenu();
  noteEntry();
  if (prev) {
    if (prev.route.name === 'home') homeScroll = window.scrollY;
    try {
      prev.handle?.unmount?.();
    } catch (e) {
      setTimeout(() => { throw e; });
    }
  }
  const forward = !prev || depth >= prev.depth;
  // Busy until mounted, so assistive technology waits for the screen to be complete.
  const root = h('div', {
    class: ['screen', initial ? null : (forward ? 'screen-forward' : 'screen-back')],
    dataset: { route: route.name, ...(route.id ? { tool: route.id } : {}) },
    'aria-busy': 'true',
  });
  const progress = h('div', { class: 'route-progress', role: 'progressbar', 'aria-hidden': 'true' });
  container.replaceChildren(root, progress);
  const tool = route.name === 'tool' ? TOOLS[route.id] : null;
  const allParams = { ...(tool?.params ?? {}), ...route.query, ...(params ?? {}) };
  current = {
    path: route.path, route, root, handle: null, depth, idx: state?.idx ?? 0, step: state?.step ?? null, from, params: allParams, token,
    // Whether it was handed files, which drawing it again (in a new language) would lose.
    hadFiles: !!files?.length,
  };
  emitRouteChange();

  const url = moduleUrl(route);
  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    if (token !== navToken) return;
    progress.remove();
    const why = await whyNotLoaded(url);
    if (token !== navToken) return;
    if (why === 'crash') console.error(e);
    root.removeAttribute('aria-busy');
    showProblem(root, route, why);
    focusHeading(root);
    return;
  }
  if (token !== navToken) return;
  const ctx = {
    root,
    tool,
    params: allParams,
    files: files ?? null,
    back,
    navigate,
    step: current.step,
    from,
    pushStep,
    popStep,
  };
  let handle;
  try {
    handle = (await mod.mount(ctx)) ?? {};
  } catch (e) {
    if (token !== navToken) return;
    progress.remove();
    console.error(e);
    root.removeAttribute('aria-busy');
    showProblem(root, route, 'crash');
    focusHeading(root);
    return;
  }
  if (token !== navToken) {
    try {
      handle.unmount?.();
    } catch {
      // It is gone either way.
    }
    return;
  }
  progress.remove();
  root.removeAttribute('aria-busy');
  current.handle = handle;
  markMain(root);
  setTitle(route, root);
  if (route.name === 'home' && homeScroll != null) window.scrollTo(0, homeScroll);
  else if (!initial) window.scrollTo(0, 0);
  // Coming back, a screen may put the focus where it was (Home: the card of the tool left).
  let focused = false;
  if (!forward && typeof handle.restoreFocus === 'function') {
    try {
      focused = !!handle.restoreFocus();
    } catch {
      focused = false;
    }
  }
  if (!focused) focusHeading(root);
}

/**
 * Shows the screen for `path` ('/', '/tool/<id>', '/recent', '/settings', '/settings/about',
 * '/choose'). `files` (FileItem[]) and `params` go to the screen's mount(ctx). `replace` swaps
 * the current history entry instead of adding one; `from` is where the back arrow leads when
 * there is no page to go back to (a tool opened from Choose a tool passes '/choose'); `force`
 * shows the screen again even when it is showing already. It doesn't ask about unsaved work:
 * callers that leave a tool on their own decide that. `replaceScreen` opens it in place of the
 * screen showing (unless that is Home), as the app opens files shared to it: that screen's steps
 * and its own history entry go, so Back then leads where Back from that screen would have (Home,
 * in the usual flow).
 * @example navigate('/tool/scan', { files })
 * @param {string} path
 * @param {{ files?: object[], params?: object, replace?: boolean, from?: string, force?: boolean, replaceScreen?: boolean }} [options]
 * @returns {Promise<void>} resolves once the screen has mounted
 */
export function navigate(path, { files, params, replace = false, from, force = false, replaceScreen = false } = {}) {
  const route = parsePath(path);
  const target = route ? route.path + queryString(route.query) : '/';
  if (!container) {
    location.hash = '#' + target;
    return Promise.resolve();
  }
  if (replaceScreen && current && current.route.name !== 'home') {
    const steps = history.state?.stepDepth ?? 0;
    const go = () => navigate(path, { files, params, replace: true, from, force: true });
    if (steps <= 0) return go();
    // Back over the screen's steps first; the screen's own entry is replaced once there.
    return new Promise((resolve) => {
      const run = () => go().then(resolve);
      pendingReplace = run;
      moveOwn(() => history.go(-steps));
      // Should the history not move (nothing there to go back to), the screen is replaced anyway.
      setTimeout(() => {
        if (pendingReplace !== run) return;
        pendingReplace = null;
        run();
      }, 1000);
    });
  }
  const same = current && route && route.path === current.path;
  if (same && !files && !params && !force && !from) return Promise.resolve();
  const idx = history.state?.idx ?? 0;
  const state = { usugami: 1, idx: replace || same ? idx : idx + 1 };
  if (from) state.from = from;
  else if (same && current.from) state.from = current.from;
  const url = location.pathname + location.search + '#' + target;
  if (replace || same) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  return show(target, state, { files, params });
}

/** Goes to the previous page of the app, or else up to the screen's parent. */
function goBack() {
  const state = history.state ?? {};
  const steps = state.stepDepth ?? 0;
  const parent = current ? parentOf(current.route, current.from) : '/';
  if ((state.idx ?? 0) - steps > 0) {
    moveOwn(() => history.go(-(steps + 1)));
  } else if (parent) {
    skipGuardOnce = false;
    navigate(parent, { replace: true });
  }
}

/**
 * Leaves the screen showing, like the app's back arrow and Android's Back: to the screen it came
 * from. Asks first ("Discard your changes?") when the screen's hasUnsavedWork() is true.
 * @returns {Promise<void>}
 */
export async function back() {
  if (asking) return;
  if (hasUnsavedWork()) {
    asking = true;
    let ok = false;
    try {
      ok = await askDiscard();
    } finally {
      asking = false;
    }
    if (!ok) return;
    skipGuardOnce = true;
  }
  goBack();
}

/**
 * Adds a history entry for an inner step of the screen showing (a tool's result screen, Home's
 * search), so the browser's Back returns to the step before: the router then calls the handle's
 * onStep(step) with the step now showing (null for the screen's first).
 * @param {string} step
 */
export function pushStep(step) {
  if (!current) return;
  const state = history.state ?? { usugami: 1, idx: 0 };
  const next = { ...state, usugami: 1, idx: (state.idx ?? 0) + 1, step, stepDepth: (state.stepDepth ?? 0) + 1 };
  history.pushState(next, '', location.href);
  current.step = step;
  current.idx = next.idx;
  noteEntry();
}

/** Goes back one step of the screen showing (as Back would), if it is on a step. */
export function popStep() {
  if (current?.step != null && (history.state?.stepDepth ?? 0) > 0) moveOwn(() => history.back());
}

/** Answers the browser's Back and Forward, and addresses typed or followed by a link. */
async function onLocationChange() {
  if (!container) return;
  // The router's own move. (The hashchange that may follow its popstate finds the new screen's
  // entry noted already, and does nothing.)
  const own = ownMove;
  ownMove = false;
  clearTimeout(ownMoveTimer);
  if (pendingReplace) {
    // Back over a replaced screen's steps is done: the new screen takes its entry.
    const run = pendingReplace;
    pendingReplace = null;
    run();
    return;
  }
  const path = hashPath();
  let state = history.state;
  if (!state?.usugami) {
    // A link or a typed address: a new page of the app.
    state = { usugami: 1, idx: (current?.idx ?? 0) + 1 };
    history.replaceState(state, '', location.href);
  }
  if (current && !own && !atShownEntry() && (closeTopOverlay() || asking)) {
    // As Android's Back: a menu or dialog showing closes first, and the screen stays; while the
    // question about unsaved work is being asked, Back answers Keep.
    restoreEntry(state);
    return;
  }
  const route = parsePath(path);
  if (current && route && route.path === current.path && (state.from ?? null) === (current.from ?? null)) {
    // The same screen, on another of its steps.
    const step = state.step ?? null;
    current.idx = state.idx ?? current.idx;
    noteEntry();
    if (step !== current.step) {
      current.step = step;
      try {
        current.handle?.onStep?.(step);
      } catch (e) {
        setTimeout(() => { throw e; });
      }
    }
    return;
  }
  if (asking) return;
  if (!skipGuardOnce && hasUnsavedWork()) {
    // Back to the screen being left, then ask: discarding goes back again.
    const forward = (state.idx ?? 0) > (shownState?.idx ?? 0);
    restoreEntry(state);
    asking = true;
    let ok = false;
    try {
      ok = await askDiscard();
    } finally {
      asking = false;
    }
    if (ok) {
      skipGuardOnce = true;
      moveOwn(() => history.go(forward ? (state.idx ?? 0) - (shownState?.idx ?? 0) : -1));
    }
    return;
  }
  skipGuardOnce = false;
  await show(path, state);
}

/**
 * Starts routing in `el`: shows the screen the address names (Home when none) and answers the
 * browser's Back and Forward from then on.
 * @param {HTMLElement} el
 */
export function startRouter(el) {
  container = el;
  if (!history.state?.usugami) history.replaceState({ usugami: 1, idx: 0 }, '', location.href);
  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedWork()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // A new language draws the screen again in it, unless that would lose work (Edit PDF's items
  // and undo, files handed over): such a screen keeps its words, and the language applies when a
  // screen is next mounted.
  onLanguageChange(() => {
    if (!current || current.hadFiles || hasUnsavedWork()) return;
    show(current.path + queryString(current.route.query), history.state, { initial: true, params: current.params });
  });
  return show(hashPath(), history.state, { initial: true });
}
