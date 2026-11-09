// An EPUB's package: a port of the app's EpubBook.kt. What the package file (OPF) says (title,
// author, language, reading order, cover, navigation), whether the book has DRM, and its table of
// contents from the EPUB 3 navigation document or the EPUB 2 NCX file. The zip is a ZipArchive
// (zip.js), only read, never extracted; its names are found as written (a leading "/" aside) or
// ignoring case, as books made on Windows sometimes link with the wrong case.
import { OfficeNotRecognized, OfficeNothingToConvert, EpubProtected } from './problems.js';
import { EpubPaths, EpubProtection, HtmlText, ktTrim } from './epub-formats.js';
import { LenientXml, XmlReadError, START_TAG, END_TAG, TEXT, END_DOCUMENT } from './epub-xml.js';

const CONTAINER = 'META-INF/container.xml';
const DOCUMENT_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/xml', 'text/xml']);
const HTML_NAME = /\.x?html?$/i;

/** Cancelling goes on up; other problems were the file's. */
export function rethrowCancel(e) {
  if (e?.name === 'CancelledError') throw e;
}

/** The bytes of `path` in `zip`, or null when it's missing or can't be read (a damaged entry, say). */
export async function readEntry(zip, path, options = {}) {
  try {
    return await zip.bytes(path, options);
  } catch (e) {
    rethrowCancel(e);
    return null;
  }
}

/** An entry of the book's table of contents, pointing at a file in the book and maybe a place in it. */
export class TocEntry {
  constructor(title, path, fragment, children) {
    this.title = title;
    this.path = path;
    this.fragment = fragment;
    this.children = children;
  }
}

/**
 * A document in the book's reading order. `linear` is false for ones read only when linked to, such
 * as notes; `fixed` is true for one drawn as a single page at a fixed size, as in comics and picture
 * books.
 */
export class SpineItem {
  constructor(path, mediaType, linear, fixed) {
    this.path = path;
    this.mediaType = mediaType;
    this.linear = linear;
    this.fixed = fixed;
  }
}

const clean = (title) => ktTrim(HtmlText.collapse(title, true));

/** What the book's package file (OPF) says: its title, reading order, cover and table of contents. */
export class EpubBook {
  constructor(title, creator, language, spine, coverImage, navPath, ncxPath) {
    this.title = title;
    this.creator = creator;
    this.language = language;
    this.spine = spine;
    this.coverImage = coverImage;
    this.navPath = navPath;
    this.ncxPath = ncxPath;
  }

  /**
   * The table of contents (TocEntry[]): from the EPUB 3 navigation document, else the EPUB 2 NCX
   * file. Empty when the book has neither, or they can't be read.
   */
  async toc(zip, check) {
    let nav = null;
    if (this.navPath) {
      try {
        nav = await readNav(zip, this.navPath, check);
      } catch (e) {
        rethrowCancel(e);
      }
    }
    if (nav?.length) return nav;
    if (!this.ncxPath) return [];
    try {
      return await readNcx(zip, this.ncxPath, check);
    } catch (e) {
      rethrowCancel(e);
      return [];
    }
  }

  /**
   * Reads the book's package from `zip` (a ZipArchive). Throws EpubProtected for a book with DRM,
   * OfficeNotRecognized for a file that isn't an EPUB, and OfficeNothingToConvert for one with
   * nothing to show. `check()` throws to cancel.
   */
  static async read(zip, check = () => {}) {
    if (await isProtected(zip, check)) throw new EpubProtected();
    const opf = await packagePath(zip, check);
    if (!opf) throw new OfficeNotRecognized();
    return readPackage(zip, opf, check);
  }
}

async function isProtected(zip, check) {
  // Adobe's DRM keeps its licence in rights.xml; Readium LCP in license.lcpl.
  const rights = zip.has('META-INF/rights.xml') || zip.has('META-INF/license.lcpl');
  const algorithms = [];
  // An entry that can't be inflated at all is a damaged book: that error goes on up.
  const bytes = await zip.bytes('META-INF/encryption.xml');
  if (bytes) {
    try {
      const p = new LenientXml(bytes);
      let events = 0;
      for (;;) {
        if (++events % 512 === 0) check();
        const type = p.next();
        if (type === START_TAG && p.localName() === 'EncryptionMethod') algorithms.push(p.attr('Algorithm') ?? '');
        else if (type === END_DOCUMENT) break;
      }
    } catch (e) {
      rethrowCancel(e);
      // An encryption file that can't be read: assume the worst rather than print gibberish.
      algorithms.push('unreadable');
    }
  }
  return EpubProtection.isProtected(rights, algorithms);
}

