import { ChevronDown, FileText, RotateCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type {
  ChatFeedbackRating,
  ChatMessage as ChatMessageType,
  Citation,
} from '../../types/api';
import { formatNullableScore, formatScore } from '../../utils/format';

const PREVIEW_LENGTH = 220;
/** Guard against a pathological marker like `[source:1,1,1,...]`. */
const MAX_GROUP_SIZE = 20;

type MessageBubbleProps = {
  message: ChatMessageType;
  knowledgeBaseId?: string;
  /** Index of the citation to scroll to and highlight, if any. */
  focusedCitationIndex: number | null;
  onFocusCitation: (messageId: string, index: number | null) => void;
  canRegenerate: boolean;
  regenerating: boolean;
  onRegenerate: (messageId: string) => void;
  feedbackSaving: boolean;
  onFeedback: (messageId: string, rating: ChatFeedbackRating) => void;
  /** Recovery affordance rendered under this message, if it owns one. */
  recovery?: ReactNode;
};

export function MessageBubble({
  message,
  knowledgeBaseId,
  focusedCitationIndex,
  onFocusCitation,
  canRegenerate,
  regenerating,
  onRegenerate,
  feedbackSaving,
  onFeedback,
  recovery,
}: MessageBubbleProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isAssistant = message.role === 'assistant';

  // Clicking an inline marker opens the source list and reveals that entry.
  useEffect(() => {
    if (focusedCitationIndex !== null) setSourcesOpen(true);
  }, [focusedCitationIndex]);

  return (
    <article className={`chat-msg chat-msg--${message.role}`}>
      <div className="chat-msg__body">
        <p className="chat-msg__content">
          {isAssistant
            ? renderWithCitations(
              message.content,
              message.citations,
              focusedCitationIndex,
              (index) => onFocusCitation(message.id, index),
            )
            : message.content}
        </p>

        {isAssistant && (
          <div className="chat-msg__foot">
            {message.citations.length > 0 ? (
              <button
                aria-expanded={sourcesOpen}
                className="chat-msg__sources-toggle"
                onClick={() => {
                  setSourcesOpen((open) => !open);
                  if (sourcesOpen) onFocusCitation(message.id, null);
                }}
                type="button"
              >
                <ChevronDown aria-hidden="true" className={sourcesOpen ? 'is-open' : undefined} />
                <span>{message.citations.length} 条来源</span>
              </button>
            ) : (
              <span className="chat-msg__no-sources">当前知识库中未找到足够依据。</span>
            )}

            <div aria-label="回答反馈" className="chat-msg__feedback" role="group">
              <IconButton
                aria-pressed={message.feedback?.rating === 'positive'}
                className="chat-msg__feedback-button"
                disabled={feedbackSaving}
                label="标记回答有帮助"
                onClick={() => onFeedback(message.id, 'positive')}
              >
                <ThumbsUp aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-pressed={message.feedback?.rating === 'negative'}
                className="chat-msg__feedback-button"
                disabled={feedbackSaving}
                label="标记回答没有帮助"
                onClick={() => onFeedback(message.id, 'negative')}
              >
                <ThumbsDown aria-hidden="true" />
              </IconButton>
            </div>

            {canRegenerate && (
              <Button
                disabled={regenerating}
                leadingIcon={<RotateCw aria-hidden="true" />}
                loading={regenerating}
                loadingLabel="重新生成中"
                variant="ghost"
                onClick={() => onRegenerate(message.id)}
              >
                重新生成
              </Button>
            )}
          </div>
        )}

        {isAssistant && sourcesOpen && message.citations.length > 0 && (
          <div className="chat-sources">
            {message.citations.map((citation, index) => (
              <CitationCard
                citation={citation}
                focused={focusedCitationIndex === index}
                index={index + 1}
                key={`${citation.documentId}-${citation.chunkId}-${index}`}
                knowledgeBaseId={knowledgeBaseId}
              />
            ))}
          </div>
        )}

        {recovery}
      </div>
    </article>
  );
}

/**
 * Turns `[source:n]` and `[source:n,m]` into clickable markers.
 *
 * A group only becomes interactive when every number in it resolves to a
 * citation on this message; otherwise the original text is preserved verbatim.
 */
function renderWithCitations(
  content: string,
  citations: Citation[],
  focusedIndex: number | null,
  onSelect: (index: number) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[source:\s*(\d+(?:\s*,\s*\d+)*)\s*\]/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) parts.push(content.slice(cursor, match.index));

    const numbers = match[1].split(',').map((value) => Number(value.trim()));
    const unique = [...new Set(numbers)];
    const valid = numbers.length <= MAX_GROUP_SIZE
      && numbers.every((value) => value >= 1 && Boolean(citations[value - 1]));

    if (valid) {
      parts.push(
        <span className="chat-cite-group" key={`${match.index}-${match[1]}`}>
          {unique.map((value, groupIndex) => (
            <Fragment key={`${value}-${groupIndex}`}>
              {groupIndex > 0 && <span aria-hidden="true">,</span>}
              <button
                aria-label={`查看来源 ${value}：${citations[value - 1].filename}`}
                aria-pressed={focusedIndex === value - 1}
                className="chat-cite"
                onClick={() => onSelect(value - 1)}
                type="button"
              >
                {value}
              </button>
            </Fragment>
          ))}
        </span>,
      );
    } else {
      parts.push(match[0]);
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts;
}

type CitationCardProps = {
  citation: Citation;
  focused: boolean;
  index: number;
  knowledgeBaseId?: string;
};

export function CitationCard({ citation, focused, index, knowledgeBaseId }: CitationCardProps) {
  const ref = useRef<HTMLElement | null>(null);
  const long = citation.content.length > PREVIEW_LENGTH;
  const preview = long ? `${citation.content.slice(0, PREVIEW_LENGTH).trimEnd()}…` : citation.content;
  const pageLabel = citation.pageNumber ? `p.${citation.pageNumber}` : '无页码';
  const href = knowledgeBaseId
    ? `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?documentId=${encodeURIComponent(citation.documentId)}&chunkId=${encodeURIComponent(citation.chunkId)}`
    : null;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  return (
    <article
      aria-current={focused ? 'true' : undefined}
      aria-label={`来源 ${index}：${citation.filename}`}
      className={focused ? 'chat-source is-focused' : 'chat-source'}
      ref={ref}
    >
      <header>
        <span className="chat-source__index">{index}</span>
        {href ? (
          <Link aria-label={`打开来源：${citation.filename}，${pageLabel}`} className="chat-source__link" to={href}>
            <FileText aria-hidden="true" />
            <span className="ui-truncate">{citation.filename}</span>
          </Link>
        ) : (
          <span className="chat-source__link">
            <FileText aria-hidden="true" />
            <span className="ui-truncate">{citation.filename}</span>
          </span>
        )}
        <span className="chat-source__page">{pageLabel}</span>
      </header>

      <p>{preview}</p>

      <footer>
        {long && (
          <details>
            <summary>完整摘录</summary>
            <p>{citation.content}</p>
          </details>
        )}
        <details>
          <summary>检索详情</summary>
          <p>
            向量相关度 {formatScore(citation.vectorScore)} · 精排相关度 {formatNullableScore(citation.rerankScore)}
          </p>
        </details>
      </footer>
    </article>
  );
}
