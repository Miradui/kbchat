import { useEffect, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import type { Citation } from '../../types/api';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAssistantLabel, CitationCard } from './ChatMessage';
import type { StreamText } from './streamText';
import { useStreamAnnouncement } from './useStreamAnnouncement';

export function StreamAnnouncement({
  streamText,
  sending,
  citationCount,
  stopped,
  failed,
}: {
  streamText: StreamText;
  sending: boolean;
  citationCount: number;
  stopped: boolean;
  failed: boolean;
}) {
  const text = useSyncExternalStore(streamText.subscribe, streamText.getSnapshot);
  const announcement = useStreamAnnouncement({
    sending,
    streamingAnswer: text,
    streamingCitationCount: citationCount,
    stopped,
    failed,
  });
  return (
    <p aria-live="polite" className="sr-only" role="status">
      {announcement}
    </p>
  );
}

export function ChatStreamView({
  streamText,
  question,
  citations,
  focusedIndex,
  knowledgeBaseId,
  onFocus,
  onOpen,
  scrollRef,
  stickRef,
  searching,
}: {
  streamText: StreamText;
  question: string;
  citations: Citation[];
  focusedIndex: number | null;
  knowledgeBaseId?: string;
  onFocus: (index: number) => void;
  onOpen: (citation: Citation, index: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef: RefObject<boolean>;
  searching: boolean;
}) {
  const text = useSyncExternalStore(streamText.subscribe, streamText.getSnapshot);
  useEffect(() => {
    if (searching || !stickRef.current) return;
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }, [text, scrollRef, stickRef, searching]);

  if (!question && !text && !citations.length) return null;
  return (
    <>
      {question && (
        <article className="chat-msg chat-msg--user is-pending">
          <div className="chat-msg__body">
            <p className="chat-msg__content">{question}</p>
          </div>
        </article>
      )}
      <article className="chat-msg chat-msg--assistant is-pending">
        <div className="chat-msg__body">
          <ChatAssistantLabel />
          {text ? (
            <ChatMarkdown
              content={text}
              citations={citations}
              focusedIndex={focusedIndex}
              streaming
              onSelect={(index) => {
                onFocus(index);
                onOpen(citations[index], index + 1);
              }}
            />
          ) : (
            <>
              <p className="chat-msg__content">
                {citations.length ? '正在生成回答…' : '正在检索知识库并生成回答…'}
              </p>
              <LoadingSkeleton columns={1} compact rows={2} />
            </>
          )}
          {citations.length > 0 && (
            <div
              aria-label="本轮引用来源"
              className="chat-sources chat-sources--streaming"
              role="group"
            >
              {citations.map((citation, index) => (
                <CitationCard
                  citation={citation}
                  focused={focusedIndex === index}
                  index={index + 1}
                  key={`${citation.documentId}-${citation.chunkId}-${index}`}
                  knowledgeBaseId={knowledgeBaseId}
                  onOpen={() => onOpen(citation, index + 1)}
                />
              ))}
            </div>
          )}
        </div>
      </article>
    </>
  );
}
