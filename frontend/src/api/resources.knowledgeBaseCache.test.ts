import { expect, it, vi } from 'vitest';
import { knowledgeBaseOptionsKey, queryClient } from '../store/queryClient';
import { tokenStore } from '../store/tokenStore';
import { apiRequest } from './client';
import {
  createKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase, restoreKnowledgeBase,
  updateKnowledgeBasePermissions, deleteKnowledgeBaseMember,
} from './resources';

vi.mock('./client', () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));

const mutations = [
  () => createKnowledgeBase({ name: '资料', description: '' }),
  () => updateKnowledgeBase('kb1', { name: '新名称', description: '' }),
  () => deleteKnowledgeBase('kb1'),
  () => restoreKnowledgeBase('kb1'),
  () => updateKnowledgeBasePermissions('kb1', 'private'),
  () => deleteKnowledgeBaseMember('kb1', 'u1'),
];

it.each(mutations)('invalidates shared options after a successful knowledge-base write', async (mutate) => {
  const key = [...knowledgeBaseOptionsKey, tokenStore.getRevision()];
  queryClient.setQueryData(key, [{ id: 'kb1', name: '资料' }]);
  vi.mocked(apiRequest).mockResolvedValue({});
  await mutate();
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
});

it('keeps valid cached options after a failed write', async () => {
  const key = [...knowledgeBaseOptionsKey, tokenStore.getRevision()];
  queryClient.setQueryData(key, [{ id: 'kb1' }]);
  vi.mocked(apiRequest).mockRejectedValue(new Error('写入失败'));
  await expect(deleteKnowledgeBase('kb1')).rejects.toThrow('写入失败');
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
});

it('does not invalidate the new account when a prior account write finishes late', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(apiRequest).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const write = deleteKnowledgeBase('kb1');
  tokenStore.setToken('new-account');
  const key = [...knowledgeBaseOptionsKey, tokenStore.getRevision()];
  queryClient.setQueryData(key, [{ id: 'new' }]);
  resolve(undefined);
  await write;
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
});
