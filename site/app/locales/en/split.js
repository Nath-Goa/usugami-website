// Split PDF's strings (js/tools/split/). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. Shared strings are in common.js and kit.js.
export default {
  pdf_split_action: 'Split PDF',
  pdf_selected: 'Selected pages',
  // The examples use the hyphen people type, not an en dash.
  pdf_selected_hint: 'For example: 1,3,5-8. Tap page previews to select them.',
  pdf_custom: 'Custom ranges',
  pdf_custom_hint: 'For example: 1-3;5-7;9',
  pdf_fixed: 'Fixed chunks',
  pdf_fixed_hint: 'Pages per PDF',
  pdf_fixed_example: 'For example: 5',
  pdf_every_page: 'Every page',
  pdf_combine_selected: 'Combine selected pages into one PDF',
  pdf_combine_ranges: 'Combine all ranges into one PDF',

  pdf_ranges_format: 'Use ranges such as 1-3;5;7-9.',
  pdf_pages_chunk: 'Pages per PDF must be between 1 and {1}.',

};
