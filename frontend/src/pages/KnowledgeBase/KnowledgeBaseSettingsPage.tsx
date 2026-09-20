import { useCallback } from 'react';
import { useParams } from 'react-router-dom';

import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { AppShell } from '../../layouts/AppShell';
import { canUnlessUnknown } from '../../utils/access';
import { KnowledgeBaseLayout, KnowledgeBaseLoadFailure } from './KnowledgeBaseLayout';
import { MembersPanel } from './MembersPanel';
import { RetrievalConfigForm } from './RetrievalConfigForm';
import { AnswerConfigForm } from './AnswerConfigForm';
import { RetrievalTestPanel } from './RetrievalTestPanel';
import { useKnowledgeBase } from './useKnowledgeBase';

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
          {showMembers && <MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={handleVisibility} />}
        </div>
        <RetrievalTestPanel knowledgeBase={knowledgeBase} />
      </div>
    </KnowledgeBaseLayout>
  );
}
