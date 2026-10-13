export interface Book {
  id: string;
  title: string;
  pageCount: number;
  lastPage: number;
  addedAt: number;
  openedAt: number | null;
  /** Detected once in the background: real text, an OCR layer over scans, or scans only. */
  textLayer?: TextLayerKind;
  bookmarkCount?: number;
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
}

export interface Api {
  listBooks(): Promise<Book[]>;
  importBooks(): Promise<Book[]>;
  importFiles(files: File[]): Promise<Book[]>;
  updateBook(id: string, patch: Partial<Book>): Promise<Book[]>;
  removeBook(id: string): Promise<Book[]>;
  readBook(id: string): Promise<Uint8Array>;
  listNotes(bookId: string): Promise<Partial<Notebook> | null>;
  saveNotes(bookId: string, notebook: Notebook): Promise<void>;
  /** null until the book's bookmarks were first imported from the PDF. */
  listBookmarks(bookId: string): Promise<Bookmark[] | null>;
  saveBookmarks(bookId: string, bookmarks: Bookmark[]): Promise<void>;
  /** Run `fn` before the window closes, waiting for its promise. Returns an unsubscribe. */
  onBeforeClose(fn: () => Promise<unknown>): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;
