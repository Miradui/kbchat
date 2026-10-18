import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { getDocumentVersionStatus } from '../../api/resources';
import { CitationVersionNotice } from './CitationVersionNotice';

vi.mock('../../api/resources', () => ({ getDocumentVersionStatus: vi.fn() }));
vi.mock('../Documents/DocumentVersionDialog', () => ({ DocumentVersionDialog: ({ documentId, initialBaseId }: { documentId: string; initialBaseId: string }) => <div>比较 {initialBaseId} → {documentId}</div> }));
beforeEach(() => vi.resetAllMocks());
it('compares old and effective versions and carries every citation into the new question', async () => {
 vi.mocked(getDocumentVersionStatus).mockResolvedValue({ items: [
  { documentId: 'old', state: 'newer_available', newerPending: false, current: { id: 'new', filename: '新合同', knowledgeBaseId: 'kb' } },
  { documentId: 'other', state: 'current', newerPending: false, current: { id: 'other', filename: '补充', knowledgeBaseId: 'kb2' } },
 ] });
 render(<MemoryRouter><CitationVersionNotice documentId="old" relatedDocumentIds={['old', 'other']} question="比较合同" /></MemoryRouter>);
 const link = await screen.findByRole('link', { name: '按当前有效资料提问' });
 const url = new URL(link.getAttribute('href')!, 'http://fixture');
 expect(url.searchParams.get('documentIds')).toBe('new,other');
 expect(url.searchParams.get('q')).toBe('比较合同');
 fireEvent.click(screen.getByRole('button', { name: '查看差异' }));
 expect(screen.getByText('比较 old → new')).toBeInTheDocument();
});
it('does not offer a narrower question when one citation is missing or inaccessible', async () => {
 vi.mocked(getDocumentVersionStatus).mockResolvedValue({ items: [{ documentId: 'old', state: 'newer_available', newerPending: false, current: { id: 'new', filename: '新合同', knowledgeBaseId: 'kb' } }] });
 render(<MemoryRouter><CitationVersionNotice documentId="old" relatedDocumentIds={['unavailable']} question="问题" /></MemoryRouter>);
 await screen.findByText('这份回答依据已有可用新版。');
 expect(screen.queryByRole('link', { name: '按当前有效资料提问' })).not.toBeInTheDocument();
});
