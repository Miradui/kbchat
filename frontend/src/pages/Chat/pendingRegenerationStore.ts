export type PendingRegeneration = {
  sessionId: string;
  messageId: string;
  baselineMessageIds: string[];
  checked: boolean;
  createdAt: string;
};

const KEY_PREFIX = 'rag.chat.pending-regeneration:';

export const pendingRegenerationStore = {
  get(sessionId: string): PendingRegeneration | null {
    try {
      const raw = window.localStorage.getItem(storageKey(sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PendingRegeneration>;
      if (
        parsed.sessionId !== sessionId
        || typeof parsed.messageId !== 'string'
        || !Array.isArray(parsed.baselineMessageIds)
        || !parsed.baselineMessageIds.every((id) => typeof id === 'string')
        || typeof parsed.createdAt !== 'string'
      ) {
        return null;
      }
      return {
        sessionId,
        messageId: parsed.messageId,
        baselineMessageIds: parsed.baselineMessageIds,
        checked: parsed.checked === true,
        createdAt: parsed.createdAt,
      };
    } catch {
      return null;
    }
  },

  set(pending: PendingRegeneration): boolean {
    try {
      window.localStorage.setItem(storageKey(pending.sessionId), JSON.stringify(pending));
      return true;
    } catch {
      return false;
    }
  },

  clear(sessionId: string, messageId?: string): void {
    try {
      if (messageId) {
        const current = this.get(sessionId);
        if (current && current.messageId !== messageId) return;
      }
      window.localStorage.removeItem(storageKey(sessionId));
    } catch {
      // Best effort cleanup only.
    }
  },
};

function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}
