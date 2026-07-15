import { FileText, Home, Library, MessageSquareText, Search, Tags } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

export type AppSection = 'home' | 'knowledge-bases' | 'documents' | 'chat' | 'search' | 'tags';

const items: Array<{ to: string; label: string; section: AppSection; icon: LucideIcon }> = [
  { to: '/home', label: '首页', section: 'home', icon: Home },
  { to: '/knowledge-bases', label: '知识库', section: 'knowledge-bases', icon: Library },
  { to: '/documents', label: '文档管理', section: 'documents', icon: FileText },
  { to: '/chat', label: '问答管理', section: 'chat', icon: MessageSquareText },
  { to: '/search', label: '全局搜索', section: 'search', icon: Search },
  { to: '/tags', label: '标签管理', section: 'tags', icon: Tags },
];

export function PrimaryNav({ active, onNavigate }: { active: AppSection; onNavigate: () => void }) {
  return (
    <nav className="primary-nav" aria-label="主导航">
      {items.map(({ to, label, section, icon: Icon }) => (
        <Link
          aria-current={active === section ? 'page' : undefined}
          className={active === section ? 'primary-nav__item is-active' : 'primary-nav__item'}
          key={to}
          onClick={onNavigate}
          to={to}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
