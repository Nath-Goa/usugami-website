// The words of the tool pages (usugami.com/merge-pdf/ and so on), which tools/build-tool-pages.mjs
// turns into site/<slug>/index.html. See "The tool pages" in docs/website.md.
//
// Every statement must be true of the web app as it is: take labels, options and numbers from its
// strings (site/app/locales/en/) and code, and change the page when the tool changes. Visible text
// uses ’ “ ” (never straight quotes), no em dashes, &amp; for &, and only <strong>, <em> and <code>.
//
// Per tool:
//   id          a key of its own (the web app's tool id where there is one)
//   slug        the page's address: usugami.com/<slug>/
//   card        Home's feature card, id="f-<card>" (its name links here; its icon is used)
//   opens       the tool (id) the page's button opens in the web app: ../app/#/tool/<id>
//   name        the tool's name, as the web app and Home show it
//   title       <title> and og:title, ending in ": Usugami" (at most 65 characters)
//   description meta description and og:description (110 to 160 characters)
//   h1, lead    the heading and the sentence or two under it
//   howToHeading, steps   the steps after "Open <tool>" (which the page adds first)
//   featuresHeading, features   what the tool can do, one item each
//   faq         questions and answers about this tool (the shared ones follow them)

const PLACEHOLDER = (name) => ({
  title: `${name} placeholder title: Usugami`,
  description: `${name} placeholder description that is long enough to pass the length check of the builder, with more words here.`,
  h1: name,
  lead: 'Placeholder lead.',
  howToHeading: `How to use ${name}`,
  steps: [{ title: 'Add your files', html: 'Placeholder step.' }, { title: 'Save', html: 'Placeholder step.' }],
  featuresHeading: `What ${name} can do`,
  features: ['Placeholder one.', 'Placeholder two.', 'Placeholder three.'],
  faq: [{ q: 'Placeholder question?', a: 'Placeholder answer.' }],
});

const tool = (id, slug, card, opens, name) => ({ id, slug, card, opens, name, ...PLACEHOLDER(name) });

export const TOOL_PAGES = Object.fromEntries([
  tool('scan', 'scan-to-pdf', 'scan', 'scan', 'Scan document'),
  tool('images', 'images-to-pdf', 'images', 'images', 'Images to PDF'),
  tool('ocr', 'ocr-pdf', 'ocr', 'images', 'Text recognition (OCR)'),
  tool('word', 'word-to-pdf', 'word', 'word', 'Word to PDF'),
  tool('powerpoint', 'powerpoint-to-pdf', 'powerpoint', 'powerpoint', 'PowerPoint to PDF'),
  tool('excel', 'excel-to-pdf', 'excel', 'excel', 'Excel to PDF'),
  tool('epub', 'epub-to-pdf', 'epub', 'epub', 'EPUB to PDF'),
  tool('merge', 'merge-pdf', 'merge', 'merge', 'Merge PDF'),
  tool('split', 'split-pdf', 'split', 'split', 'Split PDF'),
  tool('reorganize', 'reorganize-pdf', 'reorganize', 'reorganize', 'Reorganize PDF'),
  tool('delete-pages', 'delete-pdf-pages', 'delete', 'delete-pages', 'Delete pages'),
  tool('rotate', 'rotate-pdf', 'rotate', 'rotate', 'Rotate PDF'),
  tool('edit', 'edit-pdf', 'edit', 'edit', 'Edit PDF'),
  tool('sign', 'sign-pdf', 'sign', 'sign', 'Sign PDF'),
  tool('page-numbers', 'add-page-numbers-to-pdf', 'numbers', 'page-numbers', 'Add page numbers'),
  tool('watermark', 'watermark-pdf', 'watermark', 'watermark', 'Add watermark'),
  tool('compress', 'compress-pdf', 'compress', 'compress', 'Compress PDF'),
  tool('redact', 'redact-pdf', 'redact', 'redact', 'Redact PDF'),
  tool('flatten', 'flatten-pdf', 'flatten', 'flatten', 'Flatten PDF'),
].map((t) => [t.id, t]));

/** The parts every tool page shares. */
export const SHARED = {
  // The social preview image (assets/img/social-preview.png), for og:image:alt.
  ogImageAlt: 'Usugami, 薄紙 (thin paper): PDF tools that stay on your phone. Free and open source, no ads, no permissions.',
  // The first step; {open} is the button’s text (“Open Merge PDF”).
  openStep: 'Use the <strong>{open}</strong> button at the top of this page. The tool opens in your browser, on a phone, tablet or computer, with nothing to install and nothing to sign up for.',
  privacyHeading: 'Your files stay on your device',
  privacy: [
    'Usugami works on your files in your browser, on your device, and never uploads them. The files you pick and the PDFs it makes never leave your device.',
    'There are no ads, no tracking and no cookies, and you don’t need an account. Tools you have used once keep working offline.',
  ],
  privacyLink: 'How the web app handles your files',
  faq: [
    { q: 'Is Usugami free?', a: 'Yes. Usugami is free and open source, with no ads, no account and nothing to buy.' },
    { q: 'Which browsers does it work in?', a: 'Current Chrome, Edge, Firefox and Safari, on phones, tablets and computers. On an Android phone you can also install the Usugami app, which has the same tools.' },
  ],
  toolsHeading: 'More PDF tools',
  toolsIntro: 'Every tool, grouped as on Usugami’s Home screen.',
};
