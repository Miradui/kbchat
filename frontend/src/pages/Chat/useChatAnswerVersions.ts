import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ChatMessage } from '../../types/api';

type MessageGroup = { id: string; versions: ChatMessage[] };
type VersionSelection = { id: string; latestId: string };

/** Regeneration appends an assistant message after the same user turn. Keep the
 * complete history for feedback/search, but render one answer per question. */
function groupAnswers(messages: ChatMessage[], sessionId?: string): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let question: ChatMessage | null = null;
  let answers: MessageGroup | null = null;
  for (const message of messages) {
    if (message.sessionId !== sessionId) continue;
    if (message.role === 'assistant' && question) {
      if (answers) answers.versions.push(message);
      else {
        answers = { id: message.id, versions: [message] };
        groups.push(answers);
      }
    } else {
      question = message.role === 'user' ? message : null;
      answers = null;
      groups.push({ id: message.id, versions: [message] });
    }
  }
  return groups;
}

export function useChatAnswerVersions(messages: ChatMessage[], sessionId: string | undefined, locatedId?: string) {
  const groups = useMemo(() => groupAnswers(messages, sessionId), [messages, sessionId]);
  const [selection, setSelection] = useState<{ sessionId?: string; answers: Record<string, VersionSelection> }>({ answers: {} });
  useEffect(() => { setSelection({ sessionId, answers: {} }); }, [sessionId]);
  const rows = useMemo(() => groups.map((group) => {
    const latest = group.versions[group.versions.length - 1];
    const saved = selection.sessionId === sessionId ? selection.answers[group.id] : undefined;
    const selectedId = saved?.latestId === latest.id ? saved.id : latest.id;
    const locatedIndex = group.versions.findIndex((message) => message.id === locatedId);
    const selectedIndex = group.versions.findIndex((message) => message.id === selectedId);
    const index = locatedIndex >= 0 ? locatedIndex : selectedIndex >= 0 ? selectedIndex : group.versions.length - 1;
    return { ...group, index, message: group.versions[index] };
  }), [groups, locatedId, selection, sessionId]);

  const selectVersion = useCallback((groupId: string, index: number) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group?.versions[index]) return;
    setSelection((current) => ({
      sessionId,
      answers: {
        ...(current.sessionId === sessionId ? current.answers : {}),
        [group.id]: { id: group.versions[index].id, latestId: group.versions[group.versions.length - 1].id },
      },
    }));
  }, [groups, sessionId]);

  return { rows, selectVersion };
}
