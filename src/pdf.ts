import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, type Bookmark, type TextLayerKind } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

// ---------------------------------------------------------------------------
// Outline → bookmarks

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

async function destPage(doc: PDFDocumentProxy, dest: OutlineItem['dest']): Promise<number | null> {
  try {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(d)) return null;
    const ref = d[0];
    if (typeof ref === 'number') return ref + 1;
    if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref)) + 1;
  } catch {
    // Broken destinations are common; such items are skipped.
  }
  return null;
}

/** The PDF's own outline, flattened in reading order. */
export async function readOutline(doc: PDFDocumentProxy): Promise<Bookmark[]> {
  const out: Bookmark[] = [];
  const walk = async (items: OutlineItem[], level: number) => {
    for (const it of items) {
      const page = await destPage(doc, it.dest);
      if (page) out.push({ id: crypto.randomUUID(), title: it.title.trim() || '未命名', page, level });
      await walk(it.items ?? [], page ? level + 1 : level);
    }
  };
  await walk((await doc.getOutline()) ?? [], 0);
  return out;
}

/** Bookmarks of a book, imported from the PDF outline the first time. */
export async function loadBookmarks(bookId: string, doc: PDFDocumentProxy): Promise<Bookmark[]> {
  const saved = await api().listBookmarks(bookId);
  if (saved) return saved;
  const imported = await readOutline(doc);
  await api().saveBookmarks(bookId, imported);
  return imported;
}

// ---------------------------------------------------------------------------
// Text layer detection

const IMAGE_OPS = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageMaskXObjectGroup,
  pdfjs.OPS.paintImageMaskXObjectRepeat,
]);

type PageKind = 'native' | 'ocr' | 'scan' | 'blank';

async function pageKind(doc: PDFDocumentProxy, n: number): Promise<PageKind> {
  const page = await doc.getPage(n);
  const text = await page.getTextContent();
  const chars = text.items.reduce((sum, it) => sum + ('str' in it ? it.str.trim().length : 0), 0);
  const ops = await page.getOperatorList();
  let image = false;
  let invisible = false;
  ops.fnArray.forEach((fn, i) => {
    if (IMAGE_OPS.has(fn)) image = true;
    // Rendering modes 3 and 7 draw no glyphs: the typical OCR text layer.
    if (fn === pdfjs.OPS.setTextRenderingMode && [3, 7].includes(ops.argsArray[i]?.[0])) invisible = true;
  });
  page.cleanup();
  if (chars >= 20) return image && invisible ? 'ocr' : 'native';
  return image ? 'scan' : 'blank';
}

/** Samples pages across the book and decides what kind of text it has. */
export async function detectTextLayer(doc: PDFDocumentProxy): Promise<TextLayerKind> {
  const n = doc.numPages;
  const samples = [...new Set(Array.from({ length: Math.min(8, n) }, (_, i) => 1 + Math.floor(((i + 0.5) * n) / Math.min(8, n))))];
  const count: Record<PageKind, number> = { native: 0, ocr: 0, scan: 0, blank: 0 };
  for (const p of samples) count[await pageKind(doc, p)]++;
  if (count.native + count.ocr === 0 || count.scan > count.native + count.ocr) return 'none';
  return count.ocr >= count.native ? 'ocr' : 'native';
}

/** Opens a stored book, runs both checks, and records the results on the book. */
export async function analyzeBook(bookId: string) {
  const task = pdfjs.getDocument({ data: await api().readBook(bookId) });
  const doc = await task.promise;
  try {
    const [textLayer, bookmarks] = await Promise.all([detectTextLayer(doc), loadBookmarks(bookId, doc)]);
    return api().updateBook(bookId, { textLayer, bookmarkCount: bookmarks.length, pageCount: doc.numPages });
  } finally {
    task.destroy();
  }
}
