import type { ReactNode } from 'react';

import type { RetryNotice } from '../../components/feedback/RetryCountdown';
import { ChatComposer } from './ChatComposer';
import { useChatDraft } from './useChatDraft';

type ChatScopedComposerProps = {
  userId?: string;
  draftScope: string;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  hint?: string;
  error?: string;
  retryNotice?: RetryNotice | null;
  onDismissRateLimitError: () => void;
  onSubmitQuestion: (question: string) => void;
  onCancel: () => void;
  tools?: ReactNode;
};

/** Owns draft subscription locally so typing never re-renders the thread list. */
export function ChatScopedComposer({
  userId,
  draftScope,
  onDismissRateLimitError,
  onSubmitQuestion,
  ...rest
}: ChatScopedComposerProps) {
  const { draft, setDraft } = useChatDraft(userId, draftScope);
  return (
    <ChatComposer
      {...rest}
      onChange={(value) => {
        setDraft(value);
        onDismissRateLimitError();
      }}
      onSubmit={() => {
        const question = draft.trim();
        if (question) onSubmitQuestion(question);
      }}
      value={draft}
    />
  );
}
