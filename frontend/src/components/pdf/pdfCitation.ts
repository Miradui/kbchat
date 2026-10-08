export type PdfTextRange = { itemIndex: number; start: number; end: number };

export type PdfCitationMatch =
  | { status: 'matched'; ranges: PdfTextRange[] }
  | { status: 'not-found' | 'ambiguous' };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// PDF extractors disagree on layout spaces and discretionary characters. Keep
// punctuation, case, and ordinary hyphens: a related sentence is not a match.
function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u200b\u00ad]/gu, '');
}

function indexText(text: string) {
  const pieces: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const normalized = normalize(segment);
    pieces.push(normalized);
    // One source grapheme can become several UTF-16 units (ligatures, emoji).
    // Retain its whole original span, including combining marks across items.
    for (let offset = 0; offset < normalized.length; offset += 1) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  return { text: pieces.join(''), starts, ends };
}

/**
 * Locate the complete excerpt in this page's PDF.js text items. Backend PDF
 * byte offsets use a different extractor and are deliberately not accepted.
 * PDF chunks do not have the Markdown splitter's synthetic heading prefix.
 */
export function matchPdfCitation(items: readonly string[], excerpt: string): PdfCitationMatch {
  const needle = normalize(excerpt);
  if (!needle) return { status: 'not-found' };
  const indexed = indexText(items.join(''));
  let matchedStart = -1;
  for (let start = indexed.text.indexOf(needle); start >= 0; start = indexed.text.indexOf(needle, start + 1)) {
    const end = start + needle.length;
    // Do not highlight just part of an expanded ligature or emoji grapheme.
    if ((start > 0 && indexed.starts[start] === indexed.starts[start - 1])
      || (end < indexed.text.length && indexed.ends[end - 1] === indexed.ends[end])) continue;
    if (matchedStart >= 0) return { status: 'ambiguous' };
    matchedStart = start;
  }
  if (matchedStart < 0) return { status: 'not-found' };

  const sourceStart = indexed.starts[matchedStart];
  const sourceEnd = indexed.ends[matchedStart + needle.length - 1];
  const ranges: PdfTextRange[] = [];
  let itemStart = 0;
  items.forEach((item, itemIndex) => {
    const start = Math.max(0, sourceStart - itemStart);
    const end = Math.min(item.length, sourceEnd - itemStart);
    if (start < end) ranges.push({ itemIndex, start, end });
    itemStart += item.length;
  });
  return { status: 'matched', ranges };
}
