const PREFIX = 'rag.chat.draft.v1:';
const MAX_DRAFTS = 50;
const MAX_LENGTH = 32000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type Draft = { text: string; updatedAt: number };
const fallback = new Map<string, Draft>();
const listeners = new Set<() => void>();

function notify() { listeners.forEach((listener) => listener()); }
function key(userId: string, scope: string) { return `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`; }
function decode(value: string | null): Draft | null {
  try {
    const draft: unknown = value ? JSON.parse(value) : null;
    if (!draft || typeof draft !== 'object' || !('text' in draft) || !('updatedAt' in draft)) return null;
    return typeof draft.text === 'string' && draft.text.length <= MAX_LENGTH && typeof draft.updatedAt === 'number'
      && Number.isFinite(draft.updatedAt) && draft.updatedAt > Date.now() - RETENTION_MS && draft.updatedAt <= Date.now() + 60000
      ? draft as Draft : null;
  } catch { return null; }
}
function storageKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((value): value is string => Boolean(value?.startsWith(PREFIX)));
}
function remove(storageKey: string) {
  fallback.delete(storageKey);
  try { localStorage.removeItem(storageKey); } catch { /* Input remains usable without storage. */ }
}
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key.startsWith(PREFIX)) {
    if (event.key) fallback.delete(event.key); else fallback.clear();
    notify();
  }
}

export const chatDraftStore = {
  get(userId: string, scope: string): string {
    const storageKey = key(userId, scope);
    const memory = fallback.get(storageKey);
    if (memory && memory.updatedAt > Date.now() - RETENTION_MS) return memory.text;
    try { return decode(localStorage.getItem(storageKey))?.text ?? ''; } catch { return ''; }
  },
  set(userId: string, scope: string, text: string) {
    if (!userId) return;
    const storageKey = key(userId, scope);
    // Never truncate a question and later present it as a complete draft.
    if (text.length > MAX_LENGTH) {
      remove(storageKey);
      fallback.set(storageKey, { text, updatedAt: Date.now() });
    } else if (!text) remove(storageKey);
    else {
      const draft = { text, updatedAt: Date.now() };
      try {
        const accountPrefix = `${PREFIX}${encodeURIComponent(userId)}:`;
        const entries = storageKeys().filter((item) => item.startsWith(accountPrefix)).map((item) => ({ key: item, value: decode(localStorage.getItem(item)) }));
        entries.filter((item) => !item.value).forEach((item) => remove(item.key));
        const valid = entries.filter((item) => item.value && item.key !== storageKey).sort((a, b) => b.value!.updatedAt - a.value!.updatedAt);
        valid.slice(MAX_DRAFTS - 1).forEach((item) => remove(item.key));
        localStorage.setItem(storageKey, JSON.stringify(draft));
        fallback.delete(storageKey);
      } catch { fallback.set(storageKey, draft); }
    }
    while (fallback.size > MAX_DRAFTS) fallback.delete(fallback.keys().next().value!);
    notify();
  },
  acknowledge(userId: string, scope: string, question: string) {
    if (this.get(userId, scope).trim() === question.trim()) this.set(userId, scope, '');
  },
  move(userId: string, from: string, to: string) {
    const text = this.get(userId, from);
    if (text && !this.get(userId, to)) {
      this.set(userId, to, text);
      this.set(userId, from, '');
    }
  },
  clearAll() {
    fallback.clear();
    try { storageKeys().forEach(remove); } catch { /* Best effort on logout. */ }
    notify();
  },
  subscribe(listener: () => void) {
    if (!listeners.size) window.addEventListener('storage', onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) window.removeEventListener('storage', onStorage);
    };
  },
};
