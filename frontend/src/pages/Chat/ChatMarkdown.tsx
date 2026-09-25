import { createContext, useContext } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';

import type { Citation } from '../../types/api';
import { CodeBlock } from './CodeBlock';
import { remarkCitations } from './remarkCitations';
import { RenderBoundary } from '../../components/feedback/RenderBoundary';

type CitationContextValue = {
  citations: Citation[];
  focusedIndex: number | null;
  onSelect?: (index: number) => void;
};
const CitationContext = createContext<CitationContextValue>({ citations: [], focusedIndex: null });

function textContent(node: Element | ElementContent): string {
  return node.type === 'text' ? node.value : 'children' in node ? node.children.map(textContent).join('') : '';
}

const components: Components = {
  h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6',
  a: function MarkdownLink({ children, href, node }) {
    const { citations, focusedIndex, onSelect } = useContext(CitationContext);
    const number = Number(node?.properties['data-citation-number']);
    const citation = Number.isInteger(number) && number > 0 ? citations[number - 1] : undefined;
    if (citation && onSelect) {
      return (
        <button
          aria-label={`查看来源 ${number}：${citation.filename}`}
          aria-pressed={focusedIndex === number - 1}
          className="chat-cite"
          onClick={() => onSelect(number - 1)}
          type="button"
        >{number}</button>
      );
    }
    return href ? <a href={href} rel="noopener noreferrer" target="_blank">{children}</a> : <span>{children}</span>;
  },
  // Model-supplied images are explicit links, so rendering a response never fetches an external image.
  img: ({ src, alt }) => src ? <a href={src} rel="noopener noreferrer" target="_blank">图片：{alt || '查看图片'}</a> : <span>{alt}</span>,
  pre: ({ children, node }) => {
    const codeNode = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
    if (!codeNode) return <pre>{children}</pre>;
    const classes = codeNode.properties.className as string[] | undefined;
    const language = classes?.find((name) => name.startsWith('language-'))?.slice(9).toLowerCase() ?? '';
    return <CodeBlock code={textContent(codeNode).replace(/\n$/u, '')} language={language} />;
  },
  table: ({ children }) => <div aria-label="回答表格" className="chat-markdown__table" role="region" tabIndex={0}><table>{children}</table></div>,
};

export function ChatMarkdown({
  content,
  citations = [],
  focusedIndex = null,
  onSelect,
  streaming = false,
}: Partial<CitationContextValue> & { content: string; streaming?: boolean }) {
  return (
    <div aria-busy={streaming || undefined} className="chat-msg__content chat-markdown">
      <RenderBoundary local resetKey={content}>
      <CitationContext.Provider value={{ citations, focusedIndex, onSelect }}>
        <Markdown
          components={components}
          remarkPlugins={[remarkGfm, [remarkCitations, { citationCount: onSelect ? citations.length : 0 }]]}
          skipHtml
        >{content}</Markdown>
      </CitationContext.Provider>
      </RenderBoundary>
      {streaming && <span aria-hidden="true" className="chat-msg__caret" />}
    </div>
  );
}
