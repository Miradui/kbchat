import {
  getKnowledgeBaseStats,
  listChatSessions,
  listGlobalDocuments,
  listKnowledgeBases,
} from '../../api/resources';
import type {
  ChatSessionListResponse,
  GlobalDocumentListResponse,
  KnowledgeBaseListResponse,
  KnowledgeBaseStatsResponse,
} from '../../types/api';

export type HomeSources = {
  loadStats: () => Promise<KnowledgeBaseStatsResponse>;
  loadKnowledgeBases: () => Promise<KnowledgeBaseListResponse>;
  loadDocuments: () => Promise<GlobalDocumentListResponse>;
  loadSessions: () => Promise<ChatSessionListResponse>;
};

const defaultSources: HomeSources = {
  loadStats: () => getKnowledgeBaseStats('month'),
  loadKnowledgeBases: () => listKnowledgeBases({ sort: 'updatedAt_desc', pageSize: 5 }),
  loadDocuments: () => listGlobalDocuments({ sort: 'updatedAt_desc', pageSize: 5 }),
  loadSessions: () => listChatSessions(),
};

export function createHomeLoaders(sources: HomeSources = defaultSources) {
  return {
    stats: () => sources.loadStats(),
    knowledgeBases: async () => (await sources.loadKnowledgeBases()).items,
    documents: async () => (await sources.loadDocuments()).items,
    sessions: async () => (await sources.loadSessions()).items,
  };
}
