import type { ApiError } from '../../api/client';
import type { ChatBookmark, ChatMessage, ChatMessageFeedback, Citation } from '../../types/api';
import type { PendingChatRequest } from './pendingChatRequestStore';

/** Delays for the automatic reconciliation attempts after an unconfirmed write. */
export const AUTO_CHECK_DELAYS_MS = [2000, 5000];

export type UnconfirmedSend = {
  request: PendingChatRequest;
  /** Automatic checks already performed. The user is only asked once this is exhausted. */
  autoChecksDone: number;
  checking: boolean;
};

export type StoppedStream = {
  question: string;
  answer: string;
  citations: Citation[];
  checking: boolean;
  resumable: boolean;
};

export type RegenerationState = {
  messageId: string;
  kind: 'failed' | 'unconfirmed';
  message: string;
  baselineMessageIds: string[];
  autoChecksDone: number;
  checking: boolean;
};

export function findNewAssistantMessage(messages: ChatMessage[], baselineIds: string[]): ChatMessage | undefined {
  const known = new Set(baselineIds);
  // Loading older pages after a reload must not count old answers outside the
  // saved page as a successful regeneration. New versions append to the tail.
  let lastKnown = -1;
  messages.forEach((message, index) => { if (known.has(message.id)) lastKnown = index; });
  return lastKnown < 0 ? undefined : messages.slice(lastKnown + 1).reverse().find((message) => message.role === 'assistant');
}

/**
 * Only an unambiguous server-side rejection allows a plain retry. Network faults
 * and unclassified 5xx must go through reconciliation instead.
 */
export function isDefinitiveSendFailure(error: ApiError): boolean {
  return (error.status >= 400 && error.status < 500)
    || error.code === 'CHAT_COMPLETION_FAILED'
    || error.code === 'RERANK_FAILED';
}

export function applyMessageFeedback(
  messages: ChatMessage[],
  messageId: string,
  feedback: ChatMessageFeedback,
): ChatMessage[] {
  return messages.map((message) => (
    message.id === messageId ? { ...message, feedback } : message
  ));
}

export function applyMessageBookmark(
  messages: ChatMessage[],
  messageId: string,
  bookmark: ChatBookmark | null,
): ChatMessage[] {
  return messages.map((message) => (
    message.id === messageId ? { ...message, bookmark } : message
  ));
}

export function applyEditedMessageResponse(
  messages: ChatMessage[],
  messageId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return [userMessage, assistantMessage];
  return [...messages.slice(0, index), userMessage, assistantMessage];
}
