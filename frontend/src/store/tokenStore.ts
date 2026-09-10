const tokenKey = 'rag.auth.token';
let authRevision = 0;
const listeners = new Set<() => void>();

function notifyAuthChange() {
  authRevision++;
  listeners.forEach((listener) => listener());
}

function handleStorage(event: StorageEvent) {
  if (event.storageArea === window.localStorage && (event.key === tokenKey || event.key === null)) {
    notifyAuthChange();
  }
}

export const tokenStore = {
  getToken(): string | null {
    return window.localStorage.getItem(tokenKey);
  },

  setToken(token: string): void {
    window.localStorage.setItem(tokenKey, token);
    notifyAuthChange();
  },

  clearToken(): void {
    window.localStorage.removeItem(tokenKey);
    notifyAuthChange();
  },

  getRevision(): number {
    return authRevision;
  },

  subscribe(listener: () => void): () => void {
    if (listeners.size === 0) window.addEventListener('storage', handleStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener('storage', handleStorage);
    };
  },
};
