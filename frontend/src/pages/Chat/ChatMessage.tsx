import { Check, ChevronDown, Copy, FileText, Pencil, RotateCw, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { copyText } from '../../utils/clipboard';
import { answerStatusNotice } from './answerStatus';
import { ChatMarkdown } from './ChatMarkdown';

const PREVIEW_LENGTH = 220;

type MessageBubbleProps = {
  message: ChatMessageType;
  knowledgeBaseId?: string;
  located?: boolean;
  /** Index of the citation to scroll to and highlight, if any. */
  focusedCitationIndex: number | null;
  onFocusCitation: (messageId: string, index: number | null) => void;
  onOpenCitation?: (citation: Citation, index: number) => void;
  canRegenerate: boolean;
  canEdit?: boolean;
  regenerating: boolean;
  onRegenerate: (messageId: string) => void;
  feedbackSaving: boolean;
  onFeedback: (messageId: string, rating: ChatFeedbackRating) => void;
  versionNavigation?: ReactNode;
  /** Recovery affordance rendered under this message, if it owns one. */
  recovery?: ReactNode;
  editing?: boolean;
  editDraft?: string;
  editSaving?: boolean;
  onEditDraftChange?: (content: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (messageId: string, content: string) => void;
};

export function ChatAssistantLabel() {
  return <div className="chat-msg__author"><span><Sparkles aria-hidden="true" /></span><strong>知识助手</strong></div>;
}

export function MessageBubble({
  message,
  knowledgeBaseId,
  located = false,
  focusedCitationIndex,
  onFocusCitation,
  onOpenCitation,
  canRegenerate,
  canEdit = true,
  regenerating,
  onRegenerate,
  feedbackSaving,
  onFeedback,
  versionNavigation,
  recovery,
  editing = false,
  editDraft = '',
  editSaving = false,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: MessageBubbleProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const displayedMessageId = useRef(message.id);
  displayedMessageId.current = message.id;
  const isAssistant = message.role === 'assistant';
  const notice = answerStatusNotice(message);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    setSourcesOpen(false);
    setCopied(false);
    setCopyError(false);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, [message.id]);

  async function copyMessage() {
    try {
      await copyText(message.content);
      if (displayedMessageId.current !== message.id) return;
      setCopied(true);
      setCopyError(false);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (displayedMessageId.current === message.id) setCopyError(true);
    }
  }

  // Clicking an inline marker opens the source list and reveals that entry.
  useEffect(() => {
    if (focusedCitationIndex !== null) setSourcesOpen(true);
  }, [focusedCitationIndex, message.id]);

  return (
    <article aria-label={located ? '已定位消息' : undefined} className={`chat-msg chat-msg--${message.role}${located ? ' is-located' : ''}`} id={`chat-message-${message.id}`} tabIndex={-1}>
      <div className="chat-msg__body">
        {isAssistant && <ChatAssistantLabel />}
        {editing && !isAssistant ? (
          <textarea
            aria-label="编辑消息"
            autoFocus
            className="chat-msg__edit-input"
            disabled={editSaving}
            onChange={(event) => onEditDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelEdit?.();
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSubmitEdit?.(message.id, editDraft);
              }
            }}
            value={editDraft}
          />
        ) : isAssistant ? (
          <ChatMarkdown
            citations={message.citations}
            content={message.content}
            focusedIndex={focusedCitationIndex}
            onSelect={(index) => {
              onFocusCitation(message.id, index);
              onOpenCitation?.(message.citations[index], index + 1);
            }}
          />
        ) : <p className="chat-msg__content">{message.content}</p>}

        {editing && !isAssistant ? (
          <div className="chat-msg__edit-actions">
            <Button disabled={editSaving} leadingIcon={<X aria-hidden="true" />} variant="ghost" onClick={onCancelEdit}>取消</Button>
            <Button
              disabled={!editDraft.trim()}
              loading={editSaving}
              loadingLabel="生成中"
              variant="primary"
              onClick={() => onSubmitEdit?.(message.id, editDraft)}
            >
              保存并重新生成
            </Button>
          </div>
        ) : !isAssistant ? (
          <div className="chat-msg__foot chat-msg__actions">
            <IconButton
              className="chat-msg__copy-button"
              label={copied ? '已复制' : isAssistant ? '复制回答' : '复制消息'}
              onClick={() => void copyMessage()}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </IconButton>
            {canEdit && (
              <IconButton label="编辑消息" onClick={() => onStartEdit?.(message.id, message.content)}>
                <Pencil aria-hidden="true" />
              </IconButton>
            )}
            {copyError && <span className="chat-msg__copy-error" role="alert">复制失败，请手动选择文本。</span>}
          </div>
        ) : null}

        {/*
          On its own line rather than as the "no citations" branch below, because a
          refusal can arrive with citations attached: retrieval succeeded and the
          model declined anyway. Tying the notice to an empty citation list would
          hide exactly that case.
        */}
        {isAssistant && notice.message && (
          <p
            className={`chat-msg__status chat-msg__status--${notice.tone}`}
            role={notice.assertive ? 'alert' : undefined}
          >
            {notice.message}
          </p>
        )}

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
            ) : null}

            <IconButton
              className="chat-msg__copy-button"
              label={copied ? '已复制' : '复制回答'}
              onClick={() => void copyMessage()}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </IconButton>

            {versionNavigation}

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
            {copyError && <span className="chat-msg__copy-error" role="alert">复制失败，请手动选择文本。</span>}
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
                onOpen={onOpenCitation ? () => onOpenCitation(citation, index + 1) : undefined}
              />
            ))}
          </div>
        )}

        {recovery}
      </div>
    </article>
  );
}

type CitationCardProps = {
  citation: Citation;
  focused: boolean;
  index: number;
  knowledgeBaseId?: string;
  onOpen?: () => void;
};

export function CitationCard({ citation, focused, index, knowledgeBaseId, onOpen }: CitationCardProps) {
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
        {/*
          `title` on the truncating span, so a clipped filename can still be read on
          hover. Screen readers already get the full name from this card's own
          aria-label and from the link's, so this is purely for sighted pointer users --
          and it is why the name is allowed to clip rather than wrap.
        */}
        {onOpen ? (
          <button aria-label={`打开来源：${citation.filename}，${pageLabel}`} className="chat-source__link" onClick={onOpen} type="button">
            <FileText aria-hidden="true" />
            <span className="ui-truncate" title={citation.filename}>{citation.filename}</span>
          </button>
        ) : href ? (
          <Link aria-label={`打开来源：${citation.filename}，${pageLabel}`} className="chat-source__link" to={href}>
            <FileText aria-hidden="true" />
            <span className="ui-truncate" title={citation.filename}>{citation.filename}</span>
          </Link>
        ) : (
          <span className="chat-source__link">
            <FileText aria-hidden="true" />
            <span className="ui-truncate" title={citation.filename}>{citation.filename}</span>
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
