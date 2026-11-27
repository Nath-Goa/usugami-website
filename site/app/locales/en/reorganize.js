// Reorganize PDF's strings (tools/reorganize/). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. Shared strings (Choose PDF, Undo,
// Page 3, Move page 3 earlier, Rotate page 3 left, Remove page 3, page counts, File name, what is
// wrong with typed pages, the result screen...) are in common.js and kit.js.
export default {
  // Under the Selected pages field.
  reorganize_pages_hint: 'For example: 2,5-7. Or tap the pages below.',
  pdf_reorganize_action: 'Save PDF',
  reorganize_add: 'Add pages',
  reorganize_add_pdf: 'Pages from a PDF',
  reorganize_add_blank: 'Blank page',
  // On a blank page's picture in the page grid.
  reorganize_blank: 'Blank',
  // {1} is the page's place in the new PDF, {2} the name of the PDF it comes from.
  reorganize_page_from: 'Page {1}, from {2}',
  reorganize_page_blank: 'Page {1}, blank',
  // A button beside the page count that selects every page in the grid.
  reorganize_select_all: 'Select all',
  // The same button while every page is selected: it takes them all out of the selection.
  reorganize_select_none: 'Select none',
  // The label of a field where the selected pages are typed as numbers and ranges, like 2,5-7.
  reorganize_pages_field: 'Selected pages',
  // Read by a screen reader: the button at the end of that field, which empties it and the selection.
  reorganize_pages_clear: 'Clear the selected pages',
  // In the bar above the pages while none is selected.
  reorganize_tap_pages: 'Tap pages to select them',
  // In the same bar while two or more pages are selected: {1} pages are selected, out of the {2} pages in the list.
  reorganize_selected_count: 'Selected: {1} of {2}',
  // Under the pages. Pages added with "Add pages" go after the selected page that comes last.
  reorganize_move_hint: 'Long-press a page and drag to move it. Pages you add go after the last selected page.',
  // Read by a screen reader: buttons in the bar that turn every selected page a quarter turn.
  rotate_selected_left: 'Rotate the selected pages left',
  rotate_selected_right: 'Rotate the selected pages right',
  // Read by a screen reader: the button in the bar that takes the selected pages out (never fewer than 2).
  remove_selected_pages: { one: 'Remove {1} page', other: 'Remove {1} pages' },

  // ---- The web app's own strings ----

  // The bar showing while a PDF is opened (its password asked for), or a blank page's size read.
  web_adding_pages: 'Adding pages…',
};
