import { describe, expect, it } from 'vitest';

import { matchPdfCitation } from './pdfCitation';

function matchedText(items: string[], excerpt: string): string | null {
  const match = matchPdfCitation(items, excerpt);
  return match.status === 'matched' ? match.ranges.map(({ itemIndex, start, end }) => items[itemIndex].slice(start, end)).join('') : null;
}

describe('PDF citation matching', () => {
  it('maps a complete excerpt across text items, empty items, and layout whitespace', () => {
    const items = ['前文：本次', '', '申请\u00a0需要', '\n主管批准。后文'];
    const match = matchPdfCitation(items, '\ufeff本次申请 需要\r\n主管批准。');
    expect(match).toEqual({ status: 'matched', ranges: [
      { itemIndex: 0, start: 3, end: 5 },
      { itemIndex: 2, start: 0, end: 5 },
      { itemIndex: 3, start: 0, end: 6 },
    ] });
    expect(matchedText(items, '本次申请需要主管批准。')).toBe('本次申请\u00a0需要\n主管批准。');
  });

  it('preserves original Unicode spans after width and ligature normalization', () => {
    const items = ['前😀ＡＢ', 'Ｃ　ﬃ e', '\u0301末'];
    expect(matchedText(items, '😀ABC ffi é')).toBe('😀ＡＢＣ　ﬃ e\u0301');
  });

  it('handles combining marks split across PDF text items', () => {
    const items = ['before ca', 'fe', '\u0301 after'];
    expect(matchPdfCitation(items, 'café')).toEqual({ status: 'matched', ranges: [
      { itemIndex: 0, start: 7, end: 9 },
      { itemIndex: 1, start: 0, end: 2 },
      { itemIndex: 2, start: 0, end: 1 },
    ] });
  });

  it('ignores discretionary soft hyphens and zero-width layout spaces', () => {
    expect(matchedText(['pre co\u00adop\u200berate post'], 'cooperate')).toBe('co\u00adop\u200berate');
  });

  it.each<[string[], string]>([
    [['同一正文。', '同一正文。'], '同一正文。'],
    [['编号 A', '编号 Ａ'], '编号A'],
    [['aaaa'], 'aaa'],
  ])('refuses to choose between repeated matches', (items, excerpt) => {
    expect(matchPdfCitation(items, excerpt)).toEqual({ status: 'ambiguous' });
  });

  it.each([
    ['Value: A-10', 'value: A-10'],
    ['Value: A-10', 'Value: A10'],
    ['本次必须审批。', '本次无需审批。'],
    ['只找到引用的第二句。', '首句不在这一页。\n只找到引用的第二句。'],
  ])('does not change case, punctuation, wording, or remove the first sentence', (text, excerpt) => {
    expect(matchPdfCitation([text], excerpt)).toEqual({ status: 'not-found' });
  });

  it.each(['', ' \n\t', '\ufeff\u00ad\u200b'])('ignores an empty normalized excerpt', (excerpt) => {
    expect(matchPdfCitation(['any text'], excerpt)).toEqual({ status: 'not-found' });
  });

  it('requires matches to cover whole normalized graphemes', () => {
    expect(matchPdfCitation(['ﬃ'], 'fi')).toEqual({ status: 'not-found' });
    expect(matchedText(['ﬃ'], 'ffi')).toBe('ﬃ');
    expect(matchPdfCitation(['👩‍💻'], '👩')).toEqual({ status: 'not-found' });
    expect(matchedText(['前👩‍💻后'], '👩‍💻')).toBe('👩‍💻');
  });

  it('can use a later whole-grapheme match after an invalid partial match', () => {
    expect(matchPdfCitation(['ﬃ fi'], 'fi')).toEqual({ status: 'matched', ranges: [{ itemIndex: 0, start: 2, end: 4 }] });
  });

  it('returns no match for an empty page', () => {
    expect(matchPdfCitation([], '正文')).toEqual({ status: 'not-found' });
  });
});
