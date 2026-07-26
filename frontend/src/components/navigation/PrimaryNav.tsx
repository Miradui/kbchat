import { Home, Library, MessageSquareText, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

export type AppSection = 'home' | 'knowledge-bases' | 'documents' | 'chat' | 'search' | 'tags';

const items: Array<{ to: string; label: string; section: AppSection; icon: LucideIcon }> = [
  { to: '/home', label: '首页', section: 'home', icon: Home },
  { to: '/knowledge-bases', label: '知识库', section: 'knowledge-bases', icon: Library },
  { to: '/chat', label: 'AI 问答', section: 'chat', icon: MessageSquareText },
];

export function PrimaryNav({ active, onNavigate }: { active: AppSection; onNavigate: () => void }) {
  const currentSection = active === 'documents' || active === 'tags' ? 'knowledge-bases' : active;
  return (
    <nav className="primary-nav" aria-label="主导航">
      <Link className="primary-nav__cta" onClick={onNavigate} to="/chat/new">
        <Sparkles aria-hidden="true" />
        <span>新建对话</span>
      </Link>
      <p className="primary-nav__label">工作空间</p>
      <div className="primary-nav__items">
        {items.map(({ to, label, section, icon: Icon }) => (
          <Link
            aria-current={currentSection === section ? 'page' : undefined}
            className={currentSection === section ? 'primary-nav__item is-active' : 'primary-nav__item'}
            key={to}
            onClick={onNavigate}
            to={to}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
