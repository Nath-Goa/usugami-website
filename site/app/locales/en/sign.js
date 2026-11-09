// Sign PDF's strings (js/tools/sign/). Keys and English texts are the Android app's (strings.xml);
// those the app doesn't have start with web_. Shared ones (Choose PDF, File name, Page 3, Working
// on your PDF…, the result screen) are in common.js and kit.js.
export default {
  pdf_sign_action: 'Sign PDF',
  sign_signature: 'Signature',
  sign_draw: 'Draw your signature',
  sign_change: 'Change signature',
  // A picture of a handwritten signature, never a certified digital one: the screen says so.
  sign_note: "Your signature is added to the page as a picture. This isn't a certified digital signature.",
  sign_pad: 'Signature pad',
  sign_pad_hint: 'Sign above the line with your finger.',
  sign_ink: 'Ink',
  sign_clear: 'Clear',
  sign_page: 'Page to sign',
  sign_place: 'Place your signature',
  sign_place_hint: 'Drag the signature, or tap where it should go.',
  // {1} is a page number.
  sign_preview_description: 'Your signature on page {1}',
  sign_size_description: 'Signature size',
  sign_move_left: 'Move signature left',
  sign_move_up: 'Move signature up',
  sign_move_down: 'Move signature down',
  sign_move_right: 'Move signature right',

  // ---- The web app's own strings ----

  // On computers, where a mouse or a pen signs too.
  web_sign_pad_hint: 'Sign above the line with your mouse, pen or finger.',
  web_sign_place_hint: 'Drag the signature, or click where it should go.',
  // Read out on the signature in the preview, for keyboards.
  web_sign_keys_hint: 'Arrow keys move it.',
  // The signature's size, read out by the size slider: {1} is a percentage of its range.
  web_sign_size_value: '{1}%',
};
