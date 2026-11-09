// Reorganize PDF's strings (tools/reorganize/). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. Shared strings (Choose PDF, Undo,
// Page 3, Move page 3 earlier, page counts, File name, the result screen...) are in common.js and kit.js.
export default {
  reorganize_hint: 'Pages you add go after the chosen page. Long-press a page and drag to move it.',
  reorganize_choose_page: 'Tap a page to choose it',
  reorganize_add: 'Add pages',
  reorganize_add_pdf: 'Pages from a PDF',
  reorganize_add_blank: 'Blank page',
  // On a blank page's picture in the page grid.
  reorganize_blank: 'Blank',
  // {1} is the page's place in the new PDF, {2} the name of the PDF it comes from.
  reorganize_page_from: 'Page {1}, from {2}',
  reorganize_page_blank: 'Page {1}, blank',
  pdf_reorganize_action: 'Save PDF',

  // ---- The web app's own strings ----

  // The bar showing while a PDF is opened (its password asked for), or a blank page's size read.
  web_adding_pages: 'Adding pages…',
};
