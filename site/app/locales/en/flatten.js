// Flatten PDF (tools/flatten/, engine/flatten.js). Keys and English texts are the Android app's
// (strings.xml); those the app doesn't have start with web_. "{names}: {text}" (file_problem) and
// Couldn't process … (batch_failed) are common.js's.
export default {
  pdf_flatten_action: 'Flatten PDF',
  // The button with several PDFs (never fewer than 2).
  pdf_flatten_action_many: { one: 'Flatten {1} PDF', other: 'Flatten {1} PDFs' },
  flatten_note: "Form fields, comments and drawings become part of the page, so they can't be changed or filled in anymore. Links keep working.",
  flatten_nothing: 'This PDF has no form fields or comments to flatten.',
  // XFA is a kind of PDF form; keep the name.
  flatten_xfa_only: "This PDF's form is a dynamic XFA form, which Usugami can't flatten.",
  flatten_xfa_only_many: "These PDFs' forms are dynamic XFA forms, which Usugami can't flatten.",
  flatten_xfa_dropped: 'This PDF had a dynamic XFA form, which was removed. Its other form fields and comments were flattened.',
  flatten_xfa_dropped_many: 'These PDFs had a dynamic XFA form, which was removed. Their other form fields and comments were flattened.',
  // Fields whose text the form's own font can't draw are left as fields rather than come out blank.
  flatten_fields_kept: {
    one: "{1} form field has text that Usugami can't draw with its font, so it was left fillable to keep that text.",
    other: "{1} form fields have text that Usugami can't draw with their font, so they were left fillable to keep that text.",
  },
  flatten_fields_kept_many: "Some form fields have text that Usugami can't draw with their font, so they were left fillable to keep that text.",
  // Several PDFs: {1} counts those with nothing to flatten (never 0), {2} lists their names.
  batch_nothing_to_flatten: {
    one: '{2} has no form fields or comments to flatten, so it was left out.',
    other: '{1} PDFs have no form fields or comments to flatten, so they were left out: {2}.',
  },

  // ---- The web app's own strings ----

};
