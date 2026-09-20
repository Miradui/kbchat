import { getHomeSummary, listActivities } from '../../api/resources';
import type {
  ActivityItemResponse,
  ChatSession,
  GlobalDocumentItem,
  HomeSummaryResponse,
  KnowledgeBase,
  KnowledgeBaseStatsResponse,
} from '../../types/api';

export type HomeSources = {
  loadSummary: () => Promise<HomeSummaryResponse>;
  /** Kept separate from the summary: the timeline is its own resource. */
  loadActivities: () => Promise<ActivityItemResponse[]>;
};

const defaultSources: HomeSources = {
  loadSummary: () => getHomeSummary('month'),
  loadActivities: async () => (await listActivities(20)).items,
};

/**
 * One request behind five regions.
 *
 * `GET /home/summary` replaced the four concurrent list calls plus a pageSize
 * guess (see docs/04-api-design.md, GET /home/summary). The page still renders each
 * region with its own loading and retry state, so the loaders coalesce: calls
 * made while a request is in flight share it, which turns the five regions
 * mounting together into a single request.
 *
 * The shared promise is dropped as soon as it settles, so a later retry issues a
 * fresh request instead of replaying the old result — or the old rejection.
 */
export function createHomeLoaders(sources: HomeSources = defaultSources) {
  let inFlight: Promise<HomeSummaryResponse> | null = null;

  const summary = () => {
    if (!inFlight) {
      const pending = sources.loadSummary().finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
    }
    return inFlight;
  };

  return {
    stats: async (): Promise<KnowledgeBaseStatsResponse> => (await summary()).stats,
    knowledgeBases: async (): Promise<KnowledgeBase[]> => (await summary()).knowledgeBases,
    documents: async (): Promise<GlobalDocumentItem[]> => (await summary()).documents,
    failedDocuments: async (): Promise<GlobalDocumentItem[]> => (await summary()).failedDocuments,
    sessions: async (): Promise<ChatSession[]> => (await summary()).sessions,
    activities: (): Promise<ActivityItemResponse[]> => sources.loadActivities(),
  };
}
