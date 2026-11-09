// The Usugami watermark on the result screen (core/result-mark.js, engine/page-mark.js). Keys and
// English texts are the Android app's (strings.xml). The shell loads these at start, with kit.js.
export default {
  // A switch that puts a small "Usugami" on the PDFs' pages, and an arrow on its row that opens its
  // size and opacity. "Usugami" is the app's name and stays as it is in every language.
  mark_title: 'Usugami watermark',
  mark_detail: 'Adds a small "Usugami" in the corner of each page, to support the app.',
  mark_adjust: 'Watermark size and opacity',
  mark_size: 'Size',
  mark_opacity: 'Opacity',
  // A slider's value, such as "20%".
  mark_percent: '{1}%',
  mark_preview_description: 'Page 1 with the Usugami watermark',
  mark_working: 'Updating the watermark…',
  // Over the progress bar once the PDFs are made, while the watermark goes on them.
  mark_adding: 'Adding the Usugami watermark…',
  mark_failed: "Couldn't change the Usugami watermark. Check that there is enough free storage.",
};