/** Where the package file is, from META-INF/container.xml (or the first .opf file, in books without one). */
async function packagePath(zip, check) {
  let fromContainer = null;
  const bytes = await zip.bytes(CONTAINER);
  if (bytes) {
    try {
      const p = new LenientXml(bytes);
      let events = 0;
      while (fromContainer == null) {
        if (++events % 512 === 0) check();
        const type = p.next();
        if (type === START_TAG && p.localName() === 'rootfile') {
          const media = p.attr('media-type');
          if (media == null || media === 'application/oebps-package+xml') fromContainer = p.attr('full-path');
        } else if (type === END_DOCUMENT) break;
      }
    } catch (e) {
      rethrowCancel(e);
      fromContainer = null;
    }
  }
  if (fromContainer != null) {
    const path = EpubPaths.decode(ktTrim(fromContainer).replace(/^\/+/, ''));
    if (zip.has(path)) return path;
  }
  return zip.firstEndingWith('.opf');
}

async function readPackage(zip, opf, check) {
  const bytes = await zip.bytes(opf);
  if (!bytes) throw new OfficeNotRecognized();
  let p;
  try {
    p = new LenientXml(bytes);
  } catch (e) {
    rethrowCancel(e);
    throw new OfficeNotRecognized();
  }
  let title = null;
  let creator = null;
  let language = null;
  let coverId = null;
  let fixed = false;
  /** id → { path, mediaType, properties } */
  const manifest = new Map();
  const spineRefs = [];
  let tocId = null;
  let sawPackage = false;
  let text = null;
  let textFor = null;
  let events = 0;
  try {
    for (;;) {
      if (++events % 512 === 0) check();
      const type = p.next();
      if (type === END_DOCUMENT) break;
      if (type === START_TAG) {
        const tag = p.localName();
        switch (tag) {
          case 'package':
            sawPackage = true;
            break;
          // Dublin Core's, the only elements with these names in a package file.
          case 'title':
          case 'creator':
          case 'language':
            text = '';
            textFor = tag;
            break;
          case 'meta':
            if (p.attr('name') === 'cover') coverId = p.attr('content');
            if (p.attr('property') === 'rendition:layout') {
              text = '';
              textFor = 'layout';
            }
            break;
          case 'item': {
            const id = p.attr('id');
            const href = p.attr('href');
            const target = href != null ? EpubPaths.resolve(opf, href)?.[0] : null;
            if (id != null && target != null) {
              manifest.set(id, {
                path: target,
                mediaType: (p.attr('media-type') ?? '').toLowerCase(),
                properties: new Set((p.attr('properties') ?? '').split(' ')),
              });
            }
            break;
          }
          case 'spine':
            tocId = p.attr('toc');
            break;
          case 'itemref': {
            const idref = p.attr('idref');
            if (idref != null) spineRefs.push([idref, p.attr('linear') !== 'no', new Set((p.attr('properties') ?? '').split(' '))]);
            break;
          }
          default:
            break;
        }
      } else if (type === TEXT) {
        if (text != null) text += p.text;
      } else if (type === END_TAG) {
        if (text != null && (p.localName() === textFor || (textFor === 'layout' && p.localName() === 'meta'))) {
          const value = ktTrim(text);
          switch (textFor) {
            case 'title': if (title == null && value) title = value; break;
            case 'creator': if (creator == null && value) creator = value; break;
            case 'language': if (language == null && value) language = value; break;
            case 'layout': fixed = value === 'pre-paginated'; break;
            default: break;
          }
          text = null;
          textFor = null;
        }
      }
    }
  } catch (e) {
    rethrowCancel(e);
    if (!(e instanceof XmlReadError)) throw e;
    if (!sawPackage || !manifest.size) throw new OfficeNotRecognized();
  }
  if (!sawPackage) throw new OfficeNotRecognized();
  const spine = [];
  for (const [id, linear, properties] of spineRefs) {
    const item = manifest.get(id);
    if (!item || !zip.has(item.path)) continue;
    const type = item.mediaType;
    const readable = DOCUMENT_TYPES.has(type) || (type.startsWith('image/') && type !== 'image/svg+xml') || (!type && HTML_NAME.test(item.path));
    // Fixed layout is mostly set for the whole book, but each document can have its own: a
    // picture book's long afterword can flow onto pages as ordinary text does.
    const itemFixed = properties.has('rendition:layout-pre-paginated') ? true : properties.has('rendition:layout-reflowable') ? false : fixed;
    if (readable) spine.push(new SpineItem(item.path, type, linear, itemFixed));
  }
  if (!spine.length) throw new OfficeNothingToConvert();
  const items = [...manifest.values()];
  const coverItem = items.find((it) => it.properties.has('cover-image')) ?? (coverId != null ? manifest.get(coverId) : null) ?? null;
  const cover = coverItem && (coverItem.mediaType.startsWith('image/') || !coverItem.mediaType) && zip.has(coverItem.path) ? coverItem.path : null;
  const navItem = items.find((it) => it.properties.has('nav'));
  const nav = navItem && zip.has(navItem.path) ? navItem.path : null;
  const ncxItem = (tocId != null ? manifest.get(tocId) : null) ?? items.find((it) => it.mediaType === 'application/x-dtbncx+xml');
  const ncx = ncxItem && zip.has(ncxItem.path) ? ncxItem.path : null;
  return new EpubBook(title, creator, language, spine, cover, nav, ncx);
}

