export type PendingChatRequest = {
  sessionId: string;
  question: string;
  clientRequestId: string;
  createdAt: string;
};

const keyPrefix = 'rag.chat.pending-request:';

function storageKey(sessionId: string): string {
  return `${keyPrefix}${sessionId}`;
}

function isPendingChatRequest(value: unknown): value is PendingChatRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PendingChatRequest>;
  return typeof candidate.sessionId === 'string'
    && typeof candidate.question === 'string'
    && typeof candidate.clientRequestId === 'string'
    && typeof candidate.createdAt === 'string';
}

export const pendingChatRequestStore = {
  get(sessionId: string): PendingChatRequest | null {
    try {
      const value = window.localStorage.getItem(storageKey(sessionId));
      if (!value) {
        return null;
      }
      const parsed: unknown = JSON.parse(value);
      return isPendingChatRequest(parsed) && parsed.sessionId === sessionId ? parsed : null;
    } catch {
      return null;
    }
  },

  set(request: PendingChatRequest): void {
    try {
      window.localStorage.setItem(storageKey(request.sessionId), JSON.stringify(request));
    } catch {
      // Sending still works when browser storage is unavailable; only reload recovery is lost.
    }
  },

  clear(sessionId: string, clientRequestId?: string): void {
    try {
      if (clientRequestId) {
        const current = this.get(sessionId);
        if (current && current.clientRequestId !== clientRequestId) {
          return;
        }
      }
      window.localStorage.removeItem(storageKey(sessionId));
    } catch {
      // Nothing else can be done when browser storage is unavailable.
    }
  },
};
