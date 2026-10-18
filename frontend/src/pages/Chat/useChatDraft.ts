import { useCallback, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';
import { chatDraftStore } from '../../store/chatDraftStore';

export function chatDraftScope(sessionId: string | undefined, knowledgeBaseIds: string[], documentIds: string[] = []) {
  return sessionId ? `session:${sessionId}` : `new:${JSON.stringify([knowledgeBaseIds, [...documentIds].sort()])}`;
}

export function useChatDraft(userId: string | undefined, scope: string) {
  const draft = useSyncExternalStore(chatDraftStore.subscribe, () => userId ? chatDraftStore.get(userId, scope) : '', () => '');
  const setDraft = useCallback((value: SetStateAction<string>) => {
    if (!userId) return;
    chatDraftStore.set(userId, scope, typeof value === 'function' ? value(chatDraftStore.get(userId, scope)) : value);
  }, [userId, scope]);
  const moveToSession = useCallback((sessionId: string) => {
    if (userId) chatDraftStore.move(userId, scope, `session:${sessionId}`);
  }, [userId, scope]);
  const acknowledge = useCallback((sessionId: string, question: string) => {
    if (userId) chatDraftStore.acknowledge(userId, `session:${sessionId}`, question);
  }, [userId]);
  return { draft, setDraft, moveToSession, acknowledge };
}
