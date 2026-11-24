import type {
  ChatBookmark,
  ChatBookmarkListResponse,
  ChatFeedbackDetails,
  ChatFeedbackRating,
  ChatMessageFeedback,
  ChatMessageListResponse,
  ChatMessagePageParams,
  ChatMessageSearchParams,
  ChatMessageSearchResponse,
  ChatSession,
  ChatSessionListParams,
  ChatSessionListResponse,
  Citation,
  EditChatMessageRequest,
  PersonalListParams,
  RecycleBinListResponse,
  RegenerateChatMessageResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
} from '../../types/api';
import { ApiError, apiBlobRequest, apiEventStream, apiRequest } from '../client';
import { withQuery } from './helpers';

export function createChatSession(knowledgeBaseId: string | string[] | undefined, title: string, documentIds?: string[]): Promise<ChatSession> {
  return apiRequest<ChatSession>('/chat/sessions', {
    method: 'POST',
    body: { ...(knowledgeBaseId === undefined ? { scopeMode: 'auto', title }
      : Array.isArray(knowledgeBaseId) ? { knowledgeBaseIds: knowledgeBaseId, title } : { knowledgeBaseId, title }), ...(documentIds?.length ? { documentIds } : {}) },
  });
}

export function listChatSessions(
  params: ChatSessionListParams = {},
): Promise<ChatSessionListResponse> {
  return apiRequest<ChatSessionListResponse>(withQuery('/chat/sessions', params));
}

export function getChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`);
}

export function exportChatSession(sessionId: string): Promise<Blob> {
  return apiBlobRequest(`/chat/sessions/${sessionId}/export`);
}

export function updateChatSessionTitle(sessionId: string, title: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}`, {
    method: 'PUT',
    body: { title },
  });
}

/** Soft delete: the session moves to the chat recycle bin and keeps its messages. */
export function deleteChatSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/chat/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

export function listChatSessionRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(
    withQuery('/chat/sessions/recycle-bin', { page, pageSize }),
  );
}

export function restoreChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/restore`, {
    method: 'POST',
  });
}

export function deleteChatSessionPermanently(sessionId: string): Promise<void> {
  return apiRequest<void>(`/chat/sessions/recycle-bin/${sessionId}`, {
    method: 'DELETE',
  });
}

export function emptyChatSessionRecycleBin(): Promise<void> {
  return apiRequest<void>('/chat/sessions/recycle-bin/empty', {
    method: 'POST',
  });
}

export function archiveChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/archive`, {
    method: 'POST',
  });
}

export function unarchiveChatSession(sessionId: string): Promise<ChatSession> {
  return apiRequest<ChatSession>(`/chat/sessions/${sessionId}/unarchive`, {
    method: 'POST',
  });
}

export function listChatMessages(sessionId: string, params?: ChatMessagePageParams, signal?: AbortSignal): Promise<ChatMessageListResponse> {
  return apiRequest<ChatMessageListResponse>(withQuery(`/chat/sessions/${sessionId}/messages`, params ?? {}), { signal });
}

export function searchChatMessages(params: ChatMessageSearchParams, signal?: AbortSignal): Promise<ChatMessageSearchResponse> {
  return apiRequest<ChatMessageSearchResponse>(withQuery('/chat/messages/search', params), { signal });
}

export function listChatBookmarks(params: PersonalListParams, signal?: AbortSignal) {
  return apiRequest<ChatBookmarkListResponse>(withQuery('/chat/bookmarks', params), { signal });
}

export function saveChatBookmark(messageId: string, note: string) {
  return apiRequest<ChatBookmark>(`/chat/messages/${messageId}/bookmark`, { method: 'PUT', body: { note } });
}

export function deleteChatBookmark(messageId: string) {
  return apiRequest<void>(`/chat/messages/${messageId}/bookmark`, { method: 'DELETE' });
}

export function setChatMessageFeedback(
  messageId: string,
  rating: ChatFeedbackRating,
  details?: ChatFeedbackDetails,
): Promise<ChatMessageFeedback> {
  return apiRequest<ChatMessageFeedback>(`/chat/messages/${messageId}/feedback`, {
    method: 'POST',
    body: { rating, ...details },
  });
}

