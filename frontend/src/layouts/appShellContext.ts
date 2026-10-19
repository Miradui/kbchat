import { createContext } from 'react';
import type { AppShellProps } from './AppShell';

export type PageShellConfiguration = Omit<AppShellProps, 'children'>;
export const appShellContext = createContext<((key: string, configuration: PageShellConfiguration) => () => void) | null>(null);
