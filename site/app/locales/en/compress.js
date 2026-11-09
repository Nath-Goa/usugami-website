// Compress PDF (tools/compress/, engine/compress.js). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. The result screen's "Compressed from …"
// and "Already compact…" lines are the kit's (kit.js); Couldn't process … is common.js's batch_failed.
export default {
  pdf_compress_action: 'Compress PDF',
  // The button with several PDFs (never fewer than 2).
  pdf_compress_action_many: { one: 'Compress {1} PDF', other: 'Compress {1} PDFs' },
  pdf_compress_note: 'Text and drawings stay sharp. Images are reduced where it saves space.',
  compression_for_all: 'Compression for all PDFs',
  compression_for_all_hint: 'Change one below to give it a level of its own.',

  // After compressing one PDF that didn't get smaller.
  pdf_no_reduction: 'This PDF is already compact; the original size was kept.',
  // One that had a password, or got the Usugami watermark: it couldn't keep the original, and the
  // new PDF is no smaller.
  pdf_not_smaller: "This PDF couldn't be made any smaller.",
  // Several PDFs: {1} counts those that had a password, or got the Usugami watermark, and came out no
  // smaller (never 0), {2} lists their names.
  batch_not_smaller: { one: "{2} couldn't be made any smaller.", other: "{1} PDFs couldn't be made any smaller: {2}." },

  // ---- The web app's own strings ----

};
