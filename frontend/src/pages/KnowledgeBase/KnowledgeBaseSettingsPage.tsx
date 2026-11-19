import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { transferKnowledgeBaseOwnership } from '../../api/resources';
import { TransferOwnershipDialog } from '../../components/TransferOwnershipDialog';
import { Button } from '../../components/ui/Button';

import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { AppShell } from '../../layouts/AppShell';
import { canUnlessUnknown, hasCapability } from '../../utils/access';
import { KnowledgeBaseLayout, KnowledgeBaseLoadFailure } from './KnowledgeBaseLayout';
import { MembersPanel } from './MembersPanel';
import { RetrievalConfigForm } from './RetrievalConfigForm';
import { AnswerConfigForm } from './AnswerConfigForm';
import { DocumentVersionPolicyForm } from './DocumentVersionPolicyForm';
import { RetrievalTestPanel } from './RetrievalTestPanel';
import { useKnowledgeBase } from './useKnowledgeBase';
import { useCurrentUser } from '../../hooks/useCurrentUser';

/**
 * Settings gathers retrieval config, retrieval diagnostics and member permissions.
 * These used to be three unrelated panels stacked under a `?tab=settings` query
 * on the detail page.
 */
export function KnowledgeBaseSettingsPage() {
  const { id } = useParams();
  return <KnowledgeBaseSettings key={id} />;
}

function KnowledgeBaseSettings() {
  const [transferring, setTransferring] = useState(false);
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { knowledgeBase, setKnowledgeBase, loading, error, reload } = useKnowledgeBase();

  const handleVisibility = useCallback((visibility: 'private' | 'public') => {
    setKnowledgeBase((current) => (current ? { ...current, visibility } : current));
  }, [setKnowledgeBase]);

  if (loading && !knowledgeBase) {
    return (
      <AppShell active="knowledge-bases" breadcrumbs={[{ label: '知识库', to: '/knowledge-bases' }]}>
        <div className="ui-panel"><LoadingSkeleton announce columns={4} rows={5} /></div>
      </AppShell>
    );
  }

  if (!knowledgeBase) {
    return <KnowledgeBaseLoadFailure message={error || '知识库不存在或无权访问。'} onRetry={() => void reload()} />;
  }

  // The members panel is dropped rather than shown read-only: without members.read
  // its first request answers 403, so it could only ever render an error. Retrieval
  // config and the test panel stay, the former read-only for a non-manager.
  const showMembers = canUnlessUnknown(knowledgeBase, 'members.read');

  return (
    <KnowledgeBaseLayout active="settings" knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase}>
      <div className="kb-settings">
        <div className="kb-settings__grid">
          <RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase} />
          <AnswerConfigForm knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase} />
        </div>
        <DocumentVersionPolicyForm knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase} />
        {showMembers && <MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={handleVisibility} />}
        <RetrievalTestPanel knowledgeBase={knowledgeBase} />
        {hasCapability(knowledgeBase, 'kb.transfer') && <section className="ui-panel ui-panel--danger" aria-label="所有权管理">
          <header className="ui-panel__head"><h2>所有权管理</h2></header>
          <div className="ui-panel__body ui-panel__stack">
            <p className="ui-muted">将知识库交给其他启用状态的用户。文档和现有成员会保留。</p>
            <div className="kb-config-form__actions"><Button variant="danger" onClick={() => setTransferring(true)}>转移所有权</Button></div>
          </div>
        </section>}
        {transferring && user && <TransferOwnershipDialog ownerId={user.id} description={`将「${knowledgeBase.name}」转移给其他用户。`} onClose={() => setTransferring(false)} onTransfer={(input) => transferKnowledgeBaseOwnership(knowledgeBase.id, input)} onDone={() => navigate('/knowledge-bases')} />}
      </div>
    </KnowledgeBaseLayout>
  );
}
