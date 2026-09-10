import { MessageSquareText } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '../../components/ui/Button';
import { NavTabs } from '../../components/ui/NavTabs';
import { AppShell } from '../../layouts/AppShell';
import type { KnowledgeBase } from '../../types/api';
import { KnowledgeBaseEntityActions } from './KnowledgeBaseEntityActions';
import { KnowledgeBaseGlyph, KnowledgeBaseVisibility } from './KnowledgeBaseList';

export type KnowledgeBaseSection = 'overview' | 'documents' | 'settings';

type KnowledgeBaseLayoutProps = {
  active: KnowledgeBaseSection;
  knowledgeBase: KnowledgeBase;
  onUpdated: (knowledgeBase: KnowledgeBase) => void;
  children: ReactNode;
};

/**
 * Header and sub-navigation shared by overview, documents and settings.
 *
 * The old build had a fourth "AI 问答" tab whose entire body was a single button
 * that navigated away. That is now a persistent primary action in this header,
 * available from every sub-page.
 */
export function KnowledgeBaseLayout({
  active,
  knowledgeBase,
  onUpdated,
  children,
}: KnowledgeBaseLayoutProps) {
  const navigate = useNavigate();
  const encodedId = encodeURIComponent(knowledgeBase.id);

  return (
    <AppShell
      active="knowledge-bases"
      breadcrumbs={[
        { label: '知识库', to: '/knowledge-bases' },
        { label: knowledgeBase.name },
      ]}
    >
      <div className="kb-detail">
        <header className="kb-detail__hero">
          <div className="kb-detail__identity">
            <KnowledgeBaseGlyph large />
            <div>
              <div className="kb-detail__title-row">
                <h1>{knowledgeBase.name}</h1>
                <KnowledgeBaseVisibility visibility={knowledgeBase.visibility} />
              </div>
              <p className="kb-detail__desc">{knowledgeBase.description || '这个知识库还没有描述。'}</p>
            </div>
          </div>

          <div className="kb-detail__actions">
            <Button
              leadingIcon={<MessageSquareText aria-hidden="true" />}
              onClick={() => navigate(`/chat?knowledgeBaseId=${encodedId}`)}
            >
              基于此知识库提问
            </Button>
            <KnowledgeBaseEntityActions
              knowledgeBase={knowledgeBase}
              onDeleted={() => navigate('/knowledge-bases', { replace: true })}
              onUpdated={onUpdated}
            />
          </div>
        </header>

        <NavTabs
          active={active}
          items={[
            { id: 'overview', label: '概览', to: `/knowledge-bases/${encodedId}` },
            { id: 'documents', label: '文档', to: `/knowledge-bases/${encodedId}/documents` },
            { id: 'settings', label: '设置', to: `/knowledge-bases/${encodedId}/settings` },
          ]}
          label="知识库功能"
        />

        {children}
      </div>
    </AppShell>
  );
}

/** Shared loading/failure shell so every sub-page fails the same way. */
export function KnowledgeBaseLoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AppShell active="knowledge-bases" breadcrumbs={[{ label: '知识库', to: '/knowledge-bases' }, { label: '无法访问' }]}>
      <div className="ui-error-state" role="alert">
        <h2>无法打开知识库</h2>
        <p>{message}</p>
        <div className="kb-detail__actions">
          <Button variant="secondary" onClick={onRetry}>重试</Button>
          <Link className="ui-button ui-button--ghost" to="/knowledge-bases"><span>返回列表</span></Link>
        </div>
      </div>
    </AppShell>
  );
}
