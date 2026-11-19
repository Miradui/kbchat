import type { Ref } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { rehypeSourceHighlight } from './rehypeSourceHighlight';
import type { SourceRange } from './rehypeSourceHighlight';

/** Document prose shares one safe renderer, without chat citation semantics. */
export function DocumentMarkdown({ content, label = '文档正文', className = '', highlight, highlightRef, tabIndex }: {
  content: string;
  label?: string;
  className?: string;
  highlight?: SourceRange | null;
  highlightRef?: Ref<HTMLElement>;
  tabIndex?: number;
}) {
  return (
    <article aria-label={label} className={`doc-prose ${className}`} tabIndex={tabIndex}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [[rehypeSourceHighlight, { source: content, range: highlight }]] : []}
        components={{
          h1: ({ children }) => <h4 className="doc-prose__title">{children}</h4>,
          h2: ({ children }) => <h5 className="doc-prose__subtitle">{children}</h5>,
          h3: ({ children }) => <h6>{children}</h6>,
          h4: ({ children }) => <h6>{children}</h6>,
          h5: ({ children }) => <h6>{children}</h6>,
          a: ({ children, href }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
          img: ({ alt }) => <span className="doc-prose__image">[图片{alt ? `：${alt}` : ''}]</span>,
          table: ({ children }) => <div aria-label="文档表格" className="doc-prose__table" role="region" tabIndex={0}><table>{children}</table></div>,
          mark: ({ children, node }) => <mark ref={node?.properties['data-citation-start'] ? highlightRef : undefined}>{children}</mark>,
        }}
      >{content}</Markdown>
    </article>
  );
}