export function sendChatMessage(
  sessionId: string,
  input: SendChatMessageRequest,
): Promise<SendChatMessageResponse> {
  return apiRequest<SendChatMessageResponse>(`/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: input,
  });
}

export type ChatStreamHandlers = {
  onCitations?: (citations: Citation[]) => void;
  onDelta?: (text: string) => void;
};

function isCompletedChatResponse(
  value: unknown,
  sessionId: string,
  clientRequestId: string,
): value is SendChatMessageResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<SendChatMessageResponse>;
  if (
    response.clientRequestId !== clientRequestId
    || typeof response.answer !== 'string'
    || !Array.isArray(response.citations)
    || !response.userMessage
    || !response.assistantMessage
  ) return false;
  return response.userMessage.sessionId === sessionId
    && response.userMessage.role === 'user'
    && response.userMessage.clientRequestId === clientRequestId
    && response.assistantMessage.sessionId === sessionId
    && response.assistantMessage.role === 'assistant'
    && response.assistantMessage.clientRequestId === clientRequestId;
}

function parseStreamPayload<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Streaming send. Same idempotency contract as `sendChatMessage`: the caller
 * still mints and persists the `clientRequestId`, and a resend reuses it.
 *
 * Resolves with the same payload the blocking endpoint returns. Rejects with an
 * `ApiError` for both pre-stream failures (401/404/409 …) and mid-stream `error`
 * events, so callers cannot tell the two apart by accident — which is correct,
 * because both mean "this attempt did not complete".
 *
 * **A rejection never means the write definitely failed.** Nothing is persisted
 * until generation finishes, but a connection that drops after the server
 * committed still rejects here, so callers must reconcile by `clientRequestId`
 * rather than assume. See docs/04-api-design.md (POST /chat/sessions/:id/messages/stream).
 */
export async function sendChatMessageStream(
  sessionId: string,
  input: SendChatMessageRequest,
  handlers: ChatStreamHandlers = {},
  signal?: AbortSignal,
): Promise<SendChatMessageResponse> {
  const stream = apiEventStream(`/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    body: input,
    signal,
  });

  let done: SendChatMessageResponse | null = null;

  for await (const event of stream) {
    if (event.event === 'delta') {
      const payload = parseStreamPayload<{ text?: string }>(event.data);
      if (payload?.text) handlers.onDelta?.(payload.text);
    } else if (event.event === 'citations') {
      const payload = parseStreamPayload<{ citations?: Citation[] }>(event.data);
      handlers.onCitations?.(payload?.citations ?? []);
    } else if (event.event === 'done') {
      const payload = parseStreamPayload<unknown>(event.data);
      done = isCompletedChatResponse(payload, sessionId, input.clientRequestId) ? payload : null;
      break;
    } else if (event.event === 'error') {
      const payload = parseStreamPayload<{ status?: number; code?: string; message?: string; traceId?: string; details?: Record<string, unknown> }>(event.data);
      throw new ApiError(payload?.status ?? 500, {
        traceId: payload?.traceId,
        code: payload?.code ?? 'INTERNAL_ERROR',
        message: payload?.message ?? '回答生成失败，请稍后重试。',
        details: payload?.details,
      });
    }
  }

  if (!done) {
    // The stream ended without `done`: the answer was not committed, and the
    // caller has to reconcile rather than treat this as a clean failure.
    throw new ApiError(0, { code: 'STREAM_INCOMPLETE', message: '回答尚未完成，连接已中断。' });
  }
  return done;
}

export function editChatMessage(
  sessionId: string,
  messageId: string,
  input: EditChatMessageRequest,
): Promise<SendChatMessageResponse> {
  return apiRequest<SendChatMessageResponse>(`/chat/sessions/${sessionId}/messages/${messageId}/edit`, {
    method: 'PUT',
    body: input,
  });
}

export function regenerateChatMessage(
  sessionId: string,
  messageId: string,
): Promise<RegenerateChatMessageResponse> {
  return apiRequest<RegenerateChatMessageResponse>(
    `/chat/sessions/${sessionId}/messages/${messageId}/regenerate`,
    { method: 'POST' },
  );
}
