import { describe, expect, it } from 'vitest';

import type { DocumentStatus } from '../../types/api';

import { importGuidance, importGuidanceMessage } from './importGuidance';

function doc(id: string, status: DocumentStatus) {
  return { id, status };
}

describe('importGuidance', () => {
  it('says nothing when nothing was imported', () => {
    expect(importGuidance([], [doc('a', 'completed')])).toBeNull();
  });

  it('waits for the whole batch rather than reporting the first document', () => {
    // Prompting after one document would send the user to ask a question while the
    // chunks for the rest are still being written.
    expect(importGuidance(['a', 'b'], [doc('a', 'completed'), doc('b', 'embedding')])).toBeNull();
  });

  it.each<DocumentStatus>(['uploaded', 'parsing', 'chunking', 'embedding'])(
    'treats %s as still running',
    (status) => {
      expect(importGuidance(['a'], [doc('a', status)])).toBeNull();
    },
  );

  it('reports a finished batch', () => {
    expect(importGuidance(['a', 'b'], [doc('a', 'completed'), doc('b', 'completed')])).toEqual({
      canAsk: true, completed: 2, failed: 0,
    });
  });

  it('counts a mixed batch and still offers to ask', () => {
    expect(importGuidance(['a', 'b'], [doc('a', 'completed'), doc('b', 'failed')])).toEqual({
      canAsk: true, completed: 1, failed: 1,
    });
  });

  it('does not offer to ask when nothing became usable', () => {
    expect(importGuidance(['a'], [doc('a', 'failed')])).toEqual({
      canAsk: false, completed: 0, failed: 1,
    });
  });

  it('stays quiet when a watched document is not in the visible list', () => {
    // Filtered away, deleted, or on another page. Claiming the batch finished would
    // be a guess about documents this page cannot see.
    expect(importGuidance(['a', 'gone'], [doc('a', 'completed')])).toBeNull();
  });
});

describe('importGuidanceMessage', () => {
  it('names failures instead of folding them into the success count', () => {
    expect(importGuidanceMessage({ canAsk: true, completed: 3, failed: 1 }))
      .toBe('3 个文档已处理完成，可以开始提问了。另有 1 个处理失败，可在列表中查看原因。');
  });

  it('omits the failure clause when there were none', () => {
    expect(importGuidanceMessage({ canAsk: true, completed: 1, failed: 0 }))
      .toBe('1 个文档已处理完成，可以开始提问了。');
  });

  it('does not invite questions when every document failed', () => {
    expect(importGuidanceMessage({ canAsk: false, completed: 0, failed: 1 }))
      .toBe('文档处理失败，暂时还不能基于它提问。');
    expect(importGuidanceMessage({ canAsk: false, completed: 0, failed: 2 }))
      .toBe('2 个文档处理失败，暂时还不能基于它们提问。');
  });
});
