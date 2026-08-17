export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'rag.theme';

function isTheme(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

function read(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

let current: ThemeChoice = 'system';
const listeners = new Set<(choice: ThemeChoice) => void>();

export const themeStore = {
  /** Called once from main.tsx before React renders, to avoid a flash. */
  init(): ThemeChoice {
    current = read();
    apply(current);
    return current;
  },
  get(): ThemeChoice {
    return current;
  },
  set(choice: ThemeChoice) {
    current = choice;
    apply(choice);
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Persisting is best-effort; the choice still applies to this session.
    }
    listeners.forEach((listener) => listener(choice));
  },
  subscribe(listener: (choice: ThemeChoice) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
