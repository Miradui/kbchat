import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { InitialEntry } from 'react-router-dom';

import { ToastProvider } from '../components/feedback/ToastProvider';

export function renderWithRouter(ui: ReactElement, initialEntries: InitialEntry[] = ['/home']) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </ToastProvider>,
  );
}
