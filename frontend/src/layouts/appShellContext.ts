import { createContext } from 'react';
import type { AppShellProps } from './AppShell';

export type PageShellConfiguration = Omit<AppShellProps, 'children'>;
export type AppShellRegistration = {
  sync: (key: string, configuration: PageShellConfiguration) => void;
  unregister: (key: string) => void;
};
export const appShellContext = createContext<AppShellRegistration | null>(null);
