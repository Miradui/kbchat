import type { ChatAnswerStatus, ChatMessage } from '../../types/api';

/**
 * What to tell the user about why an answer came out the way it did.
 *
 * The three failure modes used to share one sentence — "当前知识库中未找到足够依据" —
 * shown whenever an answer had no citations. That is right for exactly one of them:
 * it tells someone whose retrieval service was down to go upload documents, and
 * tells someone whose question was declined the same thing. Each mode now says what
 * happened and what, if anything, is worth doing.
 */
export type AnswerStatusNotice = {
  /** Empty for a normal answer: nothing is shown. */
  message: string;
  tone: 'neutral' | 'warn' | 'danger' | 'info';
  /**
   * Whether the message is an error the user should be told about rather than a
   * quiet aside. Drives `role="alert"`, so it is reserved for the case where
   * something actually broke — announcing every ungrounded answer would make the
   * screen reader experience noisier without adding information.
   */
  assertive: boolean;
};

const NOTICES: Record<ChatAnswerStatus, AnswerStatusNotice> = {
  answered: { message: '', tone: 'neutral', assertive: false },
  no_basis: {
    message: '当前知识库中未找到足够依据。补充相关文档后可以再问一次。',
    tone: 'warn',
    assertive: false,
  },
  retrieval_failed: {
    message: '检索服务暂时不可用，这次没能查到知识库内容。稍后重试即可，与知识库里的资料无关。',
    tone: 'danger',
    // A failure the user can act on by retrying, and one they would otherwise
    // mistake for an empty knowledge base.
    assertive: true,
  },
  model_refused: {
    message: '模型判断这个问题不适合回答，因此没有生成内容。这与知识库资料是否齐全无关。',
    tone: 'info',
    assertive: false,
  },
};

/**
 * A null status means *unknown*, not answered: messages written before migration 019
 * have none. Falling back to the no-citation sentence for those keeps history
 * reading the way it did before the status existed, which is the honest option — the
 * alternative is relabelling old answers with a status nobody recorded.
 *
 * An unrecognised status is treated the same way for the same reason.
 */
export function answerStatusNotice(message: Pick<ChatMessage, 'answerStatus' | 'citations'>): AnswerStatusNotice {
  const status = message.answerStatus;
  if (status && status in NOTICES) {
    return NOTICES[status as ChatAnswerStatus];
  }
  if (message.citations.length > 0) {
    return NOTICES.answered;
  }
  return NOTICES.no_basis;
}

/**
 * Whether the answer failed in a way that makes a retry worthwhile. A refusal is
 * excluded: the same question will be declined again, so offering a retry would be
 * an invitation to waste a turn.
 */
export function isRetryableAnswerStatus(status: ChatMessage['answerStatus']): boolean {
  return status === 'retrieval_failed';
}
