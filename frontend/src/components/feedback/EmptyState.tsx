import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <section className="ui-empty-state">
      <Inbox aria-hidden="true" />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </section>
  );
}
