import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useNavigate } from 'react-router-dom';

import { renderWithRouter } from '../../test/render';
import { DocumentsPage } from './DocumentsPage';

const api = vi.hoisted(() => ({
  batchDeleteDocuments: vi.fn(),
  batchReprocessDocuments: vi.fn(),
  deleteDocument: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  reprocessDocument: vi.fn(),
  uploadDocument: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBase(id)));
  api.listKnowledgeBases.mockResolvedValue({ items: [knowledgeBase('kb-a'), knowledgeBase('kb-b')] });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DocumentsPage polling', () => {
  it('does not let an old knowledge-base poll overwrite the active route', async () => {
    const oldPoll = deferred<{ items: ReturnType<typeof documentItem>[] }>();
    let kbACalls = 0;
    api.listDocuments.mockImplementation((id: string) => {
      if (id === 'kb-a') {
        kbACalls += 1;
        return kbACalls === 1
          ? Promise.resolve({ items: [documentItem('kb-a', 'a-processing.pdf', 'embedding')] })
          : oldPoll.promise;
      }
      return Promise.resolve({ items: [documentItem('kb-b', 'b-current.pdf', 'completed')] });
    });
    let poll: (() => void) | undefined;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      if (timeout === 3000) {
        poll = handler as () => void;
        return 1;
      }
      return realSetInterval(handler, timeout, ...args);
    });
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <RouteNavigation />
        <Routes><Route element={<DocumentsPage />} path="/knowledge-bases/:id/documents" /></Routes>
      </>,
      ['/knowledge-bases/kb-a/documents'],
    );

    expect(await screen.findByText('a-processing.pdf')).toBeInTheDocument();
    await waitFor(() => expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 3000));
    if (!poll) throw new Error('poll callback was not registered');
    act(() => poll?.());
    await waitFor(() => expect(api.listDocuments).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: '切换知识库' }));
    expect(await screen.findByText('b-current.pdf')).toBeInTheDocument();
    await act(async () => oldPoll.resolve({ items: [documentItem('kb-a', 'a-late.pdf', 'embedding')] }));

    expect(screen.getByText('b-current.pdf')).toBeInTheDocument();
    expect(screen.queryByText('a-late.pdf')).not.toBeInTheDocument();
  });
});

function RouteNavigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/knowledge-bases/kb-b/documents')}>切换知识库</button>;
}

function knowledgeBase(id: string) {
  return {
    id,
    name: id === 'kb-a' ? '知识库 A' : '知识库 B',
    description: '',
    visibility: 'private',
    retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function documentItem(
  knowledgeBaseId: string,
  filename: string,
  status: 'embedding' | 'completed',
) {
  return {
    id: filename,
    knowledgeBaseId,
    filename,
    fileType: 'pdf',
    fileSize: 1024,
    status,
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
