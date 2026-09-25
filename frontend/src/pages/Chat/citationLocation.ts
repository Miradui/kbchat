/**
 * Locating a citation in the previewed source text.
 *
 * The server stores where a chunk's own text came from as UTF-8 byte offsets
 * into the normalized segment (leading BOM removed, CRLF and CR turned into
 * LF). The chunk content itself cannot be searched for verbatim: the splitter
 * prefixes it with its heading path ("一级 > 二级\n") and may repeat overlap
 * from the previous chunk. Offsets are preferred; older citations without them
 * fall back to text matching.
 */

export type CitationRange = { start: number; end: number };

type LocatableCitation = {
  content: string;
  startOffset?: number | null;
  endOffset?: number | null;
};

/** The text the offsets index into, and the one the preview must render. */
export function normalizeSourceText(text: string): string {
  return text.replace(/^\ufeff/u, '').replace(/\r\n?/gu, '\n');
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Converts byte offsets into string indexes. Returns null when the offsets fall
 * outside the text or split a character, which means the source changed since
 * the chunk was indexed.
 */
export function rangeFromByteOffsets(text: string, startOffset: number, endOffset: number): CitationRange | null {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset <= startOffset) return null;
  const bytes = new TextEncoder().encode(text);
  if (endOffset > bytes.length) return null;
  try {
    const before = decoder.decode(bytes.subarray(0, startOffset));
    const inside = decoder.decode(bytes.subarray(startOffset, endOffset));
    // The tail must also decode, or endOffset landed inside a character.
    decoder.decode(bytes.subarray(endOffset));
    if (!inside.trim()) return null;
    return { start: before.length, end: before.length + inside.length };
  } catch {
    return null;
  }
}

function rangeFromText(text: string, excerpt: string): CitationRange | null {
  if (!excerpt) return null;
  const index = text.indexOf(excerpt);
  return index >= 0 ? { start: index, end: index + excerpt.length } : null;
}

/** `text` must already be normalized with normalizeSourceText. */
export function locateCitation(text: string, citation: LocatableCitation): CitationRange | null {
  if (citation.startOffset != null && citation.endOffset != null) {
    const range = rangeFromByteOffsets(text, citation.startOffset, citation.endOffset);
    if (range) return range;
  }
  const excerpt = normalizeSourceText(citation.content).trim();
  const exact = rangeFromText(text, excerpt);
  if (exact) return exact;
  // Citations stored before offsets existed: drop the heading-path line the
  // splitter put in front of the chunk's own text.
  const newline = excerpt.indexOf('\n');
  return newline >= 0 ? rangeFromText(text, excerpt.slice(newline + 1).trim()) : null;
}
