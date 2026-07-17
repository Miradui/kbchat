const tokenKey = 'rag.auth.token';
let authRevision = 0;

export const tokenStore = {
  getToken(): string | null {
    return window.localStorage.getItem(tokenKey);
  },

  setToken(token: string): void {
    window.localStorage.setItem(tokenKey, token);
    authRevision++;
  },

  clearToken(): void {
    window.localStorage.removeItem(tokenKey);
    authRevision++;
  },

  getRevision(): number {
    return authRevision;
  },
};
