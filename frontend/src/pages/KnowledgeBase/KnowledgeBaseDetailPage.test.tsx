import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createChatSession,
  getKnowledgeBase,
  getKnowledgeBasePermissions,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
  recordKnowledgeBaseView,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import { KnowledgeBaseDetailPage } from './KnowledgeBaseDetailPage';

vi.mock('../../api/resources', () => ({
  addKnowledgeBaseMember: vi.fn(),
  createChatSession: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  logout: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBaseMember: vi.fn(),
  updateKnowledgeBasePermissions: vi.fn(),
}));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

beforeEach(() => {
  vi.mocked(getKnowledgeBase).mockReset().mockResolvedValue(knowledgeBase);
  vi.mocked(listDocuments).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getKnowledgeBasePermissions).mockReset().mockResolvedValue({
    knowledgeBaseId: knowledgeBase.id,
    visibility: 'private',
    owner: { id: 'u1', username: 'admin', displayName: '管理员' },
    managers: [],
    members: [],
  });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(recordKnowledgeBaseView).mockReset().mockResolvedValue(undefined);
  vi.mocked(createChatSession).mockReset();
});

describe('KnowledgeBaseDetailPage', () => {
  it('opens a draft chat without creating an empty session', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
          <Route path="/chat/:sessionId" element={<div>问答页</div>} />
        </Routes>
        <LocationProbe />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '开始问答' }));

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/new?knowledgeBaseId=kb1');
  });
});
