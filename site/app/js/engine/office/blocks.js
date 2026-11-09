// Blocks: things laid out to a width that can be drawn anywhere and split between pages (the
// Block interface of the app's OfficeText.kt, with StackBlock and Spaced). A laid-out paragraph
// (engine/text's ParagraphLayout) is a block already; tables.js has rows and tables.
//
// A block is any object with
//   height                     points
//   draw(canvas, x, y)         its top-left corner at (x, y) on a PdfCanvas
//   split(space, force)        [head, tail | null] for the part that fits in `space` points and the
//                              rest (tail null when it all fits), or null when nothing fits; with
//                              `force` (nothing else on the page), something always fits.

/** A block with the space (points) to leave above and below it. */
export class Spaced {
  constructor(block, before = 0, after = 0) {
    this.block = block;
    this.before = before;
    this.after = after;
  }
}

/** Blocks one under another, with space between them: a table cell's content, for one. */
export class StackBlock {
  /** `items`: Spaced blocks. */
  constructor(items) {
    this.items = items;
    let h = 0;
    for (const it of items) h += it.before + it.block.height + it.after;
    this.height = h;
  }

  draw(canvas, x, y) {
    let top = y;
    for (const item of this.items) {
      top += item.before;
      item.block.draw(canvas, x, top);
      top += item.block.height + item.after;
    }
  }

  split(space, force = false) {
    let used = 0;
    const items = this.items;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const end = used + item.before + item.block.height + item.after;
      if (end <= space) {
        used = end;
        continue;
      }
      const room = space - used - item.before;
      const parts = room > 0 || (force && index === 0) ? item.block.split(room, force && index === 0) : null;
      const head = items.slice(0, index);
      if (parts) head.push(new Spaced(parts[0], item.before, 0));
      const tail = [];
      if (parts?.[1]) tail.push(new Spaced(parts[1], 0, item.after));
      else if (!parts) tail.push(item);
      tail.push(...items.slice(index + 1));
      if (!head.length) return null;
      return [new StackBlock(head), tail.length ? new StackBlock(tail) : null];
    }
    return [this, null];
  }
}

/** A block of nothing `height` points tall (space, or a placeholder). */
export class EmptyBlock {
  constructor(height = 0) {
    this.height = height;
  }

  draw() {}

  split(space, force = false) {
    if (this.height <= space) return [this, null];
    return force ? [this, null] : null;
  }
}
