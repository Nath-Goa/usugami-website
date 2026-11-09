// Redact PDF's screen (js/tools/redact/). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. The tool's name, "Choose PDF",
// "File name", "Page 3" and the result screen's strings are in common.js and kit.js.
export default {
  // What is boxed is removed for good, as the redacted pages become pictures.
  pdf_redact_action: 'Redact PDF',
  redact_note: 'Redacted pages are saved as pictures, so their text can no longer be selected.',
  redact_find: 'Find text',
  redact_find_hint: 'Every match on every page gets a box for you to check.',
  redact_find_action: 'Find',
  redact_find_none: "Nothing found. Text in scans and pictures can't be searched: draw boxes over it instead.",
  // {1} is the most boxes Usugami keeps (2000).
  redact_find_too_many: 'Too many matches: Usugami keeps up to {1} boxes. Try a longer phrase.',
  redact_too_many: 'Usugami keeps up to {1} boxes.',
  redact_find_failed: "Couldn't search this PDF.",
  redact_found: {
    one: 'Found {1} match and boxed it. Check it before saving.',
    other: 'Found {1} matches and boxed them. Check them before saving.',
  },
  redact_page: 'Page',
  redact_page_marked: 'Has boxes',
  redact_mark: 'Mark what to hide',
  redact_mark_hint: 'Drag on the page to draw a box. Tap a box to change it.',
  redact_page_failed: "This page can't be shown, so it can't be redacted.",
  // {1} is a page number, {2} the number of boxes on it.
  redact_preview_description: {
    one: 'Page {1}, {2} box',
    other: 'Page {1}, {2} boxes',
  },
  // {1} is the box's number, {2} how many boxes the page has.
  redact_box_chosen: 'Box {1} of {2} chosen',
  redact_add_box: 'Add box',
  redact_remove_all: 'Remove all',
  redact_remove_all_title: 'Remove all boxes?',
  // Counts boxes, so never 0: the question is only asked when there are some.
  redact_remove_all_body: {
    one: 'The box will be removed.',
    other: 'All {1} boxes will be removed, on every page.',
  },
  redact_move_left: 'Move box left',
  redact_move_up: 'Move box up',
  redact_move_down: 'Move box down',
  redact_move_right: 'Move box right',
  redact_width: 'Width',
  redact_height: 'Height',
  redact_narrower: 'Make box narrower',
  redact_wider: 'Make box wider',
  redact_shorter: 'Make box shorter',
  redact_taller: 'Make box taller',
  redact_delete_box: 'Delete box',

  // ---- The web app's own strings ----

  // A box on the page, as a button a keyboard or screen reader reaches. {1} is its number, {2} how
  // many boxes the page has.
  web_redact_box: 'Box {1} of {2}',
  // Under the page on computers.
  web_redact_keys_hint: 'With a box chosen, arrow keys move it, Shift and arrow keys resize it, and Delete removes it.',
  // The zoom buttons over the page.
  web_redact_zoom: 'Zoom',
  web_redact_zoom_in: 'Zoom in',
  web_redact_zoom_out: 'Zoom out',
  web_redact_zoom_fit: 'Fit page',
};
