import { Fragment, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ChatMessage, Citation } from '../../types/api';

type MessageBubbleProps = {
  activeCitationIndex: number | null;
  activeCitations: boolean;
  message: ChatMessage;
  onSelectCitation: (index: number) => void;
  onSelectCitations: () => void;
  onRegenerate?: (messageId: string) => void;
  regenerating?: boolean;
  regenerationDisabled?: boolean;
  regenerationChecked?: boolean;
  regenerationError?: string;
  regenerationUncertain?: boolean;
  onCheckRegeneration?: (messageId: string) => void;
  onConfirmRegeneration?: (messageId: string) => void;
};

export function MessageBubble({
  activeCitationIndex,
  activeCitations,
  message,
  onSelectCitation,
  onSelectCitations,
  onRegenerate,
  regenerating = false,
  regenerationDisabled = false,
  regenerationChecked = false,
  regenerationError = '',
  regenerationUncertain = false,
  onCheckRegeneration,
  onConfirmRegeneration,
}: MessageBubbleProps) {
  const citationSummary = message.citations.length > 0
    ? `引用 ${message.citations.length} 条`
    : '当前知识库中未找到足够依据。';
  const canRegenerate = message.role === 'assistant' && Boolean(onRegenerate);

  return (
    <article className={`message-bubble ${message.role}${activeCitations ? ' is-citation-active' : ''}`}>
      <span className="message-role">{message.role === 'assistant' ? '助手' : '用户'}</span>
      <p className="message-content">
        {message.role === 'assistant'
          ? renderContentWithCitations(message.content, message.citations, activeCitationIndex, onSelectCitation)
          : message.content}
      </p>
      {message.role === 'assistant' && (
        <button
          aria-controls="chat-citation-list"
          aria-label={`查看回答“${citationLabel(message.content)}”的引用`}
          aria-pressed={activeCitations}
          className="citation-summary citation-summary-button"
          type="button"
          onClick={onSelectCitations}
        >
          {citationSummary}
        </button>
      )}
      {canRegenerate && !regenerationError && (
        <div className="message-actions">
          <button
            className="secondary-button"
            disabled={regenerationDisabled}
            onClick={() => onRegenerate?.(message.id)}
            type="button"
          >
            {regenerating ? '重新生成中...' : '重新生成回答'}
          </button>
        </div>
      )}
      {regenerationError && (
        <div className="chat-message-recovery" role="alert">
          <strong>{regenerationUncertain ? '重新生成结果待确认' : '重新生成失败'}</strong>
          <p>{regenerationError}</p>
          <div className="chat-message-recovery-actions">
            <button
              className="secondary-button"
              disabled={regenerationDisabled}
              onClick={() => (
                regenerationUncertain
                  ? onCheckRegeneration?.(message.id)
                  : onRegenerate?.(message.id)
              )}
              type="button"
            >
              {regenerationUncertain
                ? regenerating ? '检查中...' : '再次检查'
                : regenerating ? '重试中...' : '重试重新生成'}
            </button>
            {regenerationUncertain && regenerationChecked && onConfirmRegeneration && (
              <button
                className="secondary-button"
                disabled={regenerationDisabled}
                onClick={() => onConfirmRegeneration?.(message.id)}
                type="button"
              >
                确认重新生成
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function renderContentWithCitations(
  content: string,
  citations: Citation[],
  activeCitationIndex: number | null,
  onSelectCitation: (index: number) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const markerPattern = /\[source:\s*(\d+(?:\s*,\s*\d+)*)\s*\]/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = markerPattern.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push(content.slice(cursor, match.index));
    }

    const sourceNumbers = match[1].split(',').map((value) => Number(value.trim()));
    const uniqueSourceNumbers = [...new Set(sourceNumbers)];
    const groupIsValid = sourceNumbers.length <= 20 && sourceNumbers.every((sourceNumber) => (
      sourceNumber >= 1 && Boolean(citations[sourceNumber - 1])
    ));
    if (groupIsValid) {
      parts.push(
        <span className="inline-citation-group" key={`${match.index}-${match[1]}`}>
          {uniqueSourceNumbers.map((sourceNumber, groupIndex) => {
            const citation = citations[sourceNumber - 1];
            return (
              <Fragment key={`${sourceNumber}-${groupIndex}`}>
                {groupIndex > 0 && <span aria-hidden="true">,</span>}
                <button
                  aria-label={`查看来源 ${sourceNumber}：${citation.filename}`}
                  aria-pressed={activeCitationIndex === sourceNumber - 1}
                  className="inline-citation"
                  onClick={() => onSelectCitation(sourceNumber - 1)}
                  type="button"
                >
                  {sourceNumber}
                </button>
              </Fragment>
            );
          })}
        </span>,
      );
    } else {
      parts.push(match[0]);
    }
    cursor = markerPattern.lastIndex;
  }

  if (cursor < content.length) {
    parts.push(content.slice(cursor));
  }
  return parts;
}

function citationLabel(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 40) : '该回答';
}

type CitationCardProps = {
  active: boolean;
  citation: Citation;
  index: number;
  knowledgeBaseId?: string;
};

const CITATION_PREVIEW_LENGTH = 240;

export function CitationCard({
  active,
  citation,
  index,
  knowledgeBaseId,
}: CitationCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const pageLabel = citation.pageNumber ? `第 ${citation.pageNumber} 页` : '无页码';
  const sourcePath = knowledgeBaseId
    ? `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?documentId=${encodeURIComponent(citation.documentId)}&chunkId=${encodeURIComponent(citation.chunkId)}`
    : null;
  const hasLongContent = citation.content.length > CITATION_PREVIEW_LENGTH;
  const preview = hasLongContent
    ? `${citation.content.slice(0, CITATION_PREVIEW_LENGTH).trimEnd()}...`
    : citation.content;

  useEffect(() => {
    if (active) {
      cardRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [active]);

  return (
    <article
      aria-current={active ? 'true' : undefined}
      aria-label={`来源 ${index}：${citation.filename}`}
      className={`citation-card enhanced-citation-card${active ? ' is-active' : ''}`}
      ref={cardRef}
    >
      <header>
        {sourcePath ? (
          <Link
            aria-label={`打开来源：${citation.filename}，${pageLabel}`}
            className="citation-source-link"
            to={sourcePath}
          >
            <strong>{index}. {citation.filename}</strong>
            <span>{citation.pageNumber ? `p.${citation.pageNumber}` : '无页码'}</span>
          </Link>
        ) : (
          <>
            <strong>{index}. {citation.filename}</strong>
            <span>{citation.pageNumber ? `p.${citation.pageNumber}` : '无页码'}</span>
          </>
        )}
      </header>
      <p className="citation-preview">{preview}</p>
      {hasLongContent && (
        <details className="citation-details">
          <summary>查看完整摘录</summary>
          <p>{citation.content}</p>
        </details>
      )}
      <details className="citation-details citation-retrieval-details">
        <summary>检索详情</summary>
        <div className="citation-score-grid">
          <span>向量相关度 {formatScore(citation.vectorScore)}</span>
          <span>精排相关度 {formatNullableScore(citation.rerankScore)}</span>
        </div>
      </details>
    </article>
  );
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

function formatNullableScore(value: number | null): string {
  return typeof value === 'number' ? value.toFixed(2) : '无精排分';
}
