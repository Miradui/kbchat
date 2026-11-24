import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession } from '../../types/api';
import { ChatNoBasisActions } from './ChatNoBasisActions';

vi.mock('../Quality/QualityIssueDialog', () => ({ QualityIssueDialog: ({ target }: { target: { messageId: string; question: string } }) => <div role="dialog">{target.messageId}:{target.question}</div> }));
vi.mock('../Quality/EvaluationCaseDialog', () => ({ EvaluationCaseDialog: () => null }));
const session = { id: 'session', knowledgeBaseId: 'kb', scopeMode: 'auto' } as ChatSession;
const message = { id: 'answer', role: 'assistant', answerStatus: 'no_basis' } as ChatMessage;
const callbacks = { onChooseDocuments: vi.fn(), onRefineQuestion: vi.fn() };

it.each(['answered', 'retrieval_failed', 'model_refused', undefined, 'unknown'])('does not misclassify %s as a missing-document followup', (answerStatus) => {
 render(<ChatNoBasisActions session={session} message={{ ...message, answerStatus } as ChatMessage} question="保险呢" {...callbacks} />);
 expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('keeps the original question and exact answer when choosing next steps', async () => {
 render(<ChatNoBasisActions session={session} message={message} question="保险呢" {...callbacks} />);
 fireEvent.click(screen.getByRole('button', { name: '选择相关资料' }));
 expect(callbacks.onChooseDocuments).toHaveBeenCalledWith('保险呢');
 fireEvent.click(screen.getByRole('button', { name: '补充问题背景' }));
 expect(callbacks.onRefineQuestion).toHaveBeenCalledWith('保险呢');
 fireEvent.click(screen.getByRole('button', { name: '跟进这个问题' }));
 expect(await screen.findByRole('dialog')).toHaveTextContent('answer:保险呢');
});
it('discards the previous answer dialog after changing answer version', () => {
 const view = render(<ChatNoBasisActions session={session} message={message} question="保险呢" {...callbacks} />);
 fireEvent.click(screen.getByRole('button', { name: '跟进这个问题' }));
 view.rerender(<ChatNoBasisActions session={session} message={{ ...message, id: 'answer-2' }} question="保险呢" {...callbacks} />);
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('disables next steps while the answer is busy', () => {
 render(<ChatNoBasisActions session={session} message={message} question="保险呢" disabled {...callbacks} />);
 for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
});
