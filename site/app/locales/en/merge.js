// Merge PDF's strings (tools/merge/). Keys and English texts are the Android app's (strings.xml);
// those the app doesn't have start with web_. Shared strings (Add PDFs, Move earlier/later, Remove,
// page counts, File name, the result screen...) are in common.js and kit.js.
export default {
  // Files | Pages: the switch between merging whole PDFs and arranging their pages.
  pdf_file_mode: 'Files',
  pdf_page_mode: 'Pages',
  pdf_page_mode_switch: 'Arrange individual pages',
  pdf_file_mode_hint: 'Move whole PDFs into the order you want.',
  pdf_page_mode_hint: 'Arrange, rotate, or remove individual pages.',
  pdf_sort_az: 'Sort A to Z',
  pdf_sort_za: 'Sort Z to A',
  // A page in the page list: its place in the merged PDF, the PDF it is from, and its page number there.
  merge_page_line: '{1}. {2}, page {3}',
  pdf_merge_action: 'Merge PDFs',

  // Errors (engine/organize.js' mergePdfs).
  pdf_need_two: 'Add at least two PDFs to merge.',

  // ---- The web app's own strings ----

  // The bar showing while the PDFs picked are opened (their passwords asked for).
  web_adding_pdfs: 'Adding PDFs…',
};
