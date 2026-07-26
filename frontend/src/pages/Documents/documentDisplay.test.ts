import { describe, expect, it } from 'vitest';

import {
  documentStatusClass,
  documentStatusLabel,
  formatDocumentBytes,
  isTerminalDocumentStatus,
} from './documentDisplay';

describe('documentDisplay', () => {
  it.each([
    ['uploaded', '已上传', 'processing', false],
    ['parsing', '解析中', 'processing', false],
    ['chunking', '切分中', 'processing', false],
    ['embedding', '向量化', 'processing', false],
    ['completed', '已完成', 'completed', true],
    ['failed', '失败', 'failed', true],
  ] as const)('maps %s to one consistent display contract', (status, label, className, terminal) => {
    expect(documentStatusLabel(status)).toBe(label);
    expect(documentStatusClass(status)).toBe(className);
    expect(isTerminalDocumentStatus(status)).toBe(terminal);
  });

  it.each([
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1024 * 1024, '1.0 MB'],
  ])('formats %i bytes consistently', (bytes, expected) => {
    expect(formatDocumentBytes(bytes)).toBe(expected);
  });
});
