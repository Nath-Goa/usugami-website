// Pages without boxes that would keep, out of sight, something the boxes hide (the app's
// Redactor.keepingHidden): they draw a content stream of a page with boxes, or an image or form a
// box covers part of, but don't show the part under the box, which would then stay in the file. A
// scanned spread split into two pages is like that when each page draws the whole scan and its
// crop box shows one half. Those pages become pictures too, of what they show. When a page
// without boxes shows that part, as with a logo every page draws, it is there for all to see
// anyway, so no page becomes a picture because of it.
import {
  placements, contentStreams, mayDraw, annotationPlacements,
} from './content.js';
import { pageView } from './objects.js';
import { mapped, inverted, intersection, inside, pageArea } from './boxes.js';

/** How far, in points, something may reach past the edge of a page and still count as shown on it. */
const SLACK = 1;

/** What of `area` the forms it is drawn in let show, if they cut it to `clip`; null for nothing. */
const shownPart = (area, clip) => (clip == null ? area : intersection(area, clip));

/**
 * The indices of the pages without boxes that keep, out of sight, part of what the boxes hide.
 * `byPage` maps page indices to their boxes; `frames` gives each page's frame (as shown).
 */
export function keepingHidden(reader, nodes, byPage, frames, check) {
  const { ctx } = reader;
  // What the boxes hide: in the page's own coordinates, for each content stream that drew it…
  const inStreams = new Map();
  // …and in their own space, for the images and forms under them.
  const inXObjects = new Map();
  const add = (map, key, part) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(part);
  };
  for (const [index, boxes] of byPage) {
    check?.();
    const node = nodes[index];
    const frame = frames(index);
    const sw = frame.shownWidth;
    const sh = frame.shownHeight;
    const areas = boxes.map((box) => pageArea(frame.matrix, box.left * sw, (1 - box.bottom) * sh, (box.right - box.left) * sw, (box.bottom - box.top) * sh));
    for (const stream of contentStreams(ctx, node)) for (const area of areas) add(inStreams, stream, { area });
    for (const placement of placements(reader, node) ?? []) {
      const inverse = inverted(placement.matrix);
      if (!inverse) continue;
      const drawn = shownPart(mapped(placement.matrix, placement.extent), placement.clip);
      if (!drawn) continue;
      for (const area of areas) {
        const covered = intersection(area, drawn);
        if (!covered) continue;
        const own = intersection(mapped(inverse, covered), placement.extent);
        if (own) add(inXObjects, placement.xobject, { area: own });
      }
    }
  }
  // For each page without boxes, what it keeps out of sight; and what some page shows.
  const keptBy = new Map();
  const shown = new Set();
  const reaches = new Map();
  const xobjects = new Set(inXObjects.keys());
  nodes.forEach((node, index) => {
    if (byPage.has(index)) return;
    check?.();
    const crop = pageView(ctx, node).view;
    const shows = (area, clip) => {
      const part = shownPart(crop, clip);
      return part != null && inside(area, part, SLACK);
    };
    const kept = [];
    for (const stream of contentStreams(ctx, node)) {
      for (const part of inStreams.get(stream) ?? []) (shows(part.area, null) ? shown.add(part) : kept.push(part));
    }
    // A page whose content can't be read is left as it is.
    const drawnHere = [];
    if (xobjects.size && mayDraw(reader, node, xobjects, reaches)) {
      for (const p of placements(reader, node) ?? []) if (xobjects.has(p.xobject)) drawnHere.push(p);
    }
    // Its annotations' appearances draw them too, where they show; and a hidden annotation, or a
    // look not shown, keeps them out of sight as well, since they'd stay in the file for it.
    const unseen = new Set();
    if (xobjects.size) drawnHere.push(...annotationPlacements(reader, node, xobjects, unseen));
    const here = new Set(drawnHere.map((p) => p.xobject));
    for (const x of unseen) here.add(x);
    for (const xobject of here) {
      for (const part of inXObjects.get(xobject)) {
        const showing = drawnHere.some((p) => p.xobject === xobject && shows(mapped(p.matrix, part.area), p.clip));
        if (showing) shown.add(part);
        else kept.push(part);
      }
    }
    if (kept.length) keptBy.set(index, kept);
  });
  return [...keptBy].filter(([, parts]) => parts.some((p) => !shown.has(p))).map(([index]) => index);
}