async function parserFor(zip, path) {
  const bytes = await readEntry(zip, path);
  if (!bytes) return null;
  try {
    return new LenientXml(bytes);
  } catch (e) {
    if (e instanceof XmlReadError) return null;
    throw e;
  }
}

/** The EPUB 3 navigation document's table of contents (<nav epub:type="toc">). */
async function readNav(zip, path, check) {
  const p = await parserFor(zip, path);
  if (!p) return [];
  // <nav epub:type="toc"> holds an <ol>; each <li> has an <a> (or a <span> heading) and maybe a nested <ol>.
  const stack = [];
  const top = [];
  let navDepth = -1;
  let labelDepth = -1;
  let done = false;
  let events = 0;
  try {
    while (!done) {
      if (++events % 512 === 0) check();
      const type = p.next();
      if (type === START_TAG) {
        const tag = p.localName();
        if (navDepth < 0) {
          if (tag === 'nav' && (p.attr('type')?.split(' ') ?? []).includes('toc')) navDepth = p.depth;
        } else if (tag === 'li') {
          stack.push({ title: '', href: null, children: [] });
        } else if ((tag === 'a' || tag === 'span') && stack.length && labelDepth < 0) {
          labelDepth = p.depth;
          if (tag === 'a') stack[stack.length - 1].href = p.attr('href');
        }
      } else if (type === TEXT) {
        if (labelDepth >= 0 && stack.length) stack[stack.length - 1].title += p.text;
      } else if (type === END_TAG) {
        if (navDepth < 0) continue;
        if (p.depth === labelDepth) labelDepth = -1;
        if (p.depth === navDepth) done = true;
        else if (p.localName() === 'li') {
          const item = stack.pop();
          if (item) {
            const target = item.href != null ? EpubPaths.resolve(path, item.href) : null;
            const entry = new TocEntry(clean(item.title), target?.[0] ?? null, target?.[1] ?? null, item.children);
            (stack.length ? stack[stack.length - 1].children : top).push(entry);
          }
        }
      } else if (type === END_DOCUMENT) {
        done = true;
      }
    }
  } catch (e) {
    rethrowCancel(e);
    if (!(e instanceof XmlReadError)) throw e;
    // A damaged navigation document: the entries read so far.
  }
  return top;
}

/** The EPUB 2 NCX file's table of contents (its navMap). */
async function readNcx(zip, path, check) {
  const p = await parserFor(zip, path);
  if (!p) return [];
  const stack = [];
  const top = [];
  let inLabel = false;
  let events = 0;
  try {
    reading: for (;;) {
      if (++events % 512 === 0) check();
      const type = p.next();
      if (type === START_TAG) {
        switch (p.localName()) {
          case 'navPoint': stack.push({ title: '', src: null, children: [] }); break;
          case 'navLabel': inLabel = stack.length > 0; break;
          case 'content': {
            const point = stack[stack.length - 1];
            if (point && point.src == null) point.src = p.attr('src');
            break;
          }
          // The page list and other lists aren't the table of contents.
          case 'pageList':
          case 'navList':
            break reading;
          default: break;
        }
      } else if (type === TEXT) {
        if (inLabel && stack.length) stack[stack.length - 1].title += p.text;
      } else if (type === END_TAG) {
        const name = p.localName();
        if (name === 'navLabel') inLabel = false;
        else if (name === 'navPoint') {
          const point = stack.pop();
          if (point) {
            const target = point.src != null ? EpubPaths.resolve(path, point.src) : null;
            (stack.length ? stack[stack.length - 1].children : top).push(new TocEntry(clean(point.title), target?.[0] ?? null, target?.[1] ?? null, point.children));
          }
        }
      } else if (type === END_DOCUMENT) {
        break;
      }
    }
  } catch (e) {
    rethrowCancel(e);
    if (!(e instanceof XmlReadError)) throw e;
  }
  return top;
}
