export type HomeQuestion = {
  id: string;
  userId: string;
  /** Removed from history before dispatch; the draft id remains for recovery. */
  question?: string;
};

export function homeQuestionState(question: string, userId: string) {
  return { homeQuestion: { id: crypto.randomUUID(), userId, question } satisfies HomeQuestion };
}

export function readHomeQuestion(state: unknown): HomeQuestion | null {
  if (!state || typeof state !== 'object' || !('homeQuestion' in state)) return null;
  const value = state.homeQuestion;
  if (!value || typeof value !== 'object' || !('id' in value) || !('userId' in value)
    || typeof value.id !== 'string' || !value.id || typeof value.userId !== 'string' || !value.userId) return null;
  if ('question' in value && (typeof value.question !== 'string' || !value.question.trim())) return null;
  return { id: value.id, userId: value.userId, ...('question' in value ? { question: value.question as string } : {}) };
}

export function consumeHomeQuestion(state: unknown, question: HomeQuestion | null) {
  const next = { ...(state as Record<string, unknown>) };
  if (question) next.homeQuestion = { id: question.id, userId: question.userId };
  else delete next.homeQuestion;
  return next;
}
