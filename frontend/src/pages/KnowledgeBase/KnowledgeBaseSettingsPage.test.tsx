import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { searchUsers, transferKnowledgeBaseOwnership } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import { KnowledgeBaseSettingsPage } from './KnowledgeBaseSettingsPage';

const fixture = vi.hoisted(() => ({ capabilities: ['kb.transfer'] }));
vi.mock('../../api/resources', () => ({ searchUsers: vi.fn(), transferKnowledgeBaseOwnership: vi.fn() }));
vi.mock('../../hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { id: 'owner' } }) }));
vi.mock('./useKnowledgeBase', () => ({ useKnowledgeBase: () => ({ knowledgeBase: { id: 'kb', name: '制度库', capabilities: fixture.capabilities }, setKnowledgeBase: vi.fn(), reload: vi.fn(), loading: false }) }));
vi.mock('./KnowledgeBaseLayout', () => ({ KnowledgeBaseLayout: ({ children }: { children: ReactNode }) => <>{children}</>, KnowledgeBaseLoadFailure: () => null }));
vi.mock('./MembersPanel', () => ({ MembersPanel: () => null }));
vi.mock('./RetrievalConfigForm', () => ({ RetrievalConfigForm: () => null }));
vi.mock('./AnswerConfigForm', () => ({ AnswerConfigForm: () => null }));
vi.mock('./RetrievalTestPanel', () => ({ RetrievalTestPanel: () => null }));
beforeEach(() => { fixture.capabilities = ['kb.transfer']; vi.mocked(searchUsers).mockResolvedValue({ items: [{ id: 'new', username: 'new', displayName: '新所有者' }] }); vi.mocked(transferKnowledgeBaseOwnership).mockReset().mockResolvedValue({ transferredCount: 1 }); });

it('only offers transfer to an owner and sends the confirmed selection', async () => {
  renderWithRouter(<Routes><Route path="/knowledge-bases/:id/settings" element={<KnowledgeBaseSettingsPage />} /><Route path="/knowledge-bases" element={<h1>知识库列表</h1>} /></Routes>, ['/knowledge-bases/kb/settings']);
  const actor = userEvent.setup();
  await actor.click(screen.getByRole('button', { name: '转移所有权' }));
  await screen.findByRole('option', { name: '新所有者（new）' });
  await actor.selectOptions(screen.getByLabelText('新所有者'), 'new');
  await actor.click(screen.getByRole('button', { name: '确认转移' }));
  await waitFor(() => expect(transferKnowledgeBaseOwnership).toHaveBeenCalledWith('kb', { newOwnerId: 'new', keepPreviousOwnerAsManager: true }));
  expect(await screen.findByRole('heading', { name: '知识库列表' })).toBeInTheDocument();
});
it('hides transfer from members', () => {
  fixture.capabilities = ['kb.write'];
  renderWithRouter(<KnowledgeBaseSettingsPage />, ['/knowledge-bases/kb/settings']);
  expect(screen.queryByRole('button', { name: '转移所有权' })).not.toBeInTheDocument();
});
