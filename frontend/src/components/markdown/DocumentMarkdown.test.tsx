import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocumentMarkdown } from './DocumentMarkdown';

describe('DocumentMarkdown citation highlights', () => {
  it('uses source positions to select one repeated passage and updates the scroll target', () => {
    const content = '# 说明\n\n相同段落：引用😀正文。\n\n相同段落：引用😀正文。';
    const quote = '引用😀正文';
    const first = content.indexOf(quote);
    const second = content.lastIndexOf(quote);
    const ref = createRef<HTMLElement>();
    const view = render(<DocumentMarkdown content={content} highlight={{ start: second, end: second + quote.length }} highlightRef={ref} />);
    const paragraphs = screen.getByLabelText('文档正文').querySelectorAll('p');

    expect(paragraphs[0].querySelector('mark')).toBeNull();
    expect(paragraphs[1].querySelector('mark')).toHaveTextContent(quote);
    expect(ref.current).toBe(paragraphs[1].querySelector('mark'));

    view.rerender(<DocumentMarkdown content={content} highlight={{ start: first, end: first + quote.length }} highlightRef={ref} />);
    expect(paragraphs[1].querySelector('mark')).toBeNull();
    expect(ref.current).toBe(paragraphs[0].querySelector('mark'));

    view.rerender(<DocumentMarkdown content={content} highlight={null} highlightRef={ref} />);
    expect(screen.getByLabelText('文档正文').querySelector('mark')).toBeNull();
    expect(ref.current).toBeNull();
  });

  it('preserves decoded entities, escapes, emphasis, links and code while marking the cited source range', () => {
    const quoted = 'A &amp; B，\\*原样\\*，**重点**和[参考](https://example.com)。\n\n- 列表项\n\n`x < y`\n\n```txt\n  第一行\n    第二行\n```';
    const content = `前文不引用。\n\n${quoted}\n\n后文不引用。`;
    const start = content.indexOf(quoted);
    const { container } = render(<DocumentMarkdown content={content} highlight={{ start, end: start + quoted.length }} />);

    expect(container).toHaveTextContent('A & B，*原样*，重点和参考。');
    expect(container.querySelector('strong mark')).toHaveTextContent('重点');
    expect(screen.getByRole('link', { name: '参考' }).querySelector('mark')).toHaveTextContent('参考');
    expect(screen.getByRole('listitem').querySelector('mark')).toHaveTextContent('列表项');
    expect(container.querySelector('pre code')?.textContent).toBe('  第一行\n    第二行\n');
    expect(container.querySelector('pre code mark')).not.toBeNull();
    expect(screen.getByText('前文不引用。').querySelector('mark')).toBeNull();
    expect(screen.getByText('后文不引用。').querySelector('mark')).toBeNull();
  });
});
