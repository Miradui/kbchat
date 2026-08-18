export type PendingChatEdit = {
  sessionId: string;
  messageId: string;
  content: string;
  clientRequestId: string;
  createdAt: string;
};

const KEY_PREFIX = 'rag.chat.pending-edit:';

function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

export const pendingChatEditStore = {
  get(sessionId: string): PendingChatEdit | null {
    try {
      const raw = window.localStorage.getItem(storageKey(sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PendingChatEdit>;
      if (
        parsed.sessionId !== sessionId
        || typeof parsed.messageId !== 'string'
        || typeof parsed.content !== 'string'
        || typeof parsed.clientRequestId !== 'string'
        || typeof parsed.createdAt !== 'string'
      ) return null;
      return parsed as PendingChatEdit;
    } catch {
      return null;
    }
  },

  set(edit: PendingChatEdit): boolean {
    try {
      window.localStorage.setItem(storageKey(edit.sessionId), JSON.stringify(edit));
      return true;
    } catch {
      return false;
    }
  },

  clear(sessionId: string, clientRequestId?: string): void {
    try {
      if (clientRequestId) {
        const current = this.get(sessionId);
        if (current && current.clientRequestId !== clientRequestId) return;
      }
      window.localStorage.removeItem(storageKey(sessionId));
    } catch {
      // Best effort cleanup only.
    }
  },
};
