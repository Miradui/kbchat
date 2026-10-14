import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { SegmentedControl } from '../../components/ui/SegmentedControl';

/** Document prose never runs the chat citation plugin or loads remote images. */
export function DocumentReadingPreview({ content, fileType }: { content: string; fileType: string }) {
  const [mode, setMode] = useState<'reading' | 'source'>('reading');
  const markdown = ['md', 'markdown'].includes(fileType.toLowerCase());

  return (
    <div className="doc-reading">
      {fileType === 'xlsx' && <p className="ui-muted">按导入时的工作表、表头和列设置阅读。公式仅显示已保存的结果，缺少缓存值的单元格为空，不重新计算。</p>}
      {fileType === 'csv' && <p className="ui-muted">按导入时的表头和列设置阅读；行号对应 CSV 原文件的物理行，多行字段显示行范围。</p>}
      {markdown && (
        <div className="doc-reading__toolbar">
          <SegmentedControl
            label="文档阅读方式"
            onChange={setMode}
            options={[{ value: 'reading', label: '阅读' }, { value: 'source', label: '原始文本' }]}
            value={mode}
          />
        </div>
      )}
      {markdown && mode === 'reading' ? (
        <article aria-label="文档正文" className="doc-prose">
          <Markdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h4 className="doc-prose__title">{children}</h4>,
              h2: ({ children }) => <h5 className="doc-prose__subtitle">{children}</h5>,
              h3: ({ children }) => <h6>{children}</h6>,
              h4: ({ children }) => <h6>{children}</h6>,
              h5: ({ children }) => <h6>{children}</h6>,
              a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
              img: ({ alt }) => <span className="doc-prose__image">[图片{alt ? `：${alt}` : ''}]</span>,
              table: ({ children }) => <div aria-label="文档表格" className="doc-prose__table" role="region" tabIndex={0}><table>{children}</table></div>,
            }}
          >{content}</Markdown>
        </article>
      ) : (
        <pre aria-label={markdown ? '文档原始文本' : '文档正文'} className={`doc-preview__text${markdown ? ' doc-preview__text--source' : ''}`}>{content}</pre>
      )}
    </div>
  );
}
