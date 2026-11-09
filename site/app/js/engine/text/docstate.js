// What the text engine keeps for each PDF it draws into: the fonts embedded (their subsets grow as
// glyphs are drawn), the canvases whose content isn't written yet, pictures still being encoded,
// and named destinations. It is all written into the PDF when it is saved: pdf-lib's save()
// calls doc.flush(), which runs finishText() first.

const states = new WeakMap();

/** The text engine's state for `doc`, made (and doc.flush hooked) on first use. */
export function docState(doc) {
  let s = states.get(doc);
  if (!s) {
    s = {
      fonts: new Map(),
      canvases: new Set(),
      pending: new Set(),
      images: new WeakMap(),
      fallbackImages: new Map(),
      shadings: [],
      dests: [],
      tags: 0,
      errors: [],
    };
    states.set(doc, s);
    const flush = doc.flush;
    doc.flush = async function flushWithText(...args) {
      await finishText(doc);
      return flush.apply(this, args);
    };
  }
  return s;
}

/** Waits for `promise` before the PDF is saved; a failure fails the save. */
export function track(doc, promise) {
  const s = docState(doc);
  const p = Promise.resolve(promise).catch((e) => {
    s.errors.push(e);
  });
  s.pending.add(p);
  p.finally(() => s.pending.delete(p));
  return promise;
}

/**
 * Writes everything drawn into `doc` so far: canvases' content, fonts (subsets of the glyphs
 * used), pictures and named destinations. pdf-lib's save() (and so savePdf) does this itself; call
 * it before copying or embedding pages drawn on into another PDF. Drawing may go on afterwards.
 */
export async function finishText(doc) {
  const s = states.get(doc);
  if (!s) return;
  while (s.pending.size) await Promise.all([...s.pending]);
  if (s.errors.length) {
    const e = s.errors[0];
    s.errors = [];
    throw e;
  }
  for (const c of s.canvases) c.close();
  for (const f of s.fonts.values()) f.write();
  if (s.writeDests) s.writeDests();
}
