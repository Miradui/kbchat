import { Link } from 'react-router-dom';

export type KnowledgeBaseSection = 'overview' | 'documents' | 'qa' | 'settings';

type KnowledgeBaseSectionNavProps = {
  active: KnowledgeBaseSection;
  knowledgeBaseId: string;
};

export function KnowledgeBaseSectionNav({ active, knowledgeBaseId }: KnowledgeBaseSectionNavProps) {
  const encodedId = encodeURIComponent(knowledgeBaseId);
  const items: Array<{ id: KnowledgeBaseSection; label: string; to: string }> = [
    { id: 'overview', label: '概览', to: `/knowledge-bases/${encodedId}?tab=overview` },
    { id: 'documents', label: '文档', to: `/knowledge-bases/${encodedId}/documents` },
    { id: 'qa', label: 'AI 问答', to: `/knowledge-bases/${encodedId}?tab=qa` },
    { id: 'settings', label: '设置', to: `/knowledge-bases/${encodedId}?tab=settings` },
  ];

  return (
    <nav aria-label="知识库功能" className="kb-section-nav">
      {items.map((item) => (
        <Link
          aria-current={active === item.id ? 'page' : undefined}
          className={active === item.id ? 'is-active' : undefined}
          key={item.id}
          to={item.to}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
