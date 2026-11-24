import type { TableSource } from './common';
import type { KnowledgeBaseRerankFallback } from './search';

export type ChatSession = {
  documents?: Array<{ id: string; knowledgeBaseId: string; filename: string }>;
  branchFromSessionId?: string;
  branchFromMessageId?: string;
  scopeMode?: 'auto' | 'manual';
  knowledgeBaseIds?: string[];
  knowledgeBases?: Array<{ id: string; name: string }>;
  id: string;
  knowledgeBaseId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /**
   * The three fields below only come back from the session list endpoint.
   * Single-session responses (create/get/rename/archive/unarchive) omit them.
   */
  knowledgeBaseName?: string;
  messageCount?: number;
  lastMessagePreview?: string;
};

export type ChatSessionListParams = {
  knowledgeBaseId?: string;
  archived?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ChatSessionListResponse = {
  items: ChatSession[];
  total: number;
  page: number;
  pageSize: number;
};

export type Citation = {
  textSource?: 'ocr' | 'ocr_corrected';
  table?: TableSource;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number | null;
  content: string;
  vectorScore: number;
  rerankScore: number | null;
  /**
   * UTF-8 byte range of the chunk's own text in the normalized source (BOM
   * removed, CRLF/CR as LF); absent on citations stored before offsets existed.
   */
  startOffset?: number | null;
  endOffset?: number | null;
};

/**
 * Why an answer came out the way it did. The three failure modes need different
 * responses from the user: `no_basis` means upload something, `retrieval_failed`
 * means retry because the system broke, `model_refused` means neither will help.
 */
export type ChatAnswerStatus = 'answered' | 'no_basis' | 'retrieval_failed' | 'model_refused';

export type ChatFeedbackRating = 'positive' | 'negative';

export type ChatFeedbackReason = 'inaccurate' | 'missing_evidence' | 'irrelevant' | 'incomplete' | 'other';
export type ChatFeedbackDetails = { reason?: ChatFeedbackReason | ''; comment?: string };

export type ChatMessageFeedback = ChatFeedbackDetails & {
  messageId: string;
  rating: ChatFeedbackRating;
  updatedAt: string;
};

export type ChatBookmark = { messageId: string; note: string; createdAt: string; updatedAt: string };

export type ChatMessage = {
  bookmark?: ChatBookmark | null;
  id: string;
  sessionId: string;
  clientRequestId?: string | null;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  feedback?: ChatMessageFeedback | null;
  /**
   * Null on user messages and on answers recorded before migration 019. Null means
   * *unknown*, not `answered` — treating it as answered would relabel history.
   */
  answerStatus?: ChatAnswerStatus | null;
  createdAt: string;
};

export type ChatMessageListResponse = {
  items: ChatMessage[];
  hasMore?: boolean;
  nextCursor?: string;
  hasNewer?: boolean;
  newerCursor?: string;
  revision?: string;
};

export type ChatMessagePageParams = { limit: number; before?: string; after?: string; around?: string; since?: string; revision?: string };

export type ChatSearchExcerpt = { before: string; match: string; after: string };
export type ChatMessageSearchItem = {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  archivedAt: string | null;
  role: 'user' | 'assistant';
  createdAt: string;
  excerpt: ChatSearchExcerpt;
};
export type ChatMessageSearchParams = { q: string; sessionId?: string; page?: number; pageSize?: number };
export type ChatMessageSearchResponse = { items: ChatMessageSearchItem[]; total: number; page: number; pageSize: number };

export type ChatBookmarkItem = ChatMessageSearchItem & { bookmark: ChatBookmark };
export type ChatBookmarkListResponse = { items: ChatBookmarkItem[]; total: number; page: number; pageSize: number };

export type SendChatMessageRequest = {
  content: string;
  clientRequestId: string;
};

export type EditChatMessageRequest = SendChatMessageRequest;

export type SendChatMessageResponse = {
  clientRequestId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  answer: string;
  citations: Citation[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type RegenerateChatMessageResponse = {
  message: ChatMessage;
  rerankFallback: KnowledgeBaseRerankFallback | null;
};
