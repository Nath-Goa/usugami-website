// Word, PowerPoint, Excel and EPUB to PDF (js/tools/office/): one screen for the four tools.
// Keys and English texts are the Android app's (app/src/main/res/values/strings.xml), so other
// languages can be copied from its values-fr, values-es and values-hi. Strings the app doesn't
// have start with web_. Also used, from common.js and kit.js: the tool names, pick_several_hint,
// remove_file, file_name, result_details, progress_pages, pdf_page_number, batch_progress,
// batch_failed, file_problem, option_value, share_waits, pdf_discard_title, share_discard_body.
export default {
  // Picking files
  pick_word: 'Choose Word files',
  pick_powerpoint: 'Choose PowerPoint files',
  pick_excel: 'Choose Excel files',
  pick_epub: 'Choose EPUB files',
  add_word: 'Add Word files',
  add_powerpoint: 'Add PowerPoint files',
  add_excel: 'Add Excel files',
  add_epub: 'Add EPUB files',
  document_word: 'Word document',
  document_powerpoint: 'PowerPoint presentation',
  document_excel: 'Excel workbook',
  document_epub: 'EPUB e-book',

  // What converts, under the file
  office_note_word: "Text, headings, lists, tables and pictures convert. Your phone's fonts stand in for the document's, so some lines may break differently.",
  office_note_powerpoint: "Each slide becomes a page; hidden slides are left out. Your phone's fonts stand in for the presentation's, and charts show as gray boxes.",
  office_note_excel: "Each sheet starts a new page, as Excel prints it; hidden sheets are left out. Your phone's fonts stand in for the workbook's, and charts are left out.",
  office_note_epub: "Chapters, headings, text styles, lists, tables and pictures convert, and the table of contents becomes bookmarks. Your phone's fonts are used.",

  book_page_note: 'A5 is about the size of a paperback; A4 suits printing.',
  // "As in the file" keeps the paper size or orientation each sheet was set to print on.
  sheet_as_file: 'As in the file',
  sheet_fit_width: 'Fit columns to page width',
  sheet_fit_width_on: 'Wide sheets shrink so their columns fit across the page, but never below half size.',
  sheet_fit_width_off: "Columns that don't fit go on more pages, as Excel prints them.",
  sheet_gridlines: 'Gridlines',
  sheet_gridlines_detail: 'Light gray lines between cells, as on screen. Borders, and gridlines a sheet is set to print, always show.',

  // With several files (never fewer than 2).
  convert_many: { one: 'Convert {1} file to PDF', other: 'Convert {1} files to PDF' },
  creating_pdfs: 'Creating and compressing PDFs…',
  progress_slides: { one: '{1} of {2} slide', other: '{1} of {2} slides' },
  progress_chapter: 'Chapter {1} of {2}',

  // Why a file can't be converted, said of one file and (_many) of several
  office_legacy_word: 'This is an old Word file (.doc). Save it as .docx in Word or another app, then try again.',
  office_legacy_word_many: 'These are old Word files (.doc). Save them as .docx in Word or another app, then try again.',
  office_legacy_powerpoint: 'This is an old PowerPoint file (.ppt). Save it as .pptx in PowerPoint or another app, then try again.',
  office_legacy_powerpoint_many: 'These are old PowerPoint files (.ppt). Save them as .pptx in PowerPoint or another app, then try again.',
  office_legacy_excel: 'This is an old Excel file (.xls). Save it as .xlsx in Excel or another app, then try again.',
  office_legacy_excel_many: 'These are old Excel files (.xls). Save them as .xlsx in Excel or another app, then try again.',
  office_encrypted: 'This file is protected with a password. Remove the password in Word or PowerPoint, save the file, then try again.',
  office_encrypted_many: 'These files are protected with a password. Remove the password in Word or PowerPoint, save the files, then try again.',
  office_encrypted_excel: 'This file is protected with a password. Remove the password in Excel, save the file, then try again.',
  office_encrypted_excel_many: 'These files are protected with a password. Remove the password in Excel, save the files, then try again.',
  office_not_word: "This isn't a Word document (.docx), or it's damaged.",
  office_not_word_many: "These aren't Word documents (.docx), or they're damaged.",
  office_not_powerpoint: "This isn't a PowerPoint presentation (.pptx), or it's damaged.",
  office_not_powerpoint_many: "These aren't PowerPoint presentations (.pptx), or they're damaged.",
  office_not_excel: "This isn't an Excel workbook (.xlsx), or it's damaged.",
  office_not_excel_many: "These aren't Excel workbooks (.xlsx), or they're damaged.",
  epub_not_recognized: "This isn't an EPUB e-book, or it's damaged.",
  epub_not_recognized_many: "These aren't EPUB e-books, or they're damaged.",
  epub_protected: "This book is protected with DRM (copy protection), so Usugami can't read it. Only books without DRM can be converted.",
  epub_protected_many: "These books are protected with DRM (copy protection), so Usugami can't read them. Only books without DRM can be converted.",
  office_no_slides: 'This presentation has no slides to convert. Hidden slides are left out.',
  office_no_slides_many: 'These presentations have no slides to convert. Hidden slides are left out.',
  office_no_sheets: 'This workbook has nothing to convert. Hidden sheets are left out.',
  office_no_sheets_many: 'These workbooks have nothing to convert. Hidden sheets are left out.',
  epub_empty: 'This book has nothing to convert.',
  epub_empty_many: 'These books have nothing to convert.',
  office_embedded_content: "This document keeps its text as a web page or RTF file inside it, which Usugami can't convert. Open it in Word, save it, then try again.",
  office_embedded_content_many: "These documents keep their text as a web page or RTF file inside them, which Usugami can't convert. Open them in Word, save them, then try again.",
  office_too_large: 'This workbook is too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again.',
  office_too_large_many: 'These workbooks are too big to convert on a phone. Set a print area for the part you need in Excel or another app, then try again.',
  office_convert_failed: "Couldn't convert this file. Check the file and free storage.",

  // ---- The web app's own strings ----

  // The notes above, where the app speaks of the phone's fonts: the web app draws with its own.
  web_office_note_word: "Text, headings, lists, tables and pictures convert. Usugami's own fonts stand in for the document's, so some lines may break differently.",
  web_office_note_powerpoint: "Each slide becomes a page; hidden slides are left out. Usugami's own fonts stand in for the presentation's, and charts show as gray boxes.",
  web_office_note_excel: "Each sheet starts a new page, as Excel prints it; hidden sheets are left out. Usugami's own fonts stand in for the workbook's, and charts are left out.",
  web_office_note_epub: "Chapters, headings, text styles, lists, tables and pictures convert, and the table of contents becomes bookmarks. Usugami's own fonts are used.",
  // office_too_large, on a computer as on a phone.
  web_office_too_large: 'This workbook is too big to convert on this device. Set a print area for the part you need in Excel or another app, then try again.',
  web_office_too_large_many: 'These workbooks are too big to convert on this device. Set a print area for the part you need in Excel or another app, then try again.',
  // The bar under the top bar while picked files are checked.
  web_opening_files: 'Opening the files…',
};
