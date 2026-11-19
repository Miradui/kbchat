export type ThemeChoice = 'system' | 'light' | 'dark';
export type ThemeAccent = 'slate-blue' | 'sage-green' | 'terracotta' | 'indigo';

export const DEFAULT_THEME_ACCENT: ThemeAccent = 'slate-blue';

export const THEME_ACCENTS: ReadonlyArray<{
  value: ThemeAccent;
  label: string;
  themeColor: { light: string; dark: string };
}> = [
  { value: 'slate-blue', label: '岩板蓝', themeColor: { light: '#fbfcfe', dark: '#13181f' } },
  { value: 'sage-green', label: '静谧灰绿', themeColor: { light: '#fcfcfa', dark: '#161b19' } },
  { value: 'terracotta', label: '暖陶土', themeColor: { light: '#fcfaf7', dark: '#1a1614' } },
  { value: 'indigo', label: '深邃靛蓝', themeColor: { light: '#fbfbfe', dark: '#14161f' } },
];

const STORAGE_KEY = 'rag.theme';
const ACCENT_STORAGE_KEY = 'rag.theme.accent';

const ACCENT_THEME_COLORS: Record<ThemeAccent, { light: string; dark: string }> = {
  'slate-blue': { light: '#fbfcfe', dark: '#13181f' },
  'sage-green': { light: '#fcfcfa', dark: '#161b19' },
  terracotta: { light: '#fcfaf7', dark: '#1a1614' },
  indigo: { light: '#fbfbfe', dark: '#14161f' },
};

function isTheme(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isAccent(value: unknown): value is ThemeAccent {
  return value === 'slate-blue' || value === 'sage-green' || value === 'terracotta' || value === 'indigo';
}

function read(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function readAccent(): ThemeAccent {
  try {
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return isAccent(raw) ? raw : DEFAULT_THEME_ACCENT;
  } catch {
    return DEFAULT_THEME_ACCENT;
  }
}

function syncThemeColor(choice: ThemeChoice, accent: ThemeAccent) {
  if (typeof document === 'undefined') return;
  const darkMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
  const resolved = choice === 'system' ? (darkMedia ? 'dark' : 'light') : choice;
  const palette = ACCENT_THEME_COLORS[accent] ?? ACCENT_THEME_COLORS[DEFAULT_THEME_ACCENT];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette[resolved]);
}

function apply(choice: ThemeChoice, accent: ThemeAccent) {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
  if (accent === DEFAULT_THEME_ACCENT) {
    root.removeAttribute('data-accent');
  } else {
    root.setAttribute('data-accent', accent);
  }
  syncThemeColor(choice, accent);
}

let current: ThemeChoice = 'system';
let currentAccent: ThemeAccent = DEFAULT_THEME_ACCENT;
let attachedMedia: MediaQueryList | null = null;
const listeners = new Set<(choice: ThemeChoice) => void>();
const accentListeners = new Set<(accent: ThemeAccent) => void>();

const onMediaChange = () => {
  if (current === 'system') syncThemeColor('system', currentAccent);
};

export const themeStore = {
  /** Called once from main.tsx before React renders, to avoid a flash. */
  init(): ThemeChoice {
    current = read();
    currentAccent = readAccent();
    apply(current, currentAccent);
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      if (attachedMedia !== media) {
        attachedMedia?.removeEventListener?.('change', onMediaChange);
        attachedMedia = media;
        media.addEventListener?.('change', onMediaChange);
      }
    }
    return current;
  },
  get(): ThemeChoice {
    return current;
  },
  set(choice: ThemeChoice) {
    current = choice;
    apply(current, currentAccent);
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
  getAccent(): ThemeAccent {
    return currentAccent;
  },
  setAccent(accent: ThemeAccent) {
    currentAccent = isAccent(accent) ? accent : DEFAULT_THEME_ACCENT;
    apply(current, currentAccent);
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, currentAccent);
    } catch {
      // Persisting is best-effort; the choice still applies to this session.
    }
    accentListeners.forEach((listener) => listener(currentAccent));
  },
  subscribeAccent(listener: (accent: ThemeAccent) => void): () => void {
    accentListeners.add(listener);
    return () => accentListeners.delete(listener);
  },
};
