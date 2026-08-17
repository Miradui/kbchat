import { Link } from 'react-router-dom';

export type NavTabItem = {
  id: string;
  label: string;
  to: string;
};

type NavTabsProps = {
  label: string;
  active: string;
  items: NavTabItem[];
};

/** Route-backed tabs. Each tab is a real link so it is shareable and back-navigable. */
export function NavTabs({ label, active, items }: NavTabsProps) {
  return (
    <nav aria-label={label} className="ui-tabs">
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
