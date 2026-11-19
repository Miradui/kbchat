import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getChatQualityIssue, getKnowledgeBase, saveChatQualityIssue } from '../../api/resources';
import type { ChatQualityIssue } from '../../api/resources';
import { createEvaluationRun, getEvaluationRun, listEvaluationCases } from '../../api/evaluations';
import type { EvaluationCase, EvaluationRun, EvaluationRunInput } from '../../types/evaluation';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Select, Textarea } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { getErrorMessage } from '../../utils/errors';
import { ChatDocumentPicker } from '../Chat/ChatDocumentPicker';

export type QualityIssueTarget = { sessionId: string; knowledgeBaseId: string; question: string };
export function QualityIssueDialog({ target, onClose, onCreateCase }: { target: QualityIssueTarget; onClose: () => void; onCreateCase: () => void }) {
  const navigate = useNavigate();
  const [issue, setIssue] = useState<ChatQualityIssue | null>(null);
  const [baseline, setBaseline] = useState('');
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [discard, setDiscard] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  const runRequest = useRef<EvaluationRunInput | null>(null);
  const acknowledgedRun = useRef<string | null>(null);
  const dirty = issue !== null && JSON.stringify(issue) !== baseline;
  useUnsavedChangesWarning(dirty);
  useEffect(() => {
    mounted.current = true; const abort = new AbortController(); setError('');
    void getChatQualityIssue(target.sessionId, target.question, abort.signal).then((value) => {
      if (!abort.signal.aborted) { setIssue(value); setBaseline(JSON.stringify(value)); }
    }).catch((caught) => { if (!abort.signal.aborted) setError(getErrorMessage(caught, '处理记录加载失败')); });
    void listEvaluationCases(target.knowledgeBaseId, abort.signal).then((value) => {
      if (!abort.signal.aborted) setCases(value.items.filter((item) => item.question === target.question && (!item.sourceSessionId || item.sourceSessionId === target.sessionId)));
    }).catch(() => { /* The issue remains usable without evaluation permissions. */ });
    return () => { mounted.current = false; abort.abort(); };
  }, [target.sessionId, target.knowledgeBaseId, target.question, attempt]);
  const runId = issue?.evaluationRunId;
  useEffect(() => {
    if (!runId) { setRun(null); return; }
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const value = await getEvaluationRun(target.knowledgeBaseId, runId, abort.signal);
        if (!abort.signal.aborted) { setRun(value); if (value.status === 'queued' || value.status === 'running') timer = setTimeout(() => void read(), 2000); }
      } catch (caught) { if (!abort.signal.aborted) setError(getErrorMessage(caught, '复测结果暂时无法读取')); }
    };
    void read(); return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [target.knowledgeBaseId, runId]);
  function close() { if (pending.current) return; if (dirty) setDiscard(true); else onClose(); }
  async function save(next = issue) {
    if (!next || pending.current) return false;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { const value = await saveChatQualityIssue(target.sessionId, next); if (mounted.current) { setIssue(value); setBaseline(JSON.stringify(value)); setNotice('处理记录已保存。'); if (value.evaluationRunId === acknowledgedRun.current) { runRequest.current = null; acknowledgedRun.current = null; } } return mounted.current; }
    catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '处理记录保存失败')); return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function retest() {
    if (!issue?.evaluationCaseId || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const current = issue;
    try {
      if (runRequest.current?.caseIds[0] !== current.evaluationCaseId) {
        const kb = await getKnowledgeBase(target.knowledgeBaseId);
        runRequest.current = { clientRequestId: crypto.randomUUID(), name: '知识缺口复测', caseIds: [current.evaluationCaseId], config: kb.retrievalConfig };
      }
      const result = await createEvaluationRun(target.knowledgeBaseId, runRequest.current);
      acknowledgedRun.current = result.id;
      const next = { ...current, status: 'retest' as const, evaluationRunId: result.id };
      if (mounted.current) { setIssue(next); setRun(result); }
      const saved = await saveChatQualityIssue(target.sessionId, next);
      if (mounted.current) { setIssue(saved); setBaseline(JSON.stringify(saved)); runRequest.current = null; acknowledgedRun.current = null; }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '复测或记录保存未确认，可重试；不会自动判定问题已解决。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <Dialog open title="跟进知识缺口" description="补充资料后按原范围复测，核对结果后再手动标记已解决。" onClose={close}>
      <p>{target.question}</p>
      {!issue && !error && <p role="status">正在加载处理记录…</p>}
      {issue && <div className="ui-form">
        <Field label="处理状态"><Select aria-label="处理状态" disabled={busy} value={issue.status} onChange={(event) => setIssue({ ...issue, status: event.target.value as ChatQualityIssue['status'] })}><option value="open">待处理</option><option value="retest">待复测／待核对</option><option value="resolved">已解决（已人工核对）</option></Select></Field>
        <Field label="处理备注"><Textarea aria-label="处理备注" rows={3} maxLength={4000} disabled={busy} value={issue.note} onChange={(event) => setIssue({ ...issue, note: event.target.value })} /></Field>
        <Button variant="ghost" disabled={busy} onClick={() => void save().then((saved) => { if (saved) { onClose(); navigate(`/knowledge-bases/${target.knowledgeBaseId}/documents`); } })}>去补充资料</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setPicking(true)}>关联补充文档（{issue.documentIds.length}）</Button>
        <Field label="复测问题"><Select aria-label="复测问题" disabled={busy} value={issue.evaluationCaseId} onChange={(event) => setIssue({ ...issue, evaluationCaseId: event.target.value, evaluationRunId: '' })}><option value="">选择相同范围的测试问题</option>{cases.map((item) => <option value={item.id} key={item.id}>{item.question} · {item.sourceSessionId ? '来源会话范围' : '单库范围'}</option>)}</Select></Field>
        {!cases.length && <Button variant="ghost" disabled={busy} onClick={() => void save().then((saved) => { if (saved) onCreateCase(); })}>保存为测试问题</Button>}
        <Button variant="secondary" disabled={busy || !issue.evaluationCaseId || run?.status === 'running' || run?.status === 'queued'} onClick={() => void retest()}>按原范围复测</Button>
        {run && <div role="status"><p>最近复测：{({ queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[run.status]}</p>{run.results?.map((result) => <div key={result.caseId}><p>{result.errorMessage || result.answer}</p><small>{result.rulePassed === true ? '显式规则通过，仍需人工核对' : result.rulePassed === false ? '显式规则未通过' : '待人工核对'}</small></div>)}</div>}
      </div>}
      {error && <p role="alert">{error}{!issue && <Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={close}>关闭</Button><Button loading={busy} disabled={!issue || !dirty} onClick={() => void save()}>保存处理记录</Button></div>
    </Dialog>
    {picking && issue && <ChatDocumentPicker onClose={() => setPicking(false)} onSelect={(documents) => { setIssue({ ...issue, documentIds: documents.map((item) => item.id), status: 'retest' }); setPicking(false); }} />}
    {discard && <ConfirmDialog title="放弃未保存的处理记录？" description="未保存的备注和关联修改将丢失。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}
