import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Citation } from '../../types/api';
import { ChatMarkdown } from './ChatMarkdown';

const citations: Citation[] = [
  { documentId: 'doc-1', chunkId: 'chunk-1', filename: '手册.pdf', pageNumber: 2, content: '来源', vectorScore: 0.8, rerankScore: 0.9 },
  { documentId: 'doc-2', chunkId: 'chunk-2', filename: '说明.md', pageNumber: null, content: '补充', vectorScore: 0.7, rerankScore: null },
];

describe('ChatMarkdown', () => {
  it('renders headings, lists, tables and inline code as readable structures', () => {
    render(<ChatMarkdown content={'## 操作步骤\n\n- **上传文件**\n- 查看 `状态`\n\n| 阶段 | 说明 |\n| --- | --- |\n| 解析 | 提取内容 |\n\n> 只读说明'} />);

    expect(screen.getByRole('heading', { name: '操作步骤' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('上传文件').tagName).toBe('STRONG');
    expect(screen.getByText('状态').tagName).toBe('CODE');
    const table = within(screen.getByRole('region', { name: '回答表格' })).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: '阶段' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '提取内容' })).toBeInTheDocument();
  });

  it('highlights supported code and copies the code without its Markdown fences', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const code = 'const value = "中文";\nconsole.log(value);';
    render(<ChatMarkdown content={`\`\`\`javascript\n${code}\n\`\`\``} />);

    const block = screen.getByRole('figure', { name: 'javascript 代码块' });
    expect(block.querySelector('.hljs-keyword')).toHaveTextContent('const');
    expect(block.querySelector('code')?.textContent).toBe(code);
    await user.click(within(block).getByRole('button', { name: '复制代码' }));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(within(block).getByRole('button', { name: '代码已复制' })).toBeInTheDocument();
  });

  it('keeps unknown code languages readable and reports a copy failure locally', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    render(<ChatMarkdown content={'```custom-language\n<code> [source:1]\n```'} citations={citations} onSelect={vi.fn()} />);

    const block = screen.getByRole('figure', { name: 'custom-language 代码块' });
    expect(block.querySelector('code')?.textContent).toBe('<code> [source:1]');
    expect(screen.queryByRole('button', { name: /查看来源/ })).not.toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: '复制代码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('复制失败');
  });

  it('resolves and deduplicates only valid citation groups in prose', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const oversized = `[source:${Array(21).fill('1').join(',')}]`;
    render(<ChatMarkdown
      citations={citations}
      content={`**依据 [source: 1, 1, 2]**\n\n越界 [source:1,3] 零 [source:0] ${oversized}\n\n\`[source:1]\` 和 [已有链接 [source:2]](https://example.com)`}
      onSelect={onSelect}
    />);

    expect(screen.getAllByRole('button', { name: /查看来源/ })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '查看来源 2：说明.md' }));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByText(/越界/)).toHaveTextContent(`[source:1,3] 零 [source:0] ${oversized}`);
    expect(screen.getByText('[source:1]').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: '已有链接 [source:2]' })).toHaveAttribute('href', 'https://example.com');
  });

  it('renders partial Markdown and resolves markers when streaming citations arrive', () => {
    const onSelect = vi.fn();
    const view = render(<ChatMarkdown content={'依据 [source:1]\n\n```python\nprint("流式")'} streaming onSelect={onSelect} />);
    expect(screen.queryByRole('button', { name: /查看来源/ })).not.toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'python 代码块' })).toHaveTextContent('print("流式")');
    expect(view.container.firstChild).toHaveAttribute('aria-busy', 'true');

    view.rerender(<ChatMarkdown content={'依据 [source:1]\n\n```python\nprint("流式")'} citations={citations} onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: '查看来源 1：手册.pdf' })).toBeInTheDocument();
    expect(view.container.firstChild).not.toHaveAttribute('aria-busy');
  });

  it('keeps keyboard focus on the selected citation across a rerender', async () => {
    function Answer() {
      const [focused, setFocused] = useState<number | null>(null);
      return <ChatMarkdown content="依据 [source:1]" citations={citations} focusedIndex={focused} onSelect={setFocused} />;
    }
    const user = userEvent.setup();
    render(<Answer />);
    const source = screen.getByRole('button', { name: '查看来源 1：手册.pdf' });
    await user.tab();
    expect(source).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(source).toHaveAttribute('aria-pressed', 'true');
    expect(source).toHaveFocus();
  });

  it('does not execute model HTML, unsafe URLs or remote image requests', () => {
    const view = render(<ChatMarkdown content={'<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)" />\n\n[危险](javascript:alert%281%29)\n\n![图示](https://example.com/image.png)'} />);
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('危险').tagName).toBe('SPAN');
    expect(screen.getByRole('link', { name: '图片：图示' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
