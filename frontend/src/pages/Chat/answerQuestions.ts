import type { ChatMessage } from '../../types/api';

/** Pair the displayed version with its original question, including regenerations. */
export function answerQuestions(messages: ChatMessage[], sessionId: string | undefined) {
  const questions = new Map<string, string>();
  const requests = new Map<string, string>();
  let previousQuestion = '';
  for (const message of messages) {
    if (message.sessionId !== sessionId) continue;
    if (message.role === 'user') {
      previousQuestion = message.content;
      if (message.clientRequestId) requests.set(message.clientRequestId, message.content);
    } else {
      const question = (message.clientRequestId && requests.get(message.clientRequestId)) || previousQuestion;
      if (question) questions.set(message.id, question);
    }
  }
  return questions;
}
