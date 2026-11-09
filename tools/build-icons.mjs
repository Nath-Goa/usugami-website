// Builds the web app's icons:
//   1. site/app/js/core/icons.js, Google's Material Icons (Round style, Apache-2.0) the app draws,
//      from node_modules/@material-design-icons/svg/round/. It holds every icon the Android app
//      uses, the web app's extras below, and every icon name found in site/app/js: icon('name'),
//      icon: 'name', iconName: 'name', placeholderIcon = 'name', and names chosen in an expression
//      such as icon(busy ? 'sync' : 'done'). Names the Material set lacks are listed when it runs.
//   2. site/app/icons/: the app icon (icon.svg, from the Android app's docs/icon.svg) as PNGs for
//      the manifest, home screens and browser tabs, rendered with Playwright.
//
//   node tools/build-icons.mjs                 both
//   node tools/build-icons.mjs --js            only icons.js
//   node tools/build-icons.mjs --png           only the PNGs
//   node tools/build-icons.mjs --android ../pdfer   also lists Android icons missing below
//
// Run it again after using a new icon in a screen (its name is picked up automatically).
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(root, 'node_modules', '@material-design-icons', 'svg');
const appJs = join(root, 'site', 'app', 'js');
const outJs = join(appJs, 'core', 'icons.js');
const outIcons = join(root, 'site', 'app', 'icons');

// Every icon the Android app uses (Icons.Rounded.X and Icons.AutoMirrored.Rounded.X in
// app/src/main/java, as Material snake_case names).
const ANDROID_ICONS = [
  'add', 'add_photo_alternate', 'arrow_back', 'arrow_downward', 'arrow_drop_down', 'arrow_forward',
  'arrow_right_alt', 'arrow_upward', 'auto_stories', 'border_color', 'branding_watermark', 'category',
  'check', 'check_circle', 'close', 'code', 'collections', 'compress', 'crop', 'crop_free',
  'crop_square', 'delete', 'delete_sweep', 'description', 'document_scanner', 'download', 'draw',
  'east', 'edit', 'edit_note', 'folder_open', 'folder_zip', 'format_list_numbered', 'gavel', 'gesture',
  'grid_view', 'horizontal_rule', 'info', 'language', 'layers', 'library_books', 'lock', 'more_vert',
  'north', 'note_add', 'open_in_new', 'panorama_fish_eye', 'photo_camera', 'photo_library',
  'picture_as_pdf', 'policy', 'redo', 'remove', 'remove_circle_outline', 'restart_alt', 'rotate_left',
  'rotate_right', 'save_as', 'search', 'share', 'slideshow', 'sort', 'south', 'splitscreen', 'square',
  'table_chart', 'text_fields', 'undo', 'visibility_off', 'west', 'brightness_medium',
  'keyboard_arrow_down',
];

// The Android app's Icons.Outlined ones, from the outlined set, by these names.
const OUTLINED = { settings_outline: 'settings', info_outline: 'info' };

// Icons that point a way, which turn round for right-to-left languages (Android's AutoMirrored).
const MIRRORED = [
  'arrow_back', 'arrow_forward', 'arrow_right_alt', 'open_in_new', 'undo', 'redo', 'rotate_left',
  'rotate_right', 'sort', 'note_add', 'library_books', 'branding_watermark', 'chevron_left',
  'chevron_right', 'navigate_before', 'navigate_next', 'first_page', 'last_page', 'keyboard_arrow_left',
  'keyboard_arrow_right', 'arrow_back_ios', 'arrow_forward_ios', 'send', 'launch', 'logout', 'login',
  'format_list_numbered', 'format_list_bulleted', 'short_text', 'wrap_text', 'notes', 'subject',
  'help', 'help_outline',
];

