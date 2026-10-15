export interface Book {
  id: string;
  title: string;
  pageCount: number;
  lastPage: number;
  addedAt: number;
  openedAt: number | null;
  /** Which shelf it sits on. Missing on records made before papers existed: a book. */
  kind?: ShelfKind;
  /** Papers only: the folder it's filed under; missing or null when uncategorized. */
  folder?: string | null;
  /** Detected once in the background: real text, an OCR layer over scans, or scans only. */
  textLayer?: TextLayerKind;
  bookmarkCount?: number;
  /**
   * The PDF page where the body text's page 1 is printed. Citations in notes
   * use printed page numbers, counted from here. Asked on first use.
   */
  bodyStart?: number;
  /** Don't explain again that pages before the body get a [p x] placeholder. */
  citeHintOff?: boolean;
  /** Papers: translation run (MinerU parse + LLM), kept in translations/<id>.json. */
  translation?: { state: 'running' | 'done' | 'failed'; at?: number; error?: string };
  /** Hosted OCR run (PaddleOCR), kept apart from the PDF's own text. */
  ocr?: { state: 'running' | 'done' | 'failed'; model?: string; at?: number; error?: string };
}

export type ShelfKind = 'book' | 'paper';

/** A category in the paper library. */
export interface Folder {
  id: string;
  name: string;
}

/** Where imported files go. */
export interface ImportTarget {
  kind: ShelfKind;
  folder?: string | null;
}

/** Live progress of an OCR run, pushed from the main process. */
export interface OcrProgress {
  state: 'queued' | 'running' | 'done' | 'failed';
  done?: number;
  total?: number;
  /** Pages whose results are on disk; grows chunk by chunk. */
  saved?: number;
  error?: string;
}

export interface TranslationProgress {
  state: 'queued' | 'parsing' | 'translating' | 'done' | 'failed';
  /** Pages parsed, or pieces translated. */
  done?: number;
  total?: number;
  error?: string;
}

/** Where a block sits: 1-based page, box on a 0–1000 grid of that page. */
export interface BlockPart {
  page: number;
  bbox: [number, number, number, number];
}

export type BlockKind =
  | 'heading' | 'para' | 'quote' | 'note' | 'ref' | 'list' | 'equation' | 'image' | 'table' | 'skipped';

/** A paper block in reading order; a paragraph cut by a page break has one part per page. */
export interface PaperBlock {
  id: string;
  kind: BlockKind;
  parts: BlockPart[];
  text?: string;
  level?: number;
  items?: string[];
  latex?: string;
  html?: string;
  caption?: string;
  footnote?: string;
  label?: string;
}

/** A translated piece (a block, or a list item / caption / table of one), as Markdown. */
export interface TranslatedPiece {
  /** Machine translation. */
  mt?: string;
  /** The reader's own wording; wins over `mt`. */
  edit?: string;
  flag?: string;
}

export interface PaperTranslation {
  blocks?: PaperBlock[];
  field?: string;
  terms?: { en: string; zh: string }[];
  model?: string;
  pieces: Record<string, TranslatedPiece>;
  finishedAt?: number;
}

/** Translation settings for the settings screen; secrets come masked. */
export type TranslateField = 'mineruKey' | 'mineruModel' | 'llmBaseUrl' | 'llmModel' | 'llmKey' | 'llmWorkers';
export type TranslateInfo = Record<TranslateField, { source: 'saved' | 'dev' | null; value: string | number | null }>;

/**
 * A recognized line: its text, then the polygon's four corners clockwise from
 * the top left, as fractions of the page width and height.
 */
