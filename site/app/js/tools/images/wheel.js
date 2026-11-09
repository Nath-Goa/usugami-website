// A row that scrolls sideways (Filters' looks) also scrolls with a mouse wheel, which only turns up
// and down: on a computer the row would otherwise need Shift and the wheel, or its thin scroll
// bar. As Sign's page strip does.

/**
 * Makes a vertical wheel over `row` scroll it along, while it has further to go that way; once it
 * is at its end (or for a pinch, or a sideways swipe), the wheel does what it always does.
 * @param {HTMLElement} row
 * @returns {() => void} stops it
 */
export function wheelAlong(row) {
  const onWheel = (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 0) return;
    // Lines (Firefox) are about 16 px each.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * row.clientWidth : e.deltaY;
    // Right to left, the row's start is at the right: scrollLeft runs from 0 down to -max.
    const rtl = getComputedStyle(row).direction === 'rtl';
    const before = row.scrollLeft;
    row.scrollLeft = before + (rtl ? -delta : delta);
    if (row.scrollLeft !== before) e.preventDefault();
  };
  row.addEventListener('wheel', onWheel, { passive: false });
  return () => row.removeEventListener('wheel', onWheel);
}
