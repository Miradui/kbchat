import { Button } from '../../components/ui/Button';
import type { RegenerationState } from './chatThreadHelpers';

/**
 * Shown while a send whose outcome is unknown reconciles itself. The user is
 * only asked to decide after the automatic checks are exhausted.
 */
export function UnconfirmedSendNotice({
  question,
  blocked,
  checking,
  needsDecision,
  onCheck,
  onResend,
}: {
  question: string;
  blocked: boolean;
  checking: boolean;
  needsDecision: boolean;
  onCheck: () => void;
  onResend: () => void;
}) {
  if (!needsDecision) {
    return (
      <div className="chat-recovery" role="status">
        <strong>正在确认这条消息…</strong>
        <p>网络结果暂时未知，正在自动核对。这条问题不会被重复发送。</p>
        <p className="chat-recovery__question" aria-label="正在核对的问题">“{question}”</p>
      </div>
    );
  }

  return (
    <div className="chat-recovery chat-recovery--decision" role="alert">
      <strong>没有找到这条消息</strong>
      <p>自动核对后仍未看到这条问题。确认后才会再次发送，原请求编号会保持不变。</p>
      <p className="chat-recovery__question" aria-label="待确认的问题">“{question}”</p>
      <div className="chat-recovery__actions">
        <Button disabled={checking || blocked} loading={checking} loadingLabel="检查中" variant="secondary" onClick={onCheck}>
          再检查一次
        </Button>
        <Button disabled={checking || blocked} variant="ghost" onClick={onResend}>确认重新发送</Button>
      </div>
    </div>
  );
}

export function RegenerationNotice({
  allowWrite,
  blocked,
  onCheck,
  onRegenerate,
  regeneration,
}: {
  allowWrite: boolean;
  blocked: boolean;
  onCheck: () => void;
  onRegenerate: (messageId: string) => void;
  regeneration: RegenerationState | null;
}) {
  if (!regeneration) return null;

  if (regeneration.kind === 'failed') {
    return (
      <div className="chat-recovery chat-recovery--failed" role="alert">
        <strong>重新生成失败</strong>
        <p>{regeneration.message}</p>
        {allowWrite && (
          <div className="chat-recovery__actions">
            <Button disabled={blocked} variant="secondary" onClick={() => onRegenerate(regeneration.messageId)}>重试</Button>
          </div>
        )}
      </div>
    );
  }

  const needsDecision = regeneration.autoChecksDone > 0;
  return (
    <div className={needsDecision ? 'chat-recovery chat-recovery--decision' : 'chat-recovery'} role={needsDecision ? 'alert' : 'status'}>
      <strong>{needsDecision ? '没有找到新的回答' : '正在确认重新生成结果…'}</strong>
      <p>{regeneration.message}</p>
      <div className="chat-recovery__actions">
        <Button
          disabled={regeneration.checking || blocked}
          loading={regeneration.checking}
          loadingLabel="检查中"
          variant="secondary"
          onClick={onCheck}
        >
          再检查一次
        </Button>
        {needsDecision && allowWrite && (
          <Button disabled={regeneration.checking || blocked} variant="ghost" onClick={() => onRegenerate(regeneration.messageId)}>
            确认重新生成
          </Button>
        )}
      </div>
    </div>
  );
}
