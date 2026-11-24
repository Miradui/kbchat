import type {
  ChatKnowledgeGapListResponse,
  ChatKnowledgeGapParams,
  ChatQualityFeedbackListResponse,
  ChatQualityFeedbackParams,
  ChatQualityOverview,
  ChatQualityOverviewParams,
  ChatUsageGroupBy,
  ChatUsageResponse,
} from '../../types/api';
import { apiRequest } from '../client';
import { withQuery } from './helpers';

export function getChatQualityOverview(
  params: ChatQualityOverviewParams = {},
): Promise<ChatQualityOverview> {
  return apiRequest<ChatQualityOverview>(withQuery('/chat/quality/overview', params));
}

export type ChatQualityIssue = {
  question: string;
  status: 'open' | 'retest' | 'resolved';
  note: string;
  evaluationCaseId: string;
  evaluationRunId: string;
  documentIds: string[];
  updatedAt?: string | null;
};

export function getChatQualityIssue(sessionId: string, question: string, signal?: AbortSignal) {
  return apiRequest<ChatQualityIssue>(withQuery(`/chat/sessions/${sessionId}/quality-issue`, { question }), { signal });
}

export function saveChatQualityIssue(sessionId: string, input: ChatQualityIssue) {
  return apiRequest<ChatQualityIssue>(`/chat/sessions/${sessionId}/quality-issue`, { method: 'PUT', body: input });
}

export type ChatUsageParams = { knowledgeBaseId?: string; from?: string; to?: string; groupBy?: ChatUsageGroupBy };

export function getChatUsage(params: ChatUsageParams = {}): Promise<ChatUsageResponse> {
  return apiRequest<ChatUsageResponse>(withQuery('/chat/quality/usage', params));
}

export function listNegativeChatFeedback(
  params: ChatQualityFeedbackParams = {},
): Promise<ChatQualityFeedbackListResponse> {
  return apiRequest<ChatQualityFeedbackListResponse>(withQuery('/chat/quality/negative-feedback', params));
}

/**
 * Questions the knowledge base answered poorly. `category` defaults to both
 * categories concatenated, with `no_citations` first.
 */
export function listChatKnowledgeGaps(
  params: ChatKnowledgeGapParams = {},
): Promise<ChatKnowledgeGapListResponse> {
  return apiRequest<ChatKnowledgeGapListResponse>(withQuery('/chat/quality/knowledge-gaps', {
    ...params, category: params.category === 'all' ? undefined : params.category,
  }));
}