// More the web app's screens may need (desktop, files, editing), on top of those found in its code.
const WEB_ICONS = [
  'settings', 'clear', 'more_horiz', 'menu', 'done', 'done_all', 'delete_outline', 'file_download',
  'upload', 'upload_file', 'file_upload', 'save', 'save_alt', 'folder', 'image', 'photo',
  'insert_drive_file', 'post_add', 'attach_file', 'drag_indicator', 'drag_handle', 'swap_vert',
  'swap_horiz', 'unfold_more', 'expand_more', 'expand_less', 'chevron_left', 'chevron_right',
  'navigate_before', 'navigate_next', 'first_page', 'last_page', 'keyboard_arrow_up',
  'keyboard_arrow_down', 'keyboard_arrow_left', 'keyboard_arrow_right', 'zoom_in', 'zoom_out',
  'fullscreen', 'fullscreen_exit', 'open_in_full', 'link', 'content_copy', 'content_paste',
  'select_all', 'deselect', 'check_box', 'check_box_outline_blank', 'indeterminate_check_box',
  'radio_button_checked', 'radio_button_unchecked', 'cancel', 'error', 'error_outline', 'warning',
  'help', 'help_outline', 'lock_open', 'key', 'password', 'visibility', 'refresh', 'history',
  'schedule', 'rotate_90_degrees_ccw', 'rotate_90_degrees_cw', 'flip', 'crop_rotate', 'straighten',
  'tune', 'contrast', 'brightness_6', 'auto_fix_high', 'filter_b_and_w', 'invert_colors', 'palette',
  'brush', 'highlight', 'title', 'format_bold', 'format_italic', 'format_underlined', 'format_size',
  'format_color_text', 'format_align_left', 'format_align_center', 'format_align_right',
  'format_list_bulleted', 'water_drop', 'opacity', 'line_weight', 'circle', 'rectangle', 'interests',
  'view_list', 'view_module', 'translate', 'dark_mode', 'light_mode', 'brightness_auto', 'privacy_tip',
  'android', 'install_mobile', 'install_desktop', 'get_app', 'smartphone', 'computer', 'cloud_off',
  'wifi_off', 'storage', 'print', 'mail', 'send', 'sort_by_alpha', 'filter_list', 'add_circle_outline',
  'add_circle', 'remove_circle', 'block', 'hourglass_empty', 'sync', 'keyboard', 'pan_tool',
  'touch_app', 'numbers', 'tag', 'lightbulb', 'shield', 'article', 'notes', 'short_text', 'wrap_text',
  'text_snippet', 'comment', 'clear_all', 'filter_none', 'auto_awesome', 'aspect_ratio', 'fit_screen',
  'zoom_out_map', 'vertical_align_top', 'vertical_align_bottom', 'vertical_align_center',
  'align_horizontal_left', 'align_horizontal_center', 'align_horizontal_right', 'border_outer',
  'grid_on', 'font_download', 'arrow_back_ios', 'arrow_forward_ios', 'arrow_drop_up', 'launch',
  'description', 'subject', 'feedback', 'pending', 'library_add', 'playlist_add', 'move_down',
  'move_up', 'vertical_split', 'call_split', 'merge', 'flip_to_front', 'layers_clear',
];

const args = process.argv.slice(2);
const only = args.includes('--js') ? 'js' : args.includes('--png') ? 'png' : null;

// A name given straight to an icon: icon('x'), icon: 'x', iconName: 'x', placeholderIcon = 'x'.
const NAMED = /\b\w*[iI]con\w*(?:\(\s*|\s*[:=]\s*)['"`]([a-z0-9_]+)['"`]/g;
// Names chosen in an expression given to one: icon(kind === 'network' ? 'cloud_off' : 'error_outline'),
// icon: busy ? 'sync' : 'done'. Only names in the Material set count from these.
const CHOSEN = /\b\w*[iI]con\w*\s*(?:\(|:|=(?!=)|\?\?|\|\|)([^,;\n]*)/g;
const QUOTED = /['"`]([a-z0-9_]+)['"`]/g;

/**
 * Names used in the web app's code: `named` are given straight to an icon (reported when the
 * Material set lacks them), `chosen` appear in an expression given to one.
 */
async function namesInCode(dir) {
  const named = new Set();
  const chosen = new Set();
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!['lib', 'vendor'].includes(entry.name)) await walk(p);
      } else if (entry.name.endsWith('.js') && p !== outJs) {
        const text = await readFile(p, 'utf8');
        for (const m of text.matchAll(NAMED)) named.add(m[1]);
        for (const m of text.matchAll(CHOSEN)) {
          for (const q of m[1].matchAll(QUOTED)) chosen.add(q[1]);
        }
      }
    }
  };
  if (existsSync(dir)) await walk(dir);
  return { named, chosen };
}

