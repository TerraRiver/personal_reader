// The translation as a PDF of its own, laid out at the original's page size.
//
// A hidden window opens the app on its print page (src/pages/PrintTranslation.tsx),
// which renders the blocks with the translation panel's own Markdown, formulas and
// tables, and reports back once its images and fonts are in. Chromium then prints it;
// the headings become the PDF's outline, and every page gets its number at the foot.

const { BrowserWindow } = require('electron');
const { PDFDocument } = require('pdf-lib');

const A4 = { width: 8.27, height: 11.69 }; // inches, like printToPDF's sizes
const READY_TIMEOUT = 5 * 60_000; // a long book takes a while to lay out

const FOOTER = `<div style="width:100%;text-align:center;font-size:8px;color:#888;font-family:serif">
  <span class="pageNumber"></span></div>`;

/** The most common page size of the PDF, in inches, as shown (crop box, turned by its rotation). */
async function pageSize(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const counts = new Map();
  for (const page of pdf.getPages()) {
    const { width, height } = page.getCropBox();
    const turned = page.getRotation().angle % 180 !== 0;
    const key = (turned ? [height, width] : [width, height]).map(Math.round).join('x');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top) return A4;
  const [width, height] = top[0].split('x').map((pt) => pt / 72);
  // A page this small is a broken box, not a book.
  return width < 2 || height < 2 ? A4 : { width, height };
}

/** Type size and margins for a page: A4 and Letter get 11pt, smaller books 10pt. */
function layout({ width, height }) {
  const side = Math.min(1, Math.max(0.5, width * 0.1));
  const margins = { top: side, bottom: side + 0.15, left: side, right: side }; // the page number sits below
  // Room left for a figure, with a caption under it.
  const image = Math.max(1, height - margins.top - margins.bottom - 0.8);
  return { font: width < 7 ? 10 : 11, image, margins };
}

/**
 * Prints the translation of a book. Resolves to the PDF's bytes.
 * @param original the stored PDF, for its page size
 * @param opts.open(win, query) loads the app into `win` with these search params
 * @param opts.preload path of preload.cjs, which the print page needs for its data
 */
async function exportTranslationPdf(original, { bookId, bilingual, open, preload }) {
  const size = await pageSize(original).catch(() => A4);
  const { font, image, margins } = layout(size);
  const win = new BrowserWindow({
    show: false,
    width: Math.round(size.width * 96),
    height: Math.round(size.height * 96),
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  let timer;
  try {
    const ready = new Promise((resolve, reject) => {
      win.webContents.ipc.once('print:ready', (_e, error) => (error ? reject(new Error(error)) : resolve()));
      win.webContents.once('render-process-gone', () => reject(new Error('排版页面意外退出')));
      timer = setTimeout(() => reject(new Error('排版超时')), READY_TIMEOUT);
    });
    ready.catch(() => {}); // awaited below; a failed load throws first
    await open(win, { print: bookId, bilingual: bilingual ? '1' : '0', font: String(font), image: image.toFixed(2) });
    await ready;
    return await win.webContents.printToPDF({
      pageSize: size,
      margins,
      printBackground: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER,
    });
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}

module.exports = { exportTranslationPdf };
