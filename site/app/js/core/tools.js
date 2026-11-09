// Every tool of the web app, as Home lists them (the same tools, order and sections as the
// Android app's HomeScreen.kt). String keys are the app's strings.xml names (see locales/en/common.js).
//
// Fields:
//   id        route: #/tool/<id>
//   title, detail, keywords   string keys (keywords: hidden comma-separated words for Home's search)
//   icon      icon name in core/icons.js
//   module    the tool's screen module, relative to site/app/js/
//   accepts   the kind of file the tool opens: 'pdf', 'image', 'docx', 'pptx', 'xlsx', 'epub'
//   multiple  takes several files at once
//   batch     makes a PDF of each file, one after another (Compress, Page numbers, Watermark,
//             Flatten, and the four converters): each file gets its own name, "PDF 2 of 5" progress
//   params    passed to the module's mount() as ctx.params (the converters share one module)

export const TOOLS = {
  scan: {
    id: 'scan', title: 'scan_title', detail: 'scan_detail', keywords: 'search_keywords_scan',
    icon: 'document_scanner', module: 'tools/images/index.js', accepts: 'image', multiple: true,
    params: { start: 'scan' },
  },
  images: {
    id: 'images', title: 'tool_images', detail: 'tool_images_detail', keywords: 'search_keywords_images',
    icon: 'picture_as_pdf', module: 'tools/images/index.js', accepts: 'image', multiple: true,
  },
  word: {
    id: 'word', title: 'tool_word', detail: 'tool_word_detail', keywords: 'search_keywords_word',
    icon: 'description', module: 'tools/office/index.js', accepts: 'docx', multiple: true, batch: true,
    params: { kind: 'word' },
  },
  powerpoint: {
    id: 'powerpoint', title: 'tool_powerpoint', detail: 'tool_powerpoint_detail', keywords: 'search_keywords_powerpoint',
    icon: 'slideshow', module: 'tools/office/index.js', accepts: 'pptx', multiple: true, batch: true,
    params: { kind: 'powerpoint' },
  },
  excel: {
    id: 'excel', title: 'tool_excel', detail: 'tool_excel_detail', keywords: 'search_keywords_excel',
    icon: 'table_chart', module: 'tools/office/index.js', accepts: 'xlsx', multiple: true, batch: true,
    params: { kind: 'excel' },
  },
  epub: {
    id: 'epub', title: 'tool_epub', detail: 'tool_epub_detail', keywords: 'search_keywords_epub',
    icon: 'auto_stories', module: 'tools/office/index.js', accepts: 'epub', multiple: true, batch: true,
    params: { kind: 'epub' },
  },
  merge: {
    id: 'merge', title: 'tool_merge', detail: 'tool_merge_detail', keywords: 'search_keywords_merge',
    icon: 'collections', module: 'tools/merge/index.js', accepts: 'pdf', multiple: true,
  },
  split: {
    id: 'split', title: 'tool_split', detail: 'tool_split_detail', keywords: 'search_keywords_split',
    icon: 'splitscreen', module: 'tools/split/index.js', accepts: 'pdf',
  },
  reorganize: {
    id: 'reorganize', title: 'tool_reorganize', detail: 'tool_reorganize_detail', keywords: 'search_keywords_reorganize',
    icon: 'grid_view', module: 'tools/reorganize/index.js', accepts: 'pdf',
  },
  'delete-pages': {
    id: 'delete-pages', title: 'tool_delete_pages', detail: 'tool_delete_pages_detail', keywords: 'search_keywords_delete_pages',
    icon: 'delete', module: 'tools/delete-pages/index.js', accepts: 'pdf',
  },
  rotate: {
    id: 'rotate', title: 'tool_rotate', detail: 'tool_rotate_detail', keywords: 'search_keywords_rotate',
    icon: 'rotate_right', module: 'tools/rotate/index.js', accepts: 'pdf',
  },
  edit: {
    id: 'edit', title: 'tool_edit', detail: 'tool_edit_detail', keywords: 'search_keywords_edit',
    icon: 'edit_note', module: 'tools/edit/index.js', accepts: 'pdf',
  },
  sign: {
    id: 'sign', title: 'tool_sign', detail: 'tool_sign_detail', keywords: 'search_keywords_sign',
    icon: 'draw', module: 'tools/sign/index.js', accepts: 'pdf',
  },
  'page-numbers': {
    id: 'page-numbers', title: 'tool_page_numbers', detail: 'tool_page_numbers_detail', keywords: 'search_keywords_page_numbers',
    icon: 'format_list_numbered', module: 'tools/page-numbers/index.js', accepts: 'pdf', multiple: true, batch: true,
  },
  watermark: {
    id: 'watermark', title: 'tool_watermark', detail: 'tool_watermark_detail', keywords: 'search_keywords_watermark',
    icon: 'branding_watermark', module: 'tools/watermark/index.js', accepts: 'pdf', multiple: true, batch: true,
  },
  compress: {
    id: 'compress', title: 'tool_compress', detail: 'tool_compress_detail', keywords: 'search_keywords_compress',
    icon: 'compress', module: 'tools/compress/index.js', accepts: 'pdf', multiple: true, batch: true,
  },
  redact: {
    id: 'redact', title: 'tool_redact', detail: 'tool_redact_detail', keywords: 'search_keywords_redact',
    icon: 'visibility_off', module: 'tools/redact/index.js', accepts: 'pdf',
  },
  flatten: {
    id: 'flatten', title: 'tool_flatten', detail: 'tool_flatten_detail', keywords: 'search_keywords_flatten',
    icon: 'layers', module: 'tools/flatten/index.js', accepts: 'pdf', multiple: true, batch: true,
  },
};

/** Home's sections in order, each a heading over its tools (Scan document sits above them). */
export const SECTIONS = [
  { id: 'create', heading: 'home_section_create', tools: ['images', 'word', 'powerpoint', 'excel', 'epub'] },
  { id: 'organize', heading: 'home_section_organize', tools: ['merge', 'split', 'reorganize', 'delete-pages', 'rotate'] },
  { id: 'edit', heading: 'home_section_edit', tools: ['edit', 'sign', 'page-numbers', 'watermark'] },
  { id: 'optimize', heading: 'home_section_optimize', tools: ['compress', 'redact', 'flatten'] },
];

/** The tools that work on PDFs, for "Choose a tool" (PDFs shared to or opened with the app). */
export const PDF_TOOLS = SECTIONS.flatMap((s) => s.tools).filter((id) => TOOLS[id].accepts === 'pdf');
