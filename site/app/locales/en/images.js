// Scan document and Images to PDF (js/tools/images/): the editor, Crop page, Filters and the Create
// PDF sheet. Keys and English texts are the Android app's (strings.xml); those the app doesn't have
// start with web_. Strings shared with other screens (Take photo, Upload images, Discard, Keep, the
// result screen, "Couldn't create the PDF: …", Page 3, Move page 3 earlier…) are in common.js and
// kit.js and aren't repeated here.
export default {
  // ---- Editor ----
  editor_title: 'Images to PDF',
  empty_title: 'Turn images into a PDF',
  empty_body: 'Pick your images, put them in order and convert. Everything happens on this phone. Nothing is uploaded.',
  empty_share_hint: 'Tip: you can also share images to Usugami from your gallery.',
  add_from_photos: 'Photos',
  add_from_files: 'Files',
  // Beside "Convert to PDF" on a phone-wide bar; a translation can be just the verb ("Add").
  add_images: 'Add images',
  add_more: 'Add more',
  reorder_hint: 'Long-press a page and drag to reorder',
  adding_images: 'Adding images…',
  sort: 'Sort',
  sort_name_az: 'Name (A to Z)',
  sort_name_za: 'Name (Z to A)',
  sort_reverse: 'Reverse order',
  clear_all: 'Remove all',
  crop_page: 'Crop page {1}',
  cropping_page: 'Cropping page {1}…',
  image_count: { one: '{1} image', other: '{1} images' },
  clear_title: 'Remove all images?',
  discard_title: 'Discard these images?',
  discard_body: 'The images you picked and their order will be cleared. Your original photos are not affected.',

  // ---- Cropping a page out of a photo ----
  crop_title: 'Crop page',
  crop_found: 'Usugami found the page. Drag the corners or sides to adjust it.',
  crop_not_found: 'Drag the corners or sides onto the edges of the page.',
  crop_not_a_page: "The corners don't make a page: put each one on a corner of the page.",
  crop_reset: 'Reset',
  crop_whole: 'Whole image',
  crop_done: 'Done',
  crop_take_another: 'Take another',
  crop_discard: 'Discard photo',
  crop_image_description: 'The image, with the outline of the page',
  crop_corner_top_left: 'Top-left corner',
  crop_corner_top_right: 'Top-right corner',
  crop_corner_bottom_right: 'Bottom-right corner',
  crop_corner_bottom_left: 'Bottom-left corner',
  crop_side_top: 'Top side',
  crop_side_right: 'Right side',
  crop_side_bottom: 'Bottom side',
  crop_side_left: 'Left side',
  crop_rotate_left: 'Rotate left',
  crop_rotate_right: 'Rotate right',
  crop_next: 'Next',
  crop_stop: 'Stop cropping',
  crop_failed: "Couldn't crop the page. It was kept as it was.",
  // e.g. "Page 2 of 5"
  scan_place: 'Page {1} of {2}',
  // What a screen reader says as each image of a scan comes in, e.g. "Crop page, Page 2 of 5".
  scan_pane_title: '{1}, {2}',

  // ---- Filters ----
  filter_title: 'Filters',
  filter_preview_description: 'The page, as it will be in the PDF',
  filter_brightness: 'Brightness',
  filter_contrast: 'Contrast',
  filter_reset_brightness: 'Reset brightness',
  filter_reset_contrast: 'Reset contrast',
  look_title: 'Look',
  look_original: 'Original',
  look_enhanced: 'Enhanced',
  look_grayscale: 'Grayscale',
  look_black_white: 'Black & white',
  look_lighten: 'Lighten',
  look_super_enhanced: 'Super enhanced',
  look_ink_saver: 'Ink saver',
  look_all_pages: 'Apply to all pages',

  option_margin: 'Margin',
  size_fit: 'Fit (same as image)',
  size_fit_short: 'Fit',
  orientation_auto: 'Auto',
  orientation_fit_note: 'Same as image',
  margin_none: 'No margin',
  margin_small: 'Small',
  margin_big: 'Big',
  margin_small_long: 'Small margin',
  margin_big_long: 'Big margin',

  // ---- Create PDF sheet ----
  convert_title: 'Create PDF',
  merge_title: 'Merge all images into one PDF',
  merge_on_summary: 'One PDF with a page for each image',
  merge_off_summary: 'A separate PDF for each image, named after it',
  create_pdf: 'Create PDF',
  create_pdfs: { one: 'Create {1} PDF', other: 'Create {1} PDFs' },
  compression_less_summary: 'Best quality, smaller file (200 dpi)',
  compression_recommended_summary: 'Good quality, much smaller file (150 dpi)',
  compression_extreme_summary: 'Smallest file, lower quality (100 dpi)',
  ocr_title: 'Make text searchable (OCR)',
  ocr_detail: 'Recognize words on these images and add searchable text to the PDF.',
  ocr_language: 'Text language',
  ocr_english: 'English',
  ocr_french: 'French',
  ocr_spanish: 'Spanish',
  ocr_hindi: 'Hindi',

  progress_images: { one: '{1} of {2} image', other: '{1} of {2} images' },
  ocr_downloading: 'Downloading text recognition…',
  ocr_download_percent: '{1}% downloaded',
  ocr_download_note: 'This happens the first time you use each language and needs an internet connection.',
  ocr_reading: 'Reading text…',
  ocr_adding_text: 'Adding searchable text…',
  ocr_no_text: 'No text was recognized. The PDF was created without a text layer.',
  ocr_failed: 'Text recognition failed, so the PDF was created without searchable text.',
  ocr_problem_title: "Text recognition isn't available",
  ocr_problem_download: "Text recognition couldn't be downloaded. Check your internet connection and try again.",
  ocr_problem_failed: "Text recognition couldn't start because of an unexpected error. If this keeps happening, please report it at github.com/Nath-Goa/usugami.",
  ocr_problem_retry: 'To create the PDF now, turn off OCR and try again.',

  // ---- Messages ----
  msg_skipped_unsupported: {
    one: 'Skipped {1} file: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported.',
    other: 'Skipped {1} files: only JPG, PNG, HEIC, AVIF, WebP, BMP and GIF images are supported.',
  },
  msg_failed_import: { one: "Couldn't read {1} image.", other: "Couldn't read {1} images." },

  // ---- The web app's own strings ----

  // The app's empty_body and empty_share_hint, for the web.
  web_empty_body: 'Pick your images, put them in order and convert. Everything happens on this device. Nothing is uploaded.',
  web_empty_share_hint: 'Tip: you can also drop or paste images here, or share them to Usugami once it is installed as an app.',
  // Above the pages on computers, where a mouse drags them at once.
  web_reorder_hint_mouse: 'Drag a page to reorder, or press Ctrl and an arrow key',
  // Said to screen readers on each corner and side handle of the crop screen.
  web_crop_handle_hint: 'The arrow keys move it a step at a time.',
  // Under "Text language" in the Create PDF sheet: where text recognition runs and comes from.
  web_ocr_note: 'Text is recognized on this device. The first time you use a language, its recognition data is downloaded from this site.',
  // Under "Downloading text recognition…".
  web_ocr_download_note: 'This happens the first time you use each language in this browser and needs an internet connection. Your images stay on this device.',
  // AVIF in a browser that can't decode it (as the app names the types each Android version reads).
  web_skipped_unsupported_no_avif: {
    one: 'Skipped {1} file: only JPG, PNG, HEIC, WebP, BMP and GIF images are supported in this browser.',
    other: 'Skipped {1} files: only JPG, PNG, HEIC, WebP, BMP and GIF images are supported in this browser.',
  },
};
