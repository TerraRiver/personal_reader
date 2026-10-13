/**
 * Printed page number for a PDF page, given the PDF page where the body's
 * page 1 is. Pages before the body (preface, reviews) have no number: null.
 */
export function printedPage(pdfPage: number, bodyStart: number): number | null {
  const n = pdfPage - bodyStart + 1;
  return n >= 1 ? n : null;
}

/** The citation inserted into a note. */
export const citation = (n: number | null) => `[p ${n ?? 'x'}]`;

/** PDF page for a printed page number; the inverse of printedPage. */
export const pdfPageOf = (printed: number, bodyStart: number) => printed + bodyStart - 1;

// ---------------------------------------------------------------------------
// Preview: citations become links. A tiny remark plugin, so code spans and
// existing links stay untouched.

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

const CITE = /\[p\s*([^\]\s]+)\]/g;
export const CITE_HREF = '#cite-';

export function remarkCitations() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text') {
        walk(child);
        return [child];
      }
      const text = child.value ?? '';
      const out: MdNode[] = [];
      let last = 0;
      for (const m of text.matchAll(CITE)) {
        if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
        out.push({ type: 'link', url: CITE_HREF + encodeURIComponent(m[1]), children: [{ type: 'text', value: m[0] }] });
        last = m.index + m[0].length;
      }
      if (!out.length) return [child];
      if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
      return out;
    });
  };
  return (tree: MdNode) => walk(tree);
}
