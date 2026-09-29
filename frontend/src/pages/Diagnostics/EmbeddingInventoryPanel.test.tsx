import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EmbeddingInventoryPanel } from './EmbeddingInventoryPanel';

it('shows unknown and mismatched sources without treating a failed inventory as zero', () => {
  const value = { status: 'degraded' as const, model: 'new-model', configuredDimension: 1536, columnDimension: 1536, totalDocuments: 7, unknownDocuments: 2, mismatchedDocuments: 5, groups: [{ model: 'old-model', dimension: 1536, count: 5 }, { model: null, dimension: null, count: 2 }] };
  const view = render(<EmbeddingInventoryPanel value={value} />);
  expect(screen.getByText(/部分文档需要重新处理/)).toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('old-model')).toBeInTheDocument();
  view.rerender(<EmbeddingInventoryPanel value={{ ...value, status: 'down' }} />);
  expect(screen.getByRole('status')).toHaveTextContent('暂时无法读取');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
