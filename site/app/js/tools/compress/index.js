// Compress PDF (PdfToolScreen.kt's CompressOptions and CompressBatch, PdfToolsViewModel's
// runCompress and runCompressAll): Less, Recommended or Extreme for one PDF, or for several PDFs at
// once with a level of its own for any of them, each into a PDF of its own name. The engine
// (engine/compress.js) is loaded while the PDFs are picked.
import { t, loadStrings } from '../../core/i18n.js';
import { withSuffix, baseName } from '../../core/names.js';
import { mountPdfBatchTool } from './batch-screen.js';

/** The levels in the order the app shows them (PdfCompression), by their number in BatchChoices. */
export const LEVELS = ['less', 'recommended', 'extreme'];
const LABELS = { less: 'compression_less', recommended: 'compression_recommended', extreme: 'compression_extreme' };

/** The level every PDF starts with: Recommended (DEFAULT_BATCH_CHOICE). */
export const DEFAULT_CHOICE = 1;

/** The engine's level for choice number `choice`; Recommended for one out of range (compressionOf). */
export function levelOf(choice) {
  return LEVELS[choice] ?? LEVELS[DEFAULT_CHOICE];
}

/**
 * The name a compressed PDF gets until another is typed (defaultName(COMPRESS)): "Report.pdf"
 * becomes "Report_compressed". The same as the engine's, which isn't loaded yet when it is needed.
 */
export function defaultCompressName(input) {
  return withSuffix(baseName(input?.name ?? ''), '_compressed', 'Usugami');
}

/** Renders Compress PDF into ctx.root. */
export async function mount(ctx) {
  await loadStrings('compress');
  return mountPdfBatchTool(ctx, {
    id: 'compress',
    action: 'pdf_compress_action',
    actionMany: 'pdf_compress_action_many',
    defaultName: defaultCompressName,
    fallback: 'Compressed',
    batchName: 'Compressed_PDFs',
    choice: {
      options: LEVELS.map((level, i) => ({ value: i, label: t(LABELS[level]) })),
      all: DEFAULT_CHOICE,
      title: t('compression_title'),
      forAllTitle: t('compression_for_all'),
      note: t('pdf_compress_note'),
      // Two sentences, as the app puts them under the level for all.
      forAllNote: `${t('compression_for_all_hint')} ${t('pdf_compress_note')}`,
    },
    engine: () => import('../../engine/compress.js'),
    work: (engine, src, { name, choice }, hooks) => engine.compressPdf(
      { name: src.name, bytes: src.bytes, password: src.password },
      { level: levelOf(choice), name },
      hooks,
    ),
    notes: (engine, outcomes) => engine.compressNotes(outcomes),
  });
}
