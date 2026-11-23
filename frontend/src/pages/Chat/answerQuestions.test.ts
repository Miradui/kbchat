import { expect, it } from 'vitest';
import type { ChatMessage } from '../../types/api';
import { answerQuestions } from './answerQuestions';

const message = (id: string, role: ChatMessage['role'], content: string, clientRequestId?: string): ChatMessage => ({ id, role, content, clientRequestId, sessionId: 's1', citations: [], createdAt: '' });
it('pairs regenerated and original answers with their question and excludes other sessions', () => {
  const rows = [message('partial', 'assistant', '没有加载的问题'), message('q1', 'user', '原问题', 'r1'), message('a1', 'assistant', '旧版', 'r1'), message('a2', 'assistant', '重新生成'), message('q2', 'user', '第二个问题', 'r2'), message('a3', 'assistant', '明确请求关联', 'r1'), { ...message('foreign', 'assistant', '别人的会话'), sessionId: 's2' }];
  const result = answerQuestions(rows, 's1');
  expect(result.has('partial')).toBe(false);
  expect(result.has('foreign')).toBe(false);
  expect(result.get('a1')).toBe('原问题');
  expect(result.get('a2')).toBe('原问题');
  expect(result.get('a3')).toBe('原问题');
});
