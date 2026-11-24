import { lazy, memo, Suspense, useState } from 'react';
import { Button } from '../../components/ui/Button';
import type { ChatMessage, ChatSession } from '../../types/api';

const LazyQualityIssueDialog = lazy(() =>
  import('../Quality/QualityIssueDialog').then((m) => ({ default: m.QualityIssueDialog })),
);
const LazyEvaluationCaseDialog = lazy(() =>
  import('../Quality/EvaluationCaseDialog').then((m) => ({ default: m.EvaluationCaseDialog })),
);

type Props = {
  session: ChatSession;
  message: ChatMessage;
  question: string;
  disabled?: boolean;
  onChooseDocuments: (question: string) => void;
  onRefineQuestion: (question: string) => void;
};

export const ChatNoBasisActions = memo(function ChatNoBasisActions(props: Props) {
  if (props.message.role !== 'assistant' || props.message.answerStatus !== 'no_basis' || !props.question.trim()) return null;
  return <NoBasisActions key={`${props.session.id}:${props.message.id}:${props.question}`} {...props} />;
});

function NoBasisActions({ session, message, question, disabled, onChooseDocuments, onRefineQuestion }: Props) {
  const [dialog, setDialog] = useState<'followup' | 'case' | null>(null);
  return <div className="chat-no-basis-actions">
    <p className="ui-muted">可以选择相关资料，或补充问题背景。更换资料会进入新会话，并保留这个问题。</p>
    <div className="chat-no-basis-actions__buttons">
      <Button variant="secondary" disabled={disabled} onClick={() => onChooseDocuments(question)}>选择相关资料</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => onRefineQuestion(question)}>补充问题背景</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => setDialog('followup')}>跟进这个问题</Button>
    </div>
    {dialog === 'followup' && <Suspense fallback={null}><LazyQualityIssueDialog target={{ sessionId: session.id, knowledgeBaseId: session.knowledgeBaseId, question, messageId: message.id, session }} onClose={() => setDialog(null)} onCreateCase={() => setDialog('case')} /></Suspense>}
    {dialog === 'case' && <Suspense fallback={null}><LazyEvaluationCaseDialog knowledgeBaseId={session.knowledgeBaseId} initial={{ question, sourceSessionId: session.id }} onClose={() => setDialog('followup')} onSaved={() => setDialog('followup')} /></Suspense>}
  </div>;
}
