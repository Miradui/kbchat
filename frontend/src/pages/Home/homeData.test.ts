import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { ChatSession, GlobalDocumentItem, HomeSummaryResponse, KnowledgeBase } from '../../types/api';
import { createHomeLoaders } from './homeData';

const knowledgeBase = { id: 'kb1', name: '员工手册', description: '', visibility: 'private', retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true }, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z' } satisfies KnowledgeBase;
const document = { id: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工手册', filename: 'handbook.pdf', fileType: 'pdf', fileSize: 120, status: 'completed', errorMessage: null, createdAt: '2026-07-02T00:00:00Z' } satisfies GlobalDocumentItem;
const failedDocument = { ...document, id: 'd2', filename: 'broken.pdf', status: 'failed' } satisfies GlobalDocumentItem;
const session = { id: 's1', knowledgeBaseId: 'kb1', title: '休假制度', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T01:00:00Z', archivedAt: null } satisfies ChatSession;

const summary: HomeSummaryResponse = {
  period: 'month',
  stats: {
    period: 'month',
    knowledgeBases: { value: 1, changeRatio: 0 },
    documents: { value: 2, changeRatio: 0 },
    views: { value: 0, changeRatio: null },
    questions: { value: 0, changeRatio: null },
  },
  knowledgeBases: [knowledgeBase],
  knowledgeBaseTotal: 1,
  documents: [document],
  documentTotal: 2,
  failedDocuments: [failedDocument],
  failedDocumentTotal: 1,
  sessions: [session],
  sessionTotal: 1,
};

describe('createHomeLoaders', () => {
  it('keeps archivedAt required in the chat session contract', () => {
    expectTypeOf<ChatSession['archivedAt']>().toEqualTypeOf<string | null>();
  });

  it('maps one summary response into independent region data', async () => {
    const loadSummary = vi.fn().mockResolvedValue(summary);
    const loaders = createHomeLoaders({ loadSummary, loadActivities: vi.fn().mockResolvedValue([]) });

    expect(await loaders.stats()).toEqual(summary.stats);
    expect(await loaders.knowledgeBases()).toEqual([knowledgeBase]);
    expect(await loaders.documents()).toEqual([document]);
    expect(await loaders.failedDocuments()).toEqual([failedDocument]);
    expect(await loaders.sessions()).toEqual([session]);
  });

  // G17: the five regions mounting together must cost one request, not five.
  it('coalesces concurrent region loads into a single request', async () => {
    const loadSummary = vi.fn().mockResolvedValue(summary);
    const loaders = createHomeLoaders({ loadSummary, loadActivities: vi.fn().mockResolvedValue([]) });

    await Promise.all([
      loaders.stats(),
      loaders.knowledgeBases(),
      loaders.documents(),
      loaders.failedDocuments(),
      loaders.sessions(),
    ]);

    expect(loadSummary).toHaveBeenCalledTimes(1);
  });

  // A retry has to reach the network again rather than replay the settled promise.
  it('issues a fresh request once the shared one has settled', async () => {
    const loadSummary = vi.fn().mockResolvedValue(summary);
    const loaders = createHomeLoaders({ loadSummary, loadActivities: vi.fn().mockResolvedValue([]) });

    await loaders.documents();
    await loaders.documents();

    expect(loadSummary).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejection', async () => {
    const loadSummary = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(summary);
    const loaders = createHomeLoaders({ loadSummary, loadActivities: vi.fn().mockResolvedValue([]) });

    await expect(loaders.documents()).rejects.toThrow('boom');
    expect(await loaders.documents()).toEqual([document]);
  });
});
