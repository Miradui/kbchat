import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, Citation } from '../../types/api';
import { MessageBubble } from './ChatMessage';
import { answerStatusNotice, isRetryableAnswerStatus } from './answerStatus';

const citation: Citation = {
  documentId: 'doc-1',
  chunkId: 'chunk-1',
  filename: 'policy.pdf',
  pageNumber: 3,
  content: '三十天内可退货。',
  vectorScore: 0.8,
  rerankScore: 0.9,
};

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    sessionId: 'session-1',
    role: 'assistant',
    content: '回答内容',
    citations: [],
    feedback: null,
    createdAt: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

function renderMessage(message: ChatMessage) {
  const props: ComponentProps<typeof MessageBubble> = {
    message,
    focusedCitationIndex: null,
    onFocusCitation: vi.fn(),
    canRegenerate: false,
    regenerating: false,
    onRegenerate: vi.fn(),
    feedbackSaving: false,
    onFeedback: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <MessageBubble {...props} />
    </MemoryRouter>,
  );
}

describe('answerStatusNotice', () => {
  it('separates the three failure modes', () => {
    // The whole point of the status: these three used to share one sentence, which
    // told two thirds of the affected users to do the wrong thing.
    const noBasis = answerStatusNotice(assistantMessage({ answerStatus: 'no_basis' }));
    const retrievalFailed = answerStatusNotice(assistantMessage({ answerStatus: 'retrieval_failed' }));
    const refused = answerStatusNotice(assistantMessage({ answerStatus: 'model_refused' }));

    expect(noBasis.message).toMatch(/未找到足够依据/);
    expect(retrievalFailed.message).toMatch(/检索服务暂时不可用/);
    expect(refused.message).toMatch(/不适合回答/);

    const messages = [noBasis.message, retrievalFailed.message, refused.message];
    expect(new Set(messages).size).toBe(3);
  });

  it('says nothing about a normal answer', () => {
    expect(answerStatusNotice(assistantMessage({ answerStatus: 'answered' })).message).toBe('');
  });

  it('does not tell the user to upload documents when retrieval broke', () => {
    // The failure mode this whole split exists to prevent: sending someone to fix
    // their knowledge base because a service was down.
    const notice = answerStatusNotice(assistantMessage({ answerStatus: 'retrieval_failed' }));
    expect(notice.message).not.toMatch(/补充/);
    expect(notice.message).toMatch(/与知识库里的资料无关/);
  });

  it('does not promise a refusal can be fixed by uploading', () => {
    const notice = answerStatusNotice(assistantMessage({ answerStatus: 'model_refused' }));
    expect(notice.message).not.toMatch(/补充/);
    expect(notice.message).toMatch(/与知识库资料是否齐全无关/);
  });

  it('treats a missing status on an ungrounded answer as the pre-019 default', () => {
    // Null means unknown. Reading it as "answered" would silently relabel every
    // answer written before the column existed.
    const notice = answerStatusNotice(assistantMessage({ answerStatus: null }));
    expect(notice.message).toMatch(/未找到足够依据/);
  });

  it('stays quiet on a missing status when the answer did cite something', () => {
    const notice = answerStatusNotice(assistantMessage({ answerStatus: null, citations: [citation] }));
    expect(notice.message).toBe('');
  });

  it('falls back rather than crashing on a status it does not know', () => {
    const notice = answerStatusNotice(assistantMessage({ answerStatus: 'something_new' as never }));
    expect(notice.message).toMatch(/未找到足够依据/);
  });

  it('marks only a retrieval failure as worth retrying', () => {
    // A refusal will be refused again, so a retry affordance would invite the user
    // to waste a turn.
    expect(isRetryableAnswerStatus('retrieval_failed')).toBe(true);
    expect(isRetryableAnswerStatus('model_refused')).toBe(false);
    expect(isRetryableAnswerStatus('no_basis')).toBe(false);
    expect(isRetryableAnswerStatus('answered')).toBe(false);
    expect(isRetryableAnswerStatus(null)).toBe(false);
  });
});

describe('MessageBubble answer status', () => {
  it('shows a refusal notice even though the answer has citations', () => {
    // Retrieval succeeded and the model declined anyway. If the notice were the
    // "no citations" branch of the footer it would never render here, which is the
    // case most likely to confuse someone reading the transcript.
    renderMessage(assistantMessage({ answerStatus: 'model_refused', citations: [citation] }));

    expect(screen.getByText(/不适合回答/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 条来源/ })).toBeInTheDocument();
  });

  it('announces a retrieval failure but not an ordinary empty result', () => {
    // role="alert" is reserved for the case where something broke. Announcing every
    // ungrounded answer would add noise without adding information.
    const { unmount } = renderMessage(assistantMessage({ answerStatus: 'retrieval_failed' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/检索服务暂时不可用/);
    unmount();

    renderMessage(assistantMessage({ answerStatus: 'no_basis' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/未找到足够依据/)).toBeInTheDocument();
  });

  it('shows no status line on a normal grounded answer', () => {
    renderMessage(assistantMessage({ answerStatus: 'answered', citations: [citation] }));

    expect(screen.queryByText(/未找到足够依据/)).toBeNull();
    expect(screen.queryByText(/检索服务暂时不可用/)).toBeNull();
    expect(screen.queryByText(/不适合回答/)).toBeNull();
  });

  it('says nothing about status on a user message', () => {
    renderMessage(assistantMessage({ role: 'user', content: '我的问题', answerStatus: null }));

    expect(screen.queryByText(/未找到足够依据/)).toBeNull();
  });
});
