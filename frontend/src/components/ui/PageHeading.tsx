import type { ReactNode } from 'react';

export function PageHeading({ title, description, actions, className = '', level = 1 }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  level?: 1 | 2;
}) {
  const Heading = level === 2 ? 'h2' : 'h1';
  return (
    <header className={`ui-page-heading ${className}`.trim()}>
      <div className="ui-page-heading__copy">
        <Heading>{title}</Heading>
        {description && <p>{description}</p>}
      </div>
      {actions}
    </header>
  );
}