export type OcrLine = [string, number, number, number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Annotations. Positions are fractions of the page as shown (0..1), like OCR lines.

export type MarkColor = 'yellow' | 'green' | 'blue' | 'pink' | 'red';
export type MarkStyle = 'highlight' | 'underline' | 'wavy';

/** Highlight / underline / wavy line over selected text. */
export interface TextMark {
  id: string;
  page: number;
  style: MarkStyle;
  color: MarkColor;
  /** One box per line: [x, y, width, height]. */
  rects: [number, number, number, number][];
  /** The marked text, for lists and notes later. */
  text: string;
  createdAt: number;
}

export type NumberStampType = 'num-circle' | 'num-square' | 'num-solid';
export type StampType = 'check' | 'cross' | NumberStampType | 'question' | 'exclaim' | 'star';

export interface Stamp {
  id: string;
  page: number;
  type: StampType;
  /** Centre of the stamp. */
  x: number;
  y: number;
  /** Side length, as a fraction of the page width (stamps are square). */
  size: number;
  /** Number stamps only. */
  n?: number;
  /** Missing on stamps made before colors existed: red. */
  color?: MarkColor;
  createdAt: number;
}

export interface Annotations {
  version: 1;
  marks: TextMark[];
  stamps: Stamp[];
  /** Next number per number style; runs across the whole book. */
  counters: Record<NumberStampType, number>;
}

export interface OcrTokenInfo {
  /** 'saved': set in settings; 'dev': from .env or PADDLEOCR_ACCESS_TOKEN. */
  source: 'saved' | 'dev' | null;
  masked: string | null;
}

export interface OcrData {
  model: string;
  total: number;
  /** Keyed by 1-based page number; only pages recognized so far. */
  pages: Record<string, { lines: OcrLine[] }>;
  finishedAt: number | null;
}

export type TextLayerKind = 'native' | 'ocr' | 'none';

/** Bookmarks are kept in page order; `level` gives the outline depth. */
export interface Bookmark {
  id: string;
  title: string;
  page: number;
  level: number;
}

/**
 * A note. Its page range lives in the Markdown source itself, as front matter:
 *
 *   ---
 *   页码: 12-18     (12- while the note is still open)
 *   ---
 */
export interface Segment {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface TrashItem {
  id: string;
  content: string;
  deletedAt: number;
}

export interface Notebook {
  version: 3;
  segments: Segment[];
  trash: TrashItem[];
  /** One free-form note per book, not bound to any page. */
  free?: { content: string; updatedAt: number };
}

export interface Api {
  listBooks(): Promise<Book[]>;
  importBooks(target?: ImportTarget): Promise<Book[]>;
  importFiles(files: File[], target?: ImportTarget): Promise<Book[]>;
  updateBook(id: string, patch: Partial<Book>): Promise<Book[]>;
  removeBook(id: string): Promise<Book[]>;
  listFolders(): Promise<Folder[]>;
  addFolder(name: string): Promise<Folder[]>;
  renameFolder(id: string, name: string): Promise<Folder[]>;
  /** Papers filed under it become uncategorized. */
  removeFolder(id: string): Promise<{ books: Book[]; folders: Folder[] }>;
  readBook(id: string): Promise<Uint8Array>;
  listNotes(bookId: string): Promise<Partial<Notebook> | null>;
  saveNotes(bookId: string, notebook: Notebook): Promise<void>;
  /** null until the book's bookmarks were first imported from the PDF. */
  listBookmarks(bookId: string): Promise<Bookmark[] | null>;
  saveBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void>;
  startOcr(bookId: string): Promise<void>;
  ocrStatus(): Promise<Record<string, OcrProgress>>;
  loadOcr(bookId: string): Promise<OcrData | null>;
  /** null until the book has annotations. */
  listAnnotations(bookId: string): Promise<Annotations | null>;
  saveAnnotations(bookId: string, annotations: Annotations): Promise<void>;
  /** Where the OCR token comes from, never the token itself. */
  ocrTokenInfo(): Promise<OcrTokenInfo>;
  /** Verifies the token with the service, then stores it encrypted. Resolves to an error message, or null. */
  saveOcrToken(token: string): Promise<string | null>;
  clearOcrToken(): Promise<void>;
  startTranslation(bookId: string): Promise<void>;
  translationStatus(): Promise<Record<string, TranslationProgress>>;
  /** null until a translation was started. */
  loadTranslation(bookId: string): Promise<PaperTranslation | null>;
  /** Save the reader's wording for a piece; null restores the machine translation. */
  editTranslation(bookId: string, id: string, text: string | null): Promise<TranslatedPiece | null>;
  retranslatePiece(bookId: string, id: string): Promise<{ piece?: TranslatedPiece; error?: string }>;
  translateInfo(): Promise<TranslateInfo>;
  /** Empty strings clear a field. Resolves to an error message, or null. */
  saveTranslateSettings(patch: Partial<Record<TranslateField, string | number>>): Promise<string | null>;
  /** Resolves to an error message, or null. */
  checkTranslateSettings(
    which: 'mineru' | 'llm',
    draft?: Partial<Record<TranslateField, string | number>>,
  ): Promise<string | null>;
  onTranslationProgress(fn: (bookId: string, progress: TranslationProgress | undefined) => void): () => void;
  /** Subscribe to OCR progress; returns an unsubscribe. */
  onOcrProgress(fn: (bookId: string, progress: OcrProgress | undefined) => void): () => void;
  /** ⌘Z / ⌘⇧Z (Ctrl+Z / Ctrl+Y), taken from the keyboard by the main process. */
  onEditHistory(fn: (action: 'undo' | 'redo') => void): () => void;
  /** Run `fn` before the window closes, waiting for its promise. Returns an unsubscribe. */
  onBeforeClose(fn: () => Promise<unknown>): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;
