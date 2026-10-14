import { describe, expect, it } from 'vitest';

import type { DocumentErrorCode } from '../../types/api';

import { documentFailureCopy, documentStalenessHint } from './documentFailure';

const CODES: DocumentErrorCode[] = [
  'unsupported_type',
  'corrupt_file',
  'encoding_invalid',
  'empty_content',
  'embedding_failed',
  'storage_failed',
  'cancelled',
  'internal',
  'table_limit_exceeded',
  'table_import_invalid',
];

describe('documentFailureCopy', () => {
  it.each(['xlsx', 'csv'])('explains missing table data instead of OCR for %s', (fileType) => {
    const copy = documentFailureCopy({ errorCode: 'empty_content', errorMessage: null, fileType });
    expect(copy.reason).toContain('数据行');
    expect(copy.advice).toContain('表头');
    expect(copy.advice).not.toContain('OCR');
    expect(copy.retryable).toBe(false);
  });

  it.each(CODES)('has distinct advice for %s', (code) => {
    const copy = documentFailureCopy({ errorCode: code, errorMessage: null });
    expect(copy.reason).not.toBe('');
    expect(copy.advice).not.toBe('');
  });

  it('gives every code its own reason', () => {
    // A shared reason across codes would make the classification pointless: the
    // whole reason the server does the mapping is that the remedies differ.
    const reasons = CODES.map((code) => documentFailureCopy({ errorCode: code, errorMessage: null }).reason);
    expect(new Set(reasons).size).toBe(CODES.length);
  });

  it('separates the file problems from the service problems', () => {
    // Retryability decides whether the user is told to fix the file or to wait.
    const retryable = CODES.filter((code) => documentFailureCopy({ errorCode: code, errorMessage: null }).retryable);
    expect(retryable).toEqual(['embedding_failed', 'storage_failed', 'cancelled', 'internal']);
  });

  it('names the likely cause for an empty document', () => {
    const copy = documentFailureCopy({ errorCode: 'empty_content', errorMessage: null });
    expect(copy.reason).toContain('扫描件');
    expect(copy.advice).toContain('OCR');
  });

  it('says the file is fine when the failure was in the embedding call', () => {
    // Otherwise the user re-uploads a file that was never the problem.
    expect(documentFailureCopy({ errorCode: 'embedding_failed', errorMessage: null }).reason)
      .toContain('文件本身没有问题');
  });

  it('falls back to neutral wording for a code it does not know', () => {
    // A server upgraded ahead of the browser. Guessing a specific cause here would
    // send the user to fix the wrong thing.
    const copy = documentFailureCopy({ errorCode: 'quantum_flux', errorMessage: null });
    expect(copy.reason).toBe('文档处理失败，请检查文件内容或稍后重处理。');
    expect(copy.advice).toContain('联系管理员');
    expect(copy.retryable).toBe(true);
  });

  it('falls back for a failure recorded before error codes existed', () => {
    const copy = documentFailureCopy({ errorMessage: 'parse pdf page 3: EOF' });
    expect(copy.reason).toBe('文档处理失败，请检查文件内容或稍后重处理。');
    // The raw parser text must never reach the user.
    expect(copy.reason).not.toContain('EOF');
  });

  it('keeps the configuration-specific fallback message', () => {
    const copy = documentFailureCopy({ errorMessage: 'api_key is required' });
    expect(copy.reason).toContain('尚未配置完成');
  });
});

describe('documentStalenessHint', () => {
  it('says nothing for a document that is not stale', () => {
    expect(documentStalenessHint({ isStale: false, staleAfterDays: 180 })).toBeNull();
    expect(documentStalenessHint({})).toBeNull();
  });

  it('names the threshold so the user can judge whether it matters', () => {
    expect(documentStalenessHint({ isStale: true, staleAfterDays: 180 }))
      .toBe('超过 180 天没有更新，内容可能已过期。');
  });

  it('phrases the flag as a possibility, not a verdict', () => {
    // Age is not evidence of being wrong; a two-year-old policy may still be current.
    expect(documentStalenessHint({ isStale: true, staleAfterDays: 90 })).toContain('可能');
  });

  it('still explains itself when the threshold is missing', () => {
    expect(documentStalenessHint({ isStale: true })).toBe('内容可能已过期。');
    expect(documentStalenessHint({ isStale: true, staleAfterDays: 0 })).toBe('内容可能已过期。');
  });
});
