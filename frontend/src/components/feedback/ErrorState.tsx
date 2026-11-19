import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../ui/Button';

type ErrorStateProps = {
  title: string;
  description: string;
  onRetry?: () => void;
  action?: ReactNode;
};

export function ErrorState({ title, description, onRetry, action }: ErrorStateProps) {
  return (
    <section className="ui-error-state" role="alert">
      <CircleAlert aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>重试</Button>}
      {action}
    </section>
  );
}
