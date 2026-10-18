import { useLayoutEffect, useMemo, useReducer } from 'react';
import type { SetStateAction } from 'react';
import type { ChatMessage, Citation } from '../../types/api';

type State = {
  focusedCitation: { messageId: string; index: number | null } | null;
  sourcePreview: { citation: Citation; index: number; scope: string; question?: string; relatedDocumentIds?: string[] } | null;
  feedbackSavingIds: Set<string>;
  feedbackTarget: ChatMessage | null;
  editingMessageId: string | null;
  editingDraft: string;
};
function initialState(): State {
  return {
    focusedCitation: null,
    sourcePreview: null,
    feedbackSavingIds: new Set(),
    feedbackTarget: null,
    editingMessageId: null,
    editingDraft: '',
  };
}
type Action = { type: 'sessionChanged' } | { type: 'update'; update: (state: State) => State };
function reducer(state: State, action: Action) {
  return action.type === 'sessionChanged' ? initialState() : action.update(state);
}

/** UI state only: changing the route must not remount the request owner. */
export function useChatInteractionState(sessionId?: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useLayoutEffect(() => dispatch({ type: 'sessionChanged' }), [sessionId]);
  const setters = useMemo(() => {
    function setter<K extends keyof State>(key: K) {
      return (value: SetStateAction<State[K]>) =>
        dispatch({
          type: 'update',
          update: (current) => ({
            ...current,
            [key]:
              typeof value === 'function'
                ? (value as (previous: State[K]) => State[K])(current[key])
                : value,
          }),
        });
    }
    return {
      setFocusedCitation: setter('focusedCitation'),
      setSourcePreview: setter('sourcePreview'),
      setFeedbackSavingIds: setter('feedbackSavingIds'),
      setFeedbackTarget: setter('feedbackTarget'),
      setEditingMessageId: setter('editingMessageId'),
      setEditingDraft: setter('editingDraft'),
    };
  }, []);
  return { ...state, ...setters };
}
