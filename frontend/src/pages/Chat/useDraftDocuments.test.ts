import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from '../../api/resources';
import type { DocumentItem } from '../../types/api';
import { tokenStore } from '../../store/tokenStore';
import { useDraftDocuments } from './useDraftDocuments';

vi.mock('../../api/resources', () => ({ getDocument: vi.fn() }));
const document = (id: string): DocumentItem => ({ id, knowledgeBaseId: 'kb1', filename: `${id}.md`, fileType: 'md', fileSize: 100, status: 'completed', errorMessage: null, createdAt: '', updatedAt: '' });
beforeEach(() => { vi.mocked(getDocument).mockReset().mockImplementation(async (id) => document(id)); });

describe('draft document scope verification', () => {
  it('loads every requested document and keeps request order', async () => {
    const { result } = renderHook(() => useDraftDocuments(['b', 'a'], ['kb1'], true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.documents.map((item) => item.id)).toEqual(['b', 'a']));
  });
  it.each(['processing', 'moved', 'missing'] as const)('blocks the entire scope when one document is %s', async (mode) => {
    vi.mocked(getDocument).mockImplementation(async (id) => {
      if (id === 'b' && mode === 'missing') throw new Error('资料不可访问');
      return { ...document(id), ...(id === 'b' && mode === 'processing' ? { status: 'embedding' as const } : {}), ...(id === 'b' && mode === 'moved' ? { knowledgeBaseId: 'kb2' } : {}) };
    });
    const { result } = renderHook(() => useDraftDocuments(['a', 'b'], ['kb1'], true));
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.error).toBe(mode === 'processing'
      ? '所选文档尚未全部处理完成，请等待处理完成或重新选择资料。'
      : mode === 'moved'
        ? '所选文档已移动或不属于当前范围，请重新选择资料。'
        : '无法确认所选资料，请重试或重新选择。');
    expect(result.current.documents).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
  it('does not accept a late response from the previous document scope', async () => {
    let resolve!: (value: DocumentItem) => void;
    vi.mocked(getDocument).mockImplementation((id) => id === 'old' ? new Promise((done) => { resolve = done; }) : Promise.resolve(document(id)));
    const { result, rerender } = renderHook(({ ids }) => useDraftDocuments(ids, ['kb1'], true), { initialProps: { ids: ['old'] } });
    rerender({ ids: ['new'] });
    await waitFor(() => expect(result.current.documents[0]?.id).toBe('new'));
    await act(async () => resolve(document('old')));
    expect(result.current.documents[0]?.id).toBe('new');
  });
  it('clears confirmed names on an authentication change before the new read completes', async () => {
    const { result } = renderHook(() => useDraftDocuments(['a'], ['kb1'], true));
    await waitFor(() => expect(result.current.documents).toHaveLength(1));
    vi.mocked(getDocument).mockReturnValue(new Promise(() => {}));
    act(() => tokenStore.setToken('new-scope-test-account'));
    expect(result.current.documents).toEqual([]);
    expect(result.current.loading).toBe(true);
  });
  it('rejects more than twenty or duplicate documents without a partial request', async () => {
    const { result, rerender } = renderHook(({ ids }) => useDraftDocuments(ids, ['kb1'], true), { initialProps: { ids: Array.from({ length: 21 }, (_, i) => `doc-${i}`) } });
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.error).toContain('1–20 份不同文档');
    rerender({ ids: ['a', 'a'] });
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.error).toContain('1–20 份不同文档');
    expect(getDocument).not.toHaveBeenCalled();
  });
});
