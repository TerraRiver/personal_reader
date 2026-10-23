// A copy of the PDF with the hosted OCR text written in as an invisible text layer,
// so other PDF readers can select, copy and search the scanned pages.
//
// The text goes where the reader's own text layer puts it (PdfViewer's renderOcrLayer):
// one run per recognized line, stretched to the line's box and turned to its angle,
// drawn in rendering mode 3 (no paint). Instead of embedding a CJK font, a tiny font
// with a single blank glyph is used, as Tesseract does: every character gets its own
// code, all codes show the blank glyph, and a ToUnicode map turns the codes back into
// the recognized characters for copying and searching.

const { PDFDocument, PDFName, PDFString, EncryptedPDFError } = require('pdf-lib');

const FONT_NAME = 'GlyphLessFont';
const ADVANCE = 500; // glyph width in 1/1000 em
// A conventional ascent and descent: macOS (Preview, PDFKit) drops the text of a font whose descent is 0.
const ASCENT = 800;
const DESCENT = -200;

// ---------- the font ----------

/** A TrueType font with an empty .notdef and one blank glyph, 500 units wide. */
function glyphlessFont() {
  const u16 = (...v) => v.flatMap((n) => [(n >> 8) & 0xff, n & 0xff]);
  const u32 = (...v) => v.flatMap((n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const utf16 = (s) => [...s].flatMap((c) => u16(c.charCodeAt(0)));

  const names = ['', FONT_NAME, 'Regular', FONT_NAME, FONT_NAME, 'Version 1.0', FONT_NAME];
  const records = [];
  let strings = [];
  names.forEach((s, id) => {
    if (!s) return;
    const bytes = utf16(s);
    records.push(...u16(3, 1, 0x409, id, bytes.length, strings.length));
    strings = strings.concat(bytes);
  });
  const nameCount = records.length / 12;

  const tables = {
    'OS/2': [
      ...u16(4, ADVANCE, 400, 5, 0), // version, xAvgCharWidth, weight, width, fsType
      ...u16(650, 600, 0, 75, 650, 600, 0, 350, 50, 250, 0), // sub/superscript, strikeout, family class
      ...new Array(10).fill(0), // panose
      ...u32(0, 0, 0, 0), // unicode ranges
      ...[...'NONE'].map((c) => c.charCodeAt(0)),
      ...u16(0x40, 0, 0xffff, ASCENT, DESCENT & 0xffff, 0, ASCENT, -DESCENT), // fsSelection, first/last char, typo and win metrics
      ...u32(1, 0), // code page ranges
      ...u16(500, ASCENT, 0, 32, 0), // xHeight, capHeight, default char, break char, max context
    ],
    // Format 4 with only the closing segment: no character maps to a glyph by itself.
    cmap: [...u16(0, 1, 3, 1), ...u32(12), ...u16(4, 24, 0, 2, 2, 0, 0, 0xffff, 0, 0xffff, 1, 0)],
    glyf: [],
    head: [
      ...u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5),
      ...u16(0x000b, 1000),
      ...u32(0, 0, 0, 0), // created, modified
      ...u16(0, DESCENT & 0xffff, ADVANCE, ASCENT, 0, 8, 2, 0, 0), // bbox, macStyle, lowestRecPPEM, direction hint, short loca, glyph format
    ],
    hhea: [...u32(0x00010000), ...u16(ASCENT, DESCENT & 0xffff, 0, ADVANCE, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2)],
    hmtx: u16(ADVANCE, 0, ADVANCE, 0),
    loca: u16(0, 0, 0),
    maxp: [...u32(0x00010000), ...u16(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)],
    name: [...u16(0, nameCount, 6 + records.length), ...records, ...strings],
    post: [...u32(0x00030000, 0), ...u16(-100 & 0xffff, 50), ...u32(1, 0, 0, 0, 0)],
  };

  const tags = Object.keys(tables).sort();
  const pad = (b) => b.concat(new Array((4 - (b.length % 4)) % 4).fill(0));
  const sum = (b) => {
    let s = 0;
    for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) >>> 0;
    return s;
  };
  const pow = 2 ** Math.floor(Math.log2(tags.length));
  const header = [...u32(0x00010000), ...u16(tags.length, pow * 16, Math.log2(pow), tags.length * 16 - pow * 16)];
  let offset = header.length + tags.length * 16;
  const dir = [];
  const body = [];
  for (const tag of tags) {
    const t = tables[tag];
    dir.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(sum(pad([...t])), offset, t.length));
    body.push(...pad([...t]));
    offset += pad([...t]).length;
  }
  const font = Uint8Array.from([...header, ...dir, ...body]);
  // head.checkSumAdjustment makes the whole font sum to 0xB1B0AFBA.
  const adjust = (0xb1b0afba - sum(pad([...font]))) >>> 0;
  const at = header.length + dir.length + tags.slice(0, tags.indexOf('head')).reduce((n, t) => n + pad([...tables[t]]).length, 0) + 8;
  font.set(u32(adjust), at);
  return font;
}

// ---------- geometry ----------

/**
 * Maps a point given as fractions of the page as shown (top-left origin, y down,
 * after /Rotate) to PDF user space.
 */
function pageMapper(page) {
  const { x, y, width: w, height: h } = page.getCropBox();
  const rotate = ((page.getRotation().angle % 360) + 360) % 360;
  const [sw, sh] = rotate % 180 ? [h, w] : [w, h]; // size as shown
  return (u, v) => {
    const dx = u * sw;
    const dy = v * sh;
    if (rotate === 90) return [x + dy, y + dx];
    if (rotate === 180) return [x + w - dx, y + dy];
    if (rotate === 270) return [x + w - dy, y + h - dx];
    return [x + dx, y + h - dy];
  };
}