/** The version of @material-design-icons/svg the icons come from. */
async function iconPackageVersion() {
  try {
    return JSON.parse(await readFile(join(iconDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** The Android app's icons as snake_case names, from its Kotlin sources (read only). */
async function namesInAndroid(appRoot) {
  const found = new Set();
  const src = join(appRoot, 'app', 'src', 'main', 'java');
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith('.kt')) {
        const text = await readFile(p, 'utf8');
        for (const m of text.matchAll(/Icons\.(?:AutoMirrored\.)?Rounded\.([A-Za-z0-9]+)/g)) {
          found.add(m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase());
        }
      }
    }
  };
  await walk(src);
  return found;
}

/** The inside of an icon's <svg>, ready to put in one of our own. */
async function inner(style, name) {
  const file = join(iconDir, style, name + '.svg');
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const m = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return m ? m[1].trim() : null;
}

async function buildJs() {
  const androidArg = args.indexOf('--android');
  if (androidArg >= 0) {
    const android = await namesInAndroid(args[androidArg + 1]);
    const missing = [...android].filter((n) => !ANDROID_ICONS.includes(n));
    console.log(missing.length ? `Android icons not listed yet: ${missing.join(', ')}` : 'Every Android icon is listed.');
  }
  const fromCode = await namesInCode(appJs);
  const version = await iconPackageVersion();
  const names = new Set([...ANDROID_ICONS, ...WEB_ICONS, ...fromCode.named]);
  const icons = {};
  const unknown = [];
  for (const name of [...names].sort()) {
    const body = await inner('round', name);
    if (body) icons[name] = body;
    else if (!(name in OUTLINED)) unknown.push(name);
  }
  // Names in expressions: those that are icons (other words, such as 'network', are passed over).
  for (const name of [...fromCode.chosen].sort()) {
    if (icons[name] || name in OUTLINED) continue;
    const body = await inner('round', name);
    if (body) icons[name] = body;
  }
  for (const [name, source] of Object.entries(OUTLINED)) {
    const body = await inner('outlined', source);
    if (body) icons[name] = body;
    else unknown.push(name);
  }
  for (const name of ANDROID_ICONS) {
    if (!icons[name]) throw new Error(`The Android app's icon "${name}" isn't in @material-design-icons/svg/round`);
  }
  const mirrored = MIRRORED.filter((n) => icons[n]).sort();
  const lines = Object.keys(icons).sort().map((n) => `  ${n}: '${icons[n].replace(/'/g, "\\'")}',`);
  const js = `// Generated by tools/build-icons.mjs: do not edit. To add an icon, use it (icon('name')) and run
//   node tools/build-icons.mjs --js
// Unknown names draw a neutral placeholder, so a screen still works before the icon is added.
//
// The icons are Google's Material Icons (https://github.com/google/material-design-icons), Round
// style (settings_outline and info_outline: Outlined style), from the npm package
// @material-design-icons/svg${version ? ' ' + version : ''} (https://github.com/marella/material-design-icons).
// Copyright Google LLC. Licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0); see THIRD_PARTY_NOTICES.md.
import { getDirection } from './i18n.js';

/** Where the icons come from, for the Open-source licenses screen. */
export const ICON_SET = Object.freeze({
  name: 'Material Icons',
  style: 'Round',
  package: '@material-design-icons/svg',
  version: ${version ? `'${version}'` : 'null'},
  license: 'Apache-2.0',
  copyright: 'Copyright Google LLC',
});

/** Each icon's drawing: the inside of a 24 x 24 <svg>. */
const ICONS = {
${lines.join('\n')}
};

/** Icons that point a way: drawn turned round for right-to-left languages. */
const MIRRORED = new Set(${JSON.stringify(mirrored)});

// A rounded square outline, for a name that isn't in the set.
const PLACEHOLDER = '<rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>';
const warned = new Set();

/** Whether \`name\` is in the set. */
export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** The names of every icon in the set. */
export function iconNames() {
  return Object.keys(ICONS);
}

/**
 * An inline <svg> of the Material icon \`name\` (such as 'arrow_back', 'more_vert', 'share'), in the
 * text color (currentColor). Hidden from screen readers unless \`label\` is given, which names it.
 * Icons that point a way are turned round for right-to-left languages.
 * @example button.append(icon('share'));  icon('lock', { size: 18, label: t('locked') })
 * @param {string} name
 * @param {{ size?: number, label?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 24, label } = {}) {
  let body = ICONS[name];
  if (body === undefined) {
    body = PLACEHOLDER;
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(\`Icon "\${name}" isn't in core/icons.js yet: run node tools/build-icons.mjs --js\`);
    }
  }
  const template = document.createElement('template');
  template.innerHTML = \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="\${size}" height="\${size}" fill="currentColor">\${body}</svg>\`;
  const svg = template.content.firstChild;
  svg.setAttribute('class', 'icon');
  svg.dataset.icon = name;
  svg.setAttribute('focusable', 'false');
  if (MIRRORED.has(name)) {
    svg.classList.add('icon-mirrored');
    if (getDirection() === 'rtl') svg.style.transform = 'scaleX(-1)';
  }
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  return svg;
}
`;
  await writeFile(outJs, js);
  console.log(`Wrote ${relative(root, outJs)}: ${Object.keys(icons).length} icons, ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB.`);
  if (unknown.length) console.log(`Not in the Material set (drawn as a placeholder): ${unknown.join(', ')}`);
}

/** The app icon at 108 x 108, as Android's adaptive icon: art inside a 66-unit safe circle. */
function artSvg(source) {
  const g = source.match(/<g[\s\S]*<\/g>/)[0];
  return g;
}

async function buildPngs() {
  const { chromium } = await import('playwright');
  await mkdir(outIcons, { recursive: true });
  const androidIcon = join(root, '..', 'pdfer', 'docs', 'icon.svg');
  const iconSvgPath = join(outIcons, 'icon.svg');
  // icon.svg is copied from the Android app once; later runs use the copy.
  if (!existsSync(iconSvgPath)) {
    if (!existsSync(androidIcon)) throw new Error('Put the app icon at site/app/icons/icon.svg (the Android app\'s docs/icon.svg).');
    await writeFile(iconSvgPath, await readFile(androidIcon, 'utf8'));
  }
  const source = await readFile(iconSvgPath, 'utf8');
  const background = source.match(/<circle[^>]*fill="(#[0-9A-Fa-f]{6})"/)[1];
  const art = artSvg(source);
  // A square of the brand colour with the art in the middle: for maskable icons (the art keeps
  // inside the middle 80% circle every launcher shape leaves) and iOS, which rounds the corners.
  const square = (viewBox) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect x="-100" y="-100" width="400" height="400" fill="${background}"/>${art}</svg>`;
  const outputs = [
    { file: 'icon-192.png', size: 192, svg: source, transparent: true },
    { file: 'icon-512.png', size: 512, svg: source, transparent: true },
    { file: 'favicon-32.png', size: 32, svg: source, transparent: true },
    { file: 'icon-maskable-512.png', size: 512, svg: square('0 0 108 108') },
    { file: 'apple-touch-icon.png', size: 180, svg: square('12 12 84 84') },
  ];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const o of outputs) {
      await page.setViewportSize({ width: o.size, height: o.size });
      const data = 'data:image/svg+xml;base64,' + Buffer.from(o.svg).toString('base64');
      await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${o.size}px;height:${o.size}px}</style><img src="${data}">`);
      await page.waitForFunction(() => document.images[0].complete);
      await page.screenshot({ path: join(outIcons, o.file), omitBackground: !!o.transparent, clip: { x: 0, y: 0, width: o.size, height: o.size } });
      console.log(`Wrote ${relative(root, join(outIcons, o.file))}`);
    }
  } finally {
    await browser.close();
  }
}

if (only !== 'png') await buildJs();
if (only !== 'js') await buildPngs();
