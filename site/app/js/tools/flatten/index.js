// Flatten PDF (PdfToolScreen.kt with FlattenOptions, PdfToolsViewModel's runFlatten and
// runFlattenAll): form fields, comments and drawings of one PDF or several become part of their
// pages, each PDF into a PDF of its own name. One with nothing to flatten is left out and named;
// fields whose text their font can't show are kept and reported. It shares Compress PDF's screen.
import { t, loadStrings } from '../../core/i18n.js';
import { withSuffix, baseName } from '../../core/names.js';
import { mountPdfBatchTool } from '../compress/batch-screen.js';

/** The name a flattened PDF gets until another is typed (defaultName(FLATTEN)): "form_flattened". */
export function defaultFlattenName(input) {
  return withSuffix(baseName(input?.name ?? ''), '_flattened', 'Usugami');
}

/** Renders Flatten PDF into ctx.root. */
export async function mount(ctx) {
  await loadStrings('flatten');
  return mountPdfBatchTool(ctx, {
    id: 'flatten',
    action: 'pdf_flatten_action',
    actionMany: 'pdf_flatten_action_many',
    defaultName: defaultFlattenName,
    fallback: 'Flattened',
    batchName: 'Flattened_PDFs',
    // Flatten PDF has no choices: one line says what it does.
    note: t('flatten_note'),
    engine: () => import('../../engine/flatten.js'),
    work: (engine, src, { name }, hooks) => engine.flattenPdf(
      { name: src.name, bytes: src.bytes, password: src.password },
      { name },
      hooks,
    ),
    notes: (engine, outcomes) => engine.flattenNotes(outcomes),
  });
}
