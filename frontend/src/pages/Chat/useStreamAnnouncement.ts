import { useEffect, useRef, useState } from 'react';

/**
 * What a screen reader is told about a streaming answer.
 *
 * Three problems with announcing this from the markup directly, all of which this hook
 * exists to avoid:
 *
 * 1. The progress text lived inside the branch that the arriving answer replaces, so it
 *    unmounted on the first token. A reader heard "正在检索…" and then nothing -- not
 *    that the answer had started, and not that it had finished.
 * 2. A live region that mounts with its text already in place is announced
 *    inconsistently; regions are reliable when they are already in the tree and their
 *    contents change. So the region must be permanent and only the message changes.
 * 3. Putting the region on the answer itself would announce every token, which is
 *    unusable -- the text is already readable in the document.
 *
 * So: announce phase transitions, never content. Completion is a transition to idle
 * from an active phase rather than a phase of its own, because nothing in the thread
 * state says "just finished" -- `sending` simply goes false.
 */
export type StreamPhase = 'idle' | 'retrieving' | 'generating' | 'stopped' | 'failed';

export type StreamAnnouncementInput = {
  sending: boolean;
  streamingAnswer: string;
  streamingCitationCount: number;
  stopped: boolean;
  failed: boolean;
};

const PHASE_MESSAGES: Record<Exclude<StreamPhase, 'idle' | 'failed'>, string> = {
  retrieving: '正在检索知识库…',
  generating: '正在生成回答…',
  stopped: '已停止生成',
};

export function derivePhase(input: StreamAnnouncementInput): StreamPhase {
  // Failure first: it is the only state that outlives the stream it belongs to, so a
  // stale `sending` must not describe a request that has already failed.
  if (input.failed) return 'failed';
  if (input.stopped) return 'stopped';
  if (!input.sending) return 'idle';
  // Citations arriving before any token still means generation has begun; that is the
  // point the existing UI already treats as the end of retrieval.
  return input.streamingAnswer || input.streamingCitationCount > 0 ? 'generating' : 'retrieving';
}

/**
 * The message for one polite live region. Empty until something has happened, so the
 * region is silent on load rather than announcing a state nobody asked about.
 */
export function useStreamAnnouncement(input: StreamAnnouncementInput): string {
  const phase = derivePhase(input);
  const [message, setMessage] = useState('');
  const previous = useRef<StreamPhase>(phase);

  useEffect(() => {
    if (phase === previous.current) return;
    const wasActive = previous.current === 'retrieving' || previous.current === 'generating';
    previous.current = phase;

    if (phase === 'failed') {
      // Silent on purpose: the failure notice in the thread is a `role="alert"`, which
      // is assertive and announces itself. Repeating it here would say it twice.
      setMessage('');
      return;
    }

    if (phase === 'idle') {
      // Only a completion if there was something to complete. Dismissing a failure
      // notice also lands here, and "回答完成" would be a lie about a failed answer.
      setMessage(wasActive ? '回答完成' : '');
      return;
    }

    setMessage(PHASE_MESSAGES[phase]);
  }, [phase]);

  return message;
}
