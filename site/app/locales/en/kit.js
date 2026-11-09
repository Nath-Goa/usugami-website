// The UI kit's own strings (core/ui.js, files.js, pdfdoc.js, pagegrid.js, output.js, batch.js),
// loaded at start beside common.js. Keys and English texts are the Android app's (strings.xml);
// those the app doesn't have start with web_. The kit also uses many of common.js's strings
// (Cancel, Open PDF, the result screen's buttons and messages, "PDF 2 of 5"...), which aren't
// repeated here.
export default {
  // Dropdown chips: an option and its value, e.g. "Margin: Small".
  option_value: '{1}: {2}',
  // The name a tool's PDF gets, with ".pdf" after it.
  file_name: 'File name',

  // Page grids. {1} is a page number, not a count.
  pdf_page_number: 'Page {1}',
  move_page_earlier: 'Move page {1} earlier',
  move_page_later: 'Move page {1} later',

  // The result screen, under a PDF Compress PDF made.
  compressed_from: 'Compressed from {1} ({2}% smaller)',
  original_kept: 'Already compact: the original was kept',

  // ---- The web app's own strings ----

  // Under "Choose PDF" etc. on computers, where files can be dragged onto it.
  web_drop_hint: 'Or drop files here',
  web_files_unreadable: { one: "Couldn't read {1} file.", other: "Couldn't read {1} files." },
  // Said to screen readers when a page has been moved, with the keyboard or by dragging.
  web_page_moved: 'Moved to place {1} of {2}',
  web_reorder_hint: 'To move it, press Ctrl and an arrow key, or drag it.',
  // What a screen reader calls the "File name" field of one file among several: {1} is that file's name.
  web_file_name_for: 'File name for {1}',
  // The result screen.
  web_open_blocked: 'Your browser blocked the new tab. Allow pop-ups for this site, or save the file instead.',
  web_share_failed: "Couldn't share from this browser. Save the file instead.",
  web_zip_download: 'Save ZIP to Downloads',
  // A ZIP file took a while to make, so the browser needs another tap to share it.
  web_zip_ready: 'The ZIP file is ready.',
  // A bottom sheet's handle, for screen readers on touch screens: it closes the sheet.
  web_sheet_close: 'Close',
};
