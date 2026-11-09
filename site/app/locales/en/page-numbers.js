// Add page numbers (tools/page-numbers/, engine/stamps.js). Keys and English texts are the Android
// app's (strings.xml).
export default {
  pdf_page_numbers_action: 'Add page numbers',
  // The button with several PDFs (never fewer than 2).
  pdf_page_numbers_action_many: { one: 'Add page numbers to {1} PDF', other: 'Add page numbers to {1} PDFs' },
  page_numbers_position: 'Position',
  position_top_left: 'Top left',
  position_top_center: 'Top center',
  position_top_right: 'Top right',
  position_bottom_left: 'Bottom left',
  position_bottom_center: 'Bottom center',
  position_bottom_right: 'Bottom right',
  page_numbers_size: 'Size',
  number_size_small: 'Small',
  number_size_medium: 'Medium',
  number_size_large: 'Large',
  page_numbers_skip: 'Pages to skip',
  page_numbers_skip_hint: 'Optional. For example: 1 or 1-2,5',
  page_numbers_note: 'Each page keeps its own number: skip page 1, and page 2 is numbered 2.',
  page_numbers_all_skipped: 'Leave at least one page to number.',
  page_numbers_for_all_hint: 'Every PDF is numbered the same way. Pages to skip are skipped in each PDF that has them.',
  // {1} counts the PDFs whose every page was to be skipped (never 0), {2} lists their names.
  batch_nothing_to_number: {
    one: 'No page is left to number in {2}, so it was left out.',
    other: 'No page is left to number in {1} PDFs, so they were left out: {2}.',
  },

  // ---- The web app's own strings ----

};
