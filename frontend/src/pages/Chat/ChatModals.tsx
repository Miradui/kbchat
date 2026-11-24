import { lazy, Suspense } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { ChatBookmark, ChatFeedbackDetails, ChatMessage, KnowledgeBase } from '../../types/api';
import { ChatSessionActionDialogs } from './ChatSessionActionDialogs';
import type { ChatTaskKind, ChatTaskResult } from './ChatTaskDialog';
import type { ChatDocument } from './documentChatScope';
import type { useSessionActions } from './useSessionActions';

const LazyChatTaskDialog = lazy(() =>
  import('./ChatTaskDialog').then((m) => ({ default: m.ChatTaskDialog })),
);
const LazyChatDocumentPicker = lazy(() =>
  import('./ChatDocumentPicker').then((m) => ({ default: m.ChatDocumentPicker })),
);
const LazyChatBookmarkDialog = lazy(() =>
  import('./ChatBookmarks').then((m) => ({ default: m.ChatBookmarkDialog })),
);
const LazyChatBookmarksDialog = lazy(() =>
  import('./ChatBookmarks').then((m) => ({ default: m.ChatBookmarksDialog })),
);
const LazyChatSearchDialog = lazy(() =>
  import('./ChatSearchDialog').then((m) => ({ default: m.ChatSearchDialog })),
);
const LazyChatFeedbackDialog = lazy(() =>
  import('./ChatFeedbackDialog').then((m) => ({ default: m.ChatFeedbackDialog })),
);

type ChatModalsProps = {
  knowledgeBases: KnowledgeBase[];
  taskKind: ChatTaskKind | null;
  onCloseTask: () => void;
  onApplyTask: (result: ChatTaskResult) => void;
  documentPickerOpen: boolean;
  onCloseDocumentPicker: () => void;
  onSelectDocuments: (documents: ChatDocument[]) => void;
  bookmarkTarget: ChatMessage | null;
  onCloseBookmarkTarget: () => void;
  onUpdateMessageBookmark: (messageId: string, bookmark: ChatBookmark | null) => void;
  onInaccessible: (caught: unknown, sessionId: string) => boolean;
  bookmarksOpen: boolean;
  onCloseBookmarks: () => void;
  searchDialogOpen: boolean;
  onCloseSearchDialog: () => void;
  onNavigateToHit: (item: { sessionId: string; messageId: string }, closeDialog: () => void) => void;
  sessionActions: ReturnType<typeof useSessionActions>;
  editConfirm: { messageId: string; content: string } | null;
  editBusy: boolean;
  onCancelEditConfirm: () => void;
  onConfirmEdit: (pending: { messageId: string; content: string }) => void;
  feedbackTarget: ChatMessage | null;
  onCloseFeedback: () => void;
  onSubmitFeedback: (messageId: string, details: ChatFeedbackDetails) => Promise<boolean>;
};

export function ChatModals({
  knowledgeBases,
  taskKind,
  onCloseTask,
  onApplyTask,
  documentPickerOpen,
  onCloseDocumentPicker,
  onSelectDocuments,
  bookmarkTarget,
  onCloseBookmarkTarget,
  onUpdateMessageBookmark,
  onInaccessible,
  bookmarksOpen,
  onCloseBookmarks,
  searchDialogOpen,
  onCloseSearchDialog,
  onNavigateToHit,
  sessionActions,
  editConfirm,
  editBusy,
  onCancelEditConfirm,
  onConfirmEdit,
  feedbackTarget,
  onCloseFeedback,
  onSubmitFeedback,
}: ChatModalsProps) {
  return (
    <>
      {taskKind && (
        <Suspense fallback={null}>
          <LazyChatTaskDialog kind={taskKind} knowledgeBases={knowledgeBases} onClose={onCloseTask} onApply={onApplyTask} />
        </Suspense>
      )}
      {documentPickerOpen && (
        <Suspense fallback={null}>
          <LazyChatDocumentPicker knowledgeBases={knowledgeBases} onClose={onCloseDocumentPicker} onSelect={onSelectDocuments} />
        </Suspense>
      )}
      {bookmarkTarget && (
        <Suspense fallback={null}>
          <LazyChatBookmarkDialog
            key={bookmarkTarget.id}
            target={{ messageId: bookmarkTarget.id, sessionId: bookmarkTarget.sessionId, bookmark: bookmarkTarget.bookmark }}
            onClose={onCloseBookmarkTarget}
            onUpdated={onUpdateMessageBookmark}
            onInaccessible={onInaccessible}
          />
        </Suspense>
      )}
      {bookmarksOpen && (
        <Suspense fallback={null}>
          <LazyChatBookmarksDialog
            onClose={onCloseBookmarks}
            onUpdated={onUpdateMessageBookmark}
            onInaccessible={onInaccessible}
            onSelect={(item) => onNavigateToHit(item, onCloseBookmarks)}
          />
        </Suspense>
      )}
      {searchDialogOpen && (
        <Suspense fallback={null}>
          <LazyChatSearchDialog
            onClose={onCloseSearchDialog}
            onSelect={(item) => onNavigateToHit(item, onCloseSearchDialog)}
          />
        </Suspense>
      )}

      <ChatSessionActionDialogs actions={sessionActions} />

      {editConfirm && (
        <ConfirmDialog
          busy={editBusy}
          confirmLabel="删除并重新生成"
          description="将删除这条提问之后的全部消息，并基于新的提问重新生成回答。此操作不可撤销。"
          onCancel={onCancelEditConfirm}
          onConfirm={() => onConfirmEdit(editConfirm)}
          title="编辑这条提问会删除后续消息"
        />
      )}

      {feedbackTarget && (
        <Suspense fallback={null}>
          <LazyChatFeedbackDialog
            key={feedbackTarget.id}
            initial={feedbackTarget.feedback}
            onClose={onCloseFeedback}
            onSubmit={(details) => onSubmitFeedback(feedbackTarget.id, details)}
          />
        </Suspense>
      )}
    </>
  );
}
