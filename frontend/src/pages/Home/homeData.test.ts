import { describe, expect, it, vi } from 'vitest';

import type { ChatSession, GlobalDocumentItem, KnowledgeBase } from '../../types/api';
import { createHomeLoaders } from './homeData';

const knowledgeBase = { id: 'kb1', name: '员工手册', description: '', visibility: 'private', retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true }, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z' } satisfies KnowledgeBase;
const document = { id: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工手册', filename: 'handbook.pdf', fileType: 'pdf', fileSize: 120, status: 'completed', errorMessage: null, createdAt: '2026-07-02T00:00:00Z' } satisfies GlobalDocumentItem;
const session = { id: 's1', knowledgeBaseId: 'kb1', title: '休假制度', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T01:00:00Z' } satisfies ChatSession;

describe('createHomeLoaders', () => {
  it('maps response objects into independent region data', async () => {
    const sources = {
      loadStats: vi.fn().mockResolvedValue({ period: 'month', knowledgeBases: { value: 1, changeRatio: 0 }, documents: { value: 1, changeRatio: 0 }, views: { value: 0, changeRatio: 0 }, questions: { value: 0, changeRatio: 0 } }),
      loadKnowledgeBases: vi.fn().mockResolvedValue({ items: [knowledgeBase], total: 1, page: 1, pageSize: 5 }),
      loadDocuments: vi.fn().mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 5 }),
      loadSessions: vi.fn().mockResolvedValue({ items: [session] }),
    };
    const loaders = createHomeLoaders(sources);

    expect(await loaders.knowledgeBases()).toEqual([knowledgeBase]);
    expect(await loaders.documents()).toEqual([document]);
    expect(await loaders.sessions()).toEqual([session]);
  });
});
