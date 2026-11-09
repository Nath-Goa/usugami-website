// Edit PDF's strings (EditPdfOptions.kt, EditPreview.kt). Keys and English texts are the Android
// app's (strings.xml); those the app doesn't have start with web_. Shared strings (Undo, Redo,
// Cancel, Choose PDF, File name, the result screen) come from common.js and kit.js.
export default {
  pdf_edit_action: 'Save PDF',

  // The five tool buttons share one row: keep them short.
  edit_text: 'Text',
  edit_draw: 'Draw',
  edit_highlight: 'Highlight',
  edit_shape: 'Shape',
  edit_picture: 'Picture',

  edit_hint_start: 'Add text, a drawing, a shape or a picture to this page.',
  edit_hint_select: 'Tap something you added to move or change it.',
  edit_hint_selected: 'Drag it, or move it with the buttons below.',
  edit_hint_draw: 'Draw with your finger. To scroll, swipe beside the page.',
  // {1} is the page number.
  edit_preview_description: 'Page {1}, with what you added',
  edit_text_add: 'Add text',
  edit_text_change: 'Edit text',

  // What a screen reader calls each thing added to a page. {1} is the text itself.
  edit_item_text: 'Text: {1}',
  edit_item_drawing: 'Drawing',
  edit_item_highlight: 'Highlight',
  edit_item_rectangle: 'Rectangle',
  edit_item_filled_rectangle: 'Filled rectangle',
  edit_item_ellipse: 'Ellipse',
  edit_item_filled_ellipse: 'Filled ellipse',
  edit_item_line: 'Line',
  edit_item_arrow: 'Arrow',
  // {1} is what is chosen, such as "Rectangle" or "Text: Hello".
  edit_selected: 'Selected: {1}',
  edit_delete: 'Delete',
  edit_thickness: 'Thickness',
  edit_fill: 'Filled',

  color_yellow: 'Yellow',
  color_white: 'White',

  edit_cover_hint: "A filled shape only covers what's under it, which stays in the file. To remove it for good, use Redact PDF.",
  edit_picture_failed: "Couldn't read that picture.",
  edit_full: "This PDF can't take any more additions. Save it, then edit the new PDF to add more.",
  // Said by a screen reader for a page in the row of pages that has something added to it.
  edit_page_edited: 'Edited',

  // ---- The web app's own strings ----

  web_edit_hint_draw: 'Draw on the page with your finger, a pen or the mouse. To scroll, swipe beside the page.',
  // On wide screens the chosen item's controls are beside the page, not below it.
  web_edit_hint_selected_wide: 'Drag it, or move it with the arrow buttons or the arrow keys.',
  web_edit_opening: 'Opening the PDF…',
  web_edit_picture_adding: 'Adding the picture…',
  // The row of pages, and the buttons beside the preview.
  web_edit_pages: 'Pages',
  web_edit_page_of: 'Page {1} of {2}',
  web_edit_previous_page: 'Previous page',
  web_edit_next_page: 'Next page',
  web_edit_zoom_in: 'Zoom in',
  web_edit_zoom_out: 'Zoom out',
  // {1} is how far the page is zoomed in, such as "150%".
  web_edit_zoom_level: 'Zoom {1}',
  web_edit_tools: 'Add to the page',
  web_edit_color: 'Color',
  // A size or line width, in points: "14 pt".
  web_edit_points: '{1} pt',
};
