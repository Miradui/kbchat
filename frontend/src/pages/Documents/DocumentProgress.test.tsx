import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DocumentItem } from '../../types/api';
import { DocumentProgress } from './DocumentProgress';

const document = {
  id: 'doc1',
  knowledgeBaseId: 'kb1',
  filename: 'handbook.pdf',
  fileType: 'pdf',
  fileSize: 1024,
  status: 'failed',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies DocumentItem;

describe('DocumentProgress', () => {
  it('does not present a failed legacy document as 100 percent complete', () => {
    render(<DocumentProgress document={document} />);

    expect(screen.getByRole('progressbar', { name: '处理进度' })).toHaveAttribute('value', '0');
    expect(screen.getByText('任务 失败')).toBeInTheDocument();
  });

  it('uses user-facing Chinese labels for processing stages and job states', () => {
    render(<DocumentProgress document={{ ...document, status: 'parsing', jobStatus: 'running' }} />);

    expect(screen.getByText('解析中')).toBeInTheDocument();
    expect(screen.getByText('任务 处理中')).toBeInTheDocument();
    expect(screen.queryByText(/Parsing|running/)).not.toBeInTheDocument();
  });
});
