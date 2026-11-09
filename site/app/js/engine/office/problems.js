// Why a file can't be converted (OfficeConverter.kt's OfficeFileProblem and its kinds, and
// EpubBook.kt's EpubProtected). Converters throw these; convertOffice() (index.js) turns them into
// the app's messages for the kind of file, as PdfToolsViewModel.officeReason does.

/** Why a file can't be converted, for a message in the user's language. `problem` names the kind. */
export class OfficeFileProblem extends Error {
  constructor(problem, message) {
    super(message);
    this.name = 'OfficeFileProblem';
    this.problem = problem;
  }
}

/** An old binary .doc, .ppt or .xls file. */
export class OfficeLegacyFormat extends OfficeFileProblem {
  constructor() {
    super('legacy', 'Old binary Office format');
  }
}

/** A .docx, .pptx or .xlsx file protected with a password: Office encrypts the whole file. */
export class OfficeEncrypted extends OfficeFileProblem {
  constructor() {
    super('encrypted', 'Password-protected Office file');
  }
}

/** Not a Word document, PowerPoint presentation, Excel workbook or e-book (or not the kind asked for), or damaged. */
export class OfficeNotRecognized extends OfficeFileProblem {
  constructor() {
    super('not-recognized', 'Not an Office file of the kind asked for');
  }
}

/**
 * A presentation with no slides, or only hidden ones; a book with nothing in its reading order; a
 * workbook with nothing on its visible sheets.
 */
export class OfficeNothingToConvert extends OfficeFileProblem {
  constructor() {
    super('nothing', 'Nothing to convert');
  }
}

/** A workbook that would make more pages, or hold more text, than can be laid out. */
export class OfficeTooLarge extends OfficeFileProblem {
  constructor() {
    super('too-large', 'Too large to convert');
  }
}

/** A Word document whose text is all kept in another format inside it (a web page or an RTF file), which isn't read. */
export class OfficeEmbeddedContent extends OfficeFileProblem {
  constructor() {
    super('embedded', 'Text kept in another format');
  }
}

/** A book protected with DRM. */
export class EpubProtected extends OfficeFileProblem {
  constructor() {
    super('protected', 'Book protected with DRM');
  }
}

/**
 * The strings.xml key saying why files of `kind` ('word', 'powerpoint', 'excel', 'epub') can't be
 * converted, for `problem` (an OfficeFileProblem): of one file, or with `many` of several.
 */
export function officeReasonKey(problem, kind, many = false) {
  const key = reasonKey(problem, kind);
  return many ? `${key}_many` : key;
}

function reasonKey(problem, kind) {
  switch (problem?.problem) {
    case 'legacy':
      return kind === 'word' ? 'office_legacy_word' : kind === 'excel' ? 'office_legacy_excel' : 'office_legacy_powerpoint';
    case 'encrypted':
      return kind === 'excel' ? 'office_encrypted_excel' : 'office_encrypted';
    case 'protected':
      return 'epub_protected';
    case 'nothing':
      return kind === 'epub' ? 'epub_empty' : kind === 'excel' ? 'office_no_sheets' : 'office_no_slides';
    case 'embedded':
      return 'office_embedded_content';
    case 'too-large':
      return 'office_too_large';
    default:
      return kind === 'powerpoint' ? 'office_not_powerpoint' : kind === 'excel' ? 'office_not_excel' : kind === 'epub' ? 'epub_not_recognized' : 'office_not_word';
  }
}
