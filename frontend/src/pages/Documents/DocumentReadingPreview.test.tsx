import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentReadingPreview } from './DocumentReadingPreview';

describe('DocumentReadingPreview', () => {
  it('renders Markdown tables and prose while preserving the exact source', async () => {
    const user = userEvent.setup();
    const content = '# 入职指南\n\n**携带证件** [source: 1]\n\n| 材料 | 数量 |\n| --- | --- |\n| 证件 | 1 |\n';
    render(<DocumentReadingPreview content={content} fileType="markdown" />);
    expect(screen.getByRole('heading', { name: '入职指南' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('材料');
    expect(screen.getByLabelText('文档正文')).toHaveTextContent('[source: 1]');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '原始文本' }));
    expect(screen.getByLabelText('文档原始文本').textContent).toBe(content);
    await user.click(screen.getByRole('button', { name: '阅读' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('blocks raw HTML, unsafe links and remote image loading', () => {
    const content = '<script>alert(1)</script>\n\n<img src="https://example.com/tracker" />\n\n![示意图](https://example.com/image.png)\n\n[危险](javascript:alert) [参考](https://example.com/docs)';
    const { container } = render(<DocumentReadingPreview content={content} fileType="md" />);
    expect(container.querySelector('script, img, iframe')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('[图片：示意图]')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '参考' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps non-Markdown text literal', () => {
    const content = '# 标题\n<script>plain text</script>\n  保留缩进';
    const { container } = render(<DocumentReadingPreview content={content} fileType="txt" />);
    expect(screen.getByLabelText('文档正文').textContent).toBe(content);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
