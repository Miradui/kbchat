import type { ChatFeedbackDetails, Citation } from './chat';
import type { KnowledgeBaseRerankFallback } from './search';

export type ChatQualityPeriod = 'day' | 'month';

export type ChatQualityOverviewParams = {
  scope?: 'personal' | 'auto' | 'multi' | 'documents';
  period?: ChatQualityPeriod;
  knowledgeBaseId?: string;
};

export type ChatQualityOverview = {
  period: ChatQualityPeriod;
  startAt: string;
  endAt: string;
  answerCount: number;
  feedbackCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
  /** Answers classified as knowledge_base; the denominator of withoutCitationsRate. */
  knowledgeAnswerCount: number;
  /**
   * Answers with an empty citation list *and* knowledge_base intent. Conversation
   * answers are given no citations on purpose and are excluded.
   */
  withoutCitationsCount: number;
  /**
   * Answers written before intent was recorded. They are excluded from
   * withoutCitationsCount and withoutCitationsRate rather than assumed grounded,
   * so a non-zero value means those rates cover only part of the period.
   */
  unclassifiedAnswerCount: number;
  feedbackCoverage: number;
  positiveRate: number;
  /** withoutCitationsCount / knowledgeAnswerCount, or 0 when there are none. */
  withoutCitationsRate: number;
};

export type ChatUsageGroupBy = 'day' | 'knowledgeBase' | 'user' | 'model' | 'purpose';

export type ChatUsageItem = {
  /** "YYYY-MM-DD" (UTC) for day grouping, the UUID for knowledgeBase/user, the model name for model. */
  groupKey: string;
  groupLabel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** Only set per row for model grouping when that model is priced. */
  estimatedCost: number | null;
};

export type ChatUsageResponse = {
  from: string; to: string; groupBy: string;
  items: ChatUsageItem[];
  totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number;
  pricingConfigured: boolean;
  estimatedCost: number | null;
  unpricedModels: string[];
};

export type ChatQualityFeedbackParams = ChatQualityOverviewParams & {
  hasCitations?: boolean;
  page?: number;
  pageSize?: number;
};

export type ChatQualityFeedbackItem = ChatFeedbackDetails & {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  question: string;
  answer: string;
  citations: Citation[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
  createdAt: string;
  feedbackUpdatedAt: string;
};

export type ChatQualityFeedbackListResponse = {
  items: ChatQualityFeedbackItem[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * `no_citations` is one knowledge answer that retrieved nothing.
 * `repeated_rewrite` is a cluster: one question rephrased at least twice inside a
 * session. Regenerations are excluded, since asking for another attempt at the
 * same question is a different problem from rephrasing it.
 *
 * `retrieval_failed` and `model_refused` were carved out of `no_citations`: all
 * three have no citations, but only the first is fixed by uploading documents.
 */
export type ChatKnowledgeGapCategory =
  | 'no_citations'
  | 'retrieval_failed'
  | 'model_refused'
  | 'repeated_rewrite';

export type ChatKnowledgeGapParams = ChatQualityOverviewParams & {
  category?: ChatKnowledgeGapCategory | 'all';
  page?: number;
  pageSize?: number;
};

export type ChatKnowledgeGapItem = {
  category: ChatKnowledgeGapCategory;
  /** Null for a repeated_rewrite cluster, which spans several answers. */
  messageId: string | null;
  sessionId: string;
  sessionTitle: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  question: string;
  retrievalQuery: string;
  /** Always 1 for no_citations; the cluster size for repeated_rewrite. */
  occurrenceCount: number;
  /** How many answers in the row retrieved nothing. */
  ungroundedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ChatKnowledgeGapListResponse = {
  items: ChatKnowledgeGapItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Reported regardless of the requested category so a filter can be labelled. */
  noCitationsTotal: number;
  /**
   * Only counts turns recorded after migration 019 added `answer_status`. A zero
   * means "not observed yet", not "never happens".
   */
  retrievalFailedTotal: number;
  modelRefusedTotal: number;
  repeatedRewriteTotal: number;
};