const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 1000) / 1000));

/**
 * Text operators for one line. Like the reader's text layer: the box's top edge gives
 * the direction and width, its left edge the height; a column of upright characters
 * (vertical Chinese) is written one character at a time down the column.
 */
function lineOps(line, map, code) {
  const [text, x0, y0, x1, y1, , , x3, y3] = line;
  const chars = [...text];
  const p0 = map(x0, y0);
  const p1 = map(x1, y1);
  const p3 = map(x3, y3);
  const along = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const across = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  if (!chars.length || !along || !across) return '';
  const ux = (p1[0] - p0[0]) / along;
  const uy = (p1[1] - p0[1]) / along;
  // Writes `str` filling the box whose bottom-left corner is (bx, by), `size` high and `width` long:
  // the baseline sits above the bottom by the font's descent.
  const run = (str, bx, by, size, width) => {
    const n = [...str].length;
    const scale = (100 * width) / ((n * ADVANCE * size) / 1000);
    const lift = (-DESCENT / 1000) * size;
    const ox = bx - uy * lift;
    const oy = by + ux * lift;
    const hex = [...str].map((c) => code(c).toString(16).padStart(4, '0')).join('');
    return `/FOcr ${fmt(size)} Tf ${fmt(scale)} Tz ${fmt(ux)} ${fmt(uy)} ${fmt(-uy)} ${fmt(ux)} ${fmt(ox)} ${fmt(oy)} Tm <${hex}> Tj\n`;
  };
  const vertical = across > along * 1.5 && chars.length > 1;
  if (!vertical) return run(text, p3[0], p3[1], across, along);
  const step = across / chars.length;
  const dx = (p3[0] - p0[0]) / across;
  const dy = (p3[1] - p0[1]) / across;
  // Each character fills its cell, so selecting down the column leaves no gaps.
  return chars.map((c, i) => run(c, p0[0] + dx * step * (i + 1), p0[1] + dy * step * (i + 1), step, along)).join('');
}

// ---------- export ----------

/**
 * The PDF with an invisible text layer on every page OCR recognized.
 * `onPage(done, total)` reports progress. Throws a message fit for the user.
 */
async function exportOcrPdf(pdfBytes, ocr, onPage = () => {}) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) throw new Error('这个 PDF 已加密，无法导出文字层');
    throw new Error(`这个 PDF 无法导出文字层：${err.message}`);
  }
  const ctx = doc.context;
  const fontRef = ctx.nextRef();
  const codes = new Map(); // character -> code; 0 stays .notdef
  const code = (c) => {
    if (!codes.has(c)) codes.set(c, codes.size + 1);
    return codes.get(c);
  };

  const pages = doc.getPages();
  const numbers = Object.keys(ocr.pages ?? {}).map(Number).filter((n) => n >= 1 && n <= pages.length);
  let done = 0;
  for (const n of numbers) {
    const lines = ocr.pages[n].lines ?? [];
    const page = pages[n - 1];
    const map = pageMapper(page);
    const ops = lines.map((l) => lineOps(l, map, code)).join('');
    if (ops) {
      page.node.normalize(); // wraps the page's own content in q / Q
      page.node.setFontDictionary(PDFName.of('FOcr'), fontRef);
      const stream = ctx.flateStream(`q BT 3 Tr\n${ops}ET Q\n`);
      page.node.addContentStream(ctx.register(stream));
    }
    onPage(++done, numbers.length);
    // Let the main process breathe between pages of a long book.
    if (done % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  if (codes.size > 0xfffe) throw new Error('这本书用到的字符太多，无法导出文字层');

  // The font, now that every character has its code.
  const max = codes.size;
  const toGlyph = new Uint8Array((max + 1) * 2);
  for (let c = 1; c <= max; c++) toGlyph[c * 2 + 1] = 1; // every code shows glyph 1
  const entries = [...codes].map(([c, n]) => {
    const utf16 = [...c].flatMap((ch) => {
      const s = [];
      for (let i = 0; i < ch.length; i++) s.push(ch.charCodeAt(i).toString(16).padStart(4, '0'));
      return s;
    });
    return `<${n.toString(16).padStart(4, '0')}> <${utf16.join('')}>`;
  });
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100)
    chunks.push(`${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join('\n')}\nendbfchar`);
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');

  const ttf = glyphlessFont();
  const descriptor = ctx.obj({
    Type: 'FontDescriptor',
    FontName: FONT_NAME,
    Flags: 5, // fixed pitch, symbolic
    FontBBox: [0, DESCENT, ADVANCE, ASCENT],
    ItalicAngle: 0,
    Ascent: ASCENT,
    Descent: DESCENT,
    CapHeight: ASCENT,
    StemV: 80,
    FontFile2: ctx.register(ctx.flateStream(ttf, { Length1: ttf.length })),
  });
  const cidFont = ctx.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: FONT_NAME,
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
    FontDescriptor: ctx.register(descriptor),
    DW: ADVANCE,
    CIDToGIDMap: ctx.register(ctx.flateStream(toGlyph)),
  });
  ctx.assign(
    fontRef,
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: FONT_NAME,
      Encoding: 'Identity-H',
      DescendantFonts: [ctx.register(cidFont)],
      ToUnicode: ctx.register(ctx.flateStream(toUnicode)),
    }),
  );
  return doc.save();
}

module.exports = { exportOcrPdf, glyphlessFont };
