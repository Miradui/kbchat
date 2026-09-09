import {
  Activity,
  FileText,
  Home,
  Library,
  MessageSquareText,
  Plus,
  ScanSearch,
  Tags,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

export type AppSection =
  | 'home'
  | 'chat'
  | 'quality'
  | 'diagnostics'
  | 'knowledge-bases'
  | 'documents'
  | 'tags'
  | 'search';

type NavItem = { to: string; label: string; section: AppSection; icon: LucideIcon };

/**
 * Every section has its own top-level entry.
 *
 * The previous rail listed three items and mapped `documents` and `tags` onto the
 * knowledge-base entry, so those two pages highlighted a link that did not lead
 * back to them.
 */
const groups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '工作台',
    items: [
      { to: '/home', label: '首页', section: 'home', icon: Home },
      { to: '/chat', label: 'AI 问答', section: 'chat', icon: MessageSquareText },
      { to: '/quality', label: '质量运营', section: 'quality', icon: ScanSearch },
    ],
  },
  {
    label: '知识',
    items: [
      { to: '/knowledge-bases', label: '知识库', section: 'knowledge-bases', icon: Library },
      { to: '/documents', label: '文档', section: 'documents', icon: FileText },
      { to: '/tags', label: '标签', section: 'tags', icon: Tags },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/diagnostics', label: '系统诊断', section: 'diagnostics', icon: Activity },
    ],
  },
];

type PrimaryNavProps = {
  active: AppSection;
  onNavigate: () => void;
};

export function PrimaryNav({ active, onNavigate }: PrimaryNavProps) {
  return (
    <>
      <Link className="rail__cta" onClick={onNavigate} to="/chat">
        <Plus aria-hidden="true" />
        <span>新建对话</span>
      </Link>
      <nav aria-label="主导航" className="rail__nav">
        {groups.map((group) => (
          <div className="rail__group" key={group.label}>
            <p className="rail__group-label">{group.label}</p>
            {group.items.map(({ to, label, section, icon: Icon }) => (
              <Link
                aria-current={active === section ? 'page' : undefined}
                className={active === section ? 'rail__item is-active' : 'rail__item'}
                key={to}
                onClick={onNavigate}
                to={to}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
