import { describe, expect, it } from 'vitest';

import { locateCitation, normalizeSourceText, rangeFromByteOffsets } from './citationLocation';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('citation location', () => {
  const source = '# 产品手册\n\n## 安装 😀\n\n第一段正文，包含中文和 emoji 😀。\n\n第二段正文：E-4021 错误码说明。\n';
  const body = '第一段正文，包含中文和 emoji 😀。\n\n第二段正文：E-4021 错误码说明。';
  const start = bytes(source.slice(0, source.indexOf(body)));
  const end = start + bytes(body);

  it('converts UTF-8 byte offsets through multi-byte characters and emoji', () => {
    const range = rangeFromByteOffsets(source, start, end);
    expect(range && source.slice(range.start, range.end)).toBe(body);
  });

  it('locates a heading-prefixed chunk by its offsets', () => {
    const citation = { content: '产品手册 > 安装 😀\n' + body, startOffset: start, endOffset: end };
    const range = locateCitation(source, citation);
    expect(range && source.slice(range.start, range.end)).toBe(body);
  });

  it('normalizes a BOM and CRLF the way the server did before counting', () => {
    const raw = '\ufeff' + source.replace(/\n/gu, '\r\n');
    const text = normalizeSourceText(raw);
    expect(text).toBe(source);
    const range = locateCitation(text, { content: body, startOffset: start, endOffset: end });
    expect(range && text.slice(range.start, range.end)).toBe(body);
  });

  it('rejects offsets that are out of range or split a character', () => {
    expect(rangeFromByteOffsets(source, start, bytes(source) + 1)).toBeNull();
    // One byte into a three-byte CJK character.
    expect(rangeFromByteOffsets(source, start + 1, end)).toBeNull();
    expect(rangeFromByteOffsets(source, end, start)).toBeNull();
  });

  it('falls back to the text without its heading line for citations stored before offsets', () => {
    const range = locateCitation(source, { content: '产品手册 > 安装 😀\n' + body });
    expect(range && source.slice(range.start, range.end)).toBe(body);
  });

  it('falls back to text matching when stale offsets no longer fit', () => {
    // Bytes 0..3 end inside the three-byte "产": unusable, so the text match wins.
    const split = locateCitation(source, { content: body, startOffset: 0, endOffset: 3 });
    expect(split && source.slice(split.start, split.end)).toBe(body);
    const stale = locateCitation(source, { content: body, startOffset: bytes(source) + 5, endOffset: bytes(source) + 9 });
    expect(stale && source.slice(stale.start, stale.end)).toBe(body);
  });

  it('returns null when nothing matches', () => {
    expect(locateCitation(source, { content: '不存在的内容' })).toBeNull();
  });
});
