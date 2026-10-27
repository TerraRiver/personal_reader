// The page the main process prints as the translation PDF (electron/translation-pdf.cjs).
// It opens in a hidden window, lays out the whole book, then calls api().printReady.
// Untranslated pieces stay in the original; `bilingual` adds the original under each translation.

import { useEffect, useState, type CSSProperties } from 'react';
import { api, type PaperBlock, type TranslatedPiece } from '../types';
import { safeTable, shown, tex, Text } from '../components/TranslationPanel';

interface Props {
  bookId: string;
  bilingual: boolean;
  /** Type size in pt and the tallest a figure may be in inches, from the page size. */
  font: number;
  image: number;
}

interface Doc {
  blocks: PaperBlock[];
  pieces: Record<string, TranslatedPiece>;
  /** Object URLs of the figures, by `img`. */
  images: Map<string, string>;
}

export default function PrintTranslation({ bookId, bilingual, font, image }: Props) {
  const [doc, setDoc] = useState<Doc | null>(null);

  useEffect(() => {
    (async () => {
      const [t, books] = await Promise.all([api().loadTranslation(bookId), api().listBooks()]);
      if (!t?.blocks) throw new Error('还没有解析');
      const title = books.find((b) => b.id === bookId)?.title;
      if (title) document.title = title; // the PDF's title
      const blocks = t.blocks.filter((b) => b.kind !== 'skipped');
      const images = new Map<string, string>();
      for (const b of blocks) {
        if (!b.img || b.html || images.has(b.img)) continue;
        const bytes = await api().parsedImage(bookId, b.img);
        if (bytes) images.set(b.img, URL.createObjectURL(new Blob([bytes as BlobPart])));
      }
      setDoc({ blocks, pieces: t.pieces, images });
    })().catch((err) => api().printReady(err.message || '排版失败'));
  }, [bookId]);

  // Laid out: wait for the figures and the formula fonts, then hand over to printing.
  useEffect(() => {
    if (!doc) return;
    (async () => {
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      await document.fonts.ready;
      api().printReady(null);
    })();
  }, [doc]);

  if (!doc) return null;
  const style = { '--pdoc-font': `${font}pt`, '--pdoc-image': `${image}in` } as CSSProperties;
  return (
    <article className="pdoc" style={style}>
      {doc.blocks.map((b) => (
        <PrintBlock key={b.id} block={b} doc={doc} bilingual={bilingual} />
      ))}
    </article>
  );
}

function PrintBlock({ block: b, doc, bilingual }: { block: PaperBlock; doc: Doc; bilingual: boolean }) {
  // The translation of a piece, with the original under it; the original alone when untranslated.
  const piece = (id: string, original: string) => {
    const t = shown(doc.pieces[id]);
    if (t == null) return <Text text={original} />;
    return (
      <>
        <Text text={t} />
        {bilingual && (
          <div className="pdoc-en">
            <Text text={original} />
          </div>
        )}
      </>
    );
  };

  switch (b.kind) {
    case 'heading': {
      const H = (b.level ?? 1) <= 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3';
      const t = shown(doc.pieces[b.id]);
      return (
        <>
          <H>
            <Text text={t ?? b.text ?? ''} />
          </H>
          {bilingual && t != null && (
            <div className="pdoc-en pdoc-en-heading">
              <Text text={b.text ?? ''} />
            </div>
          )}
        </>
      );
    }
    case 'ref':
      return (
        <div className="pdoc-ref">
          <Text text={b.text ?? ''} />
        </div>
      );
    case 'equation':
      return <div className="math" dangerouslySetInnerHTML={{ __html: tex((b.latex ?? '').replace(/^\$\$|\$\$$/g, ''), true) }} />;
    case 'list':
      return (
        <ul>
          {(b.items ?? []).map((t, j) => (
            <li key={j}>{piece(`${b.id}.${j}`, t)}</li>
          ))}
        </ul>
      );
    case 'image':
    case 'table': {
      const caption = b.caption && <div className="pdoc-caption">{piece(`${b.id}.caption`, b.caption)}</div>;
      const html = b.kind === 'table' && (shown(doc.pieces[`${b.id}.html`]) ?? b.html);
      const src = b.img && doc.images.get(b.img);
      const body = html ? (
        <div className="pdoc-table" dangerouslySetInnerHTML={{ __html: safeTable(html) }} />
      ) : src ? (
        <img src={src} alt="" />
      ) : (
        <p className="pdoc-missing">
          （{b.kind === 'table' ? '表' : '图'}见原书第 {b.parts[0].page} 页）
        </p>
      );
      // Tables are captioned above, figures below.
      return (
        <figure className="pdoc-figure">
          {b.kind === 'table' && caption}
          {body}
          {b.kind === 'image' && caption}
          {b.footnote && <div className="pdoc-caption">{piece(`${b.id}.footnote`, b.footnote)}</div>}
        </figure>
      );
    }
    default:
      return <div className={`pdoc-${b.kind}`}>{piece(b.id, b.text ?? '')}</div>;
  }
}
