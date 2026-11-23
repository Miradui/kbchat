import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getChatQualityIssue, getChatSession, getKnowledgeBase, listKnowledgeBases, saveChatQualityIssue } from '../../api/resources';
import type { ChatSession, KnowledgeBase } from '../../types/api';
import { hasCapability } from '../../utils/access';
import { useKnowledgeBaseOptions } from '../../hooks/useKnowledgeBaseOptions';
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

export type QualityIssueTarget = { sessionId: string; knowledgeBaseId: string; question: string; messageId?: string | null; session?: ChatSession };
type Props = { target: QualityIssueTarget; onClose: () => void; onCreateCase: () => void };
export function QualityIssueDialog(props: Props) {
  const { target } = props;
  return <QualityIssueForm key={`${target.sessionId}:${target.knowledgeBaseId}:${target.question}:${target.messageId ?? ''}`} {...props} />;
}
function QualityIssueForm({ target, onClose, onCreateCase }: Props) {
  const navigate = useNavigate();
  const fieldId = useId();
  const options = useKnowledgeBaseOptions();
  const [session, setSession] = useState<ChatSession | null>(target.session ?? null);
  const [primary, setPrimary] = useState<KnowledgeBase | null>(null);
  const [scopeError, setScopeError] = useState('');
  const [extraBases, setExtraBases] = useState<KnowledgeBase[]>([]);
  const [nextPage, setNextPage] = useState(2);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const candidates = [...new Map([...options.items, ...extraBases, ...(primary ? [primary] : [])].map((kb) => [kb.id, kb])).values()].filter((kb) => hasCapability(kb, 'content.write'));
  const fixedSingle = session && session.scopeMode !== 'auto' && (session.knowledgeBaseIds?.length ?? 1) === 1;
  const uploadTarget = uploadId ?? (fixedSingle && hasCapability(primary, 'content.write') ? primary!.id : '');
  const canEvaluate = hasCapability(primary, 'quality.read');
  const canRun = canEvaluate && hasCapability(primary, 'chat.use');
  const [issue, setIssue] = useState<ChatQualityIssue | null>(null);
  const [baseline, setBaseline] = useState('');
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scopeAttempt, setScopeAttempt] = useState(0);
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

    return () => { mounted.current = false; abort.abort(); };
  }, [target.sessionId, target.knowledgeBaseId, target.question, attempt]);
  useEffect(() => {
    let active = true;
    void Promise.all([target.session ? Promise.resolve(target.session) : getChatSession(target.sessionId), getKnowledgeBase(target.knowledgeBaseId)]).then(([scope, kb]) => {
      if (active) { setSession(scope); setPrimary(kb); setScopeError(''); }
    }).catch((caught) => { if (active) { setPrimary(null); setScopeError(getErrorMessage(caught, '原会话范围或权限暂时无法确认；仍可保存个人备注。')); } });
    return () => { active = false; };
  }, [target.session, target.sessionId, target.knowledgeBaseId, scopeAttempt]);
  useEffect(() => {
    if (!canEvaluate || !session) return;
    const abort = new AbortController();
    void listEvaluationCases(target.knowledgeBaseId, abort.signal).then((value) => {
      if (!abort.signal.aborted) setCases(value.items.filter((item) => item.question === target.question && (item.sourceSessionId === target.sessionId || (!item.sourceSessionId && fixedSingle && !session.documents?.length))));
    }).catch((caught) => { if (!abort.signal.aborted) setScopeError(getErrorMessage(caught, '测试问题暂时无法读取；仍可保存个人备注。')); });
    return () => abort.abort();
  }, [canEvaluate, session, fixedSingle, target.knowledgeBaseId, target.question, target.sessionId, scopeAttempt]);
  const runId = canEvaluate ? issue?.evaluationRunId : undefined;
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
    if (!canRun || !issue?.evaluationCaseId || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const current = issue;
    try {
      if (runRequest.current?.caseIds[0] !== current.evaluationCaseId) {
        const kb = await getKnowledgeBase(target.knowledgeBaseId);
        if (!mounted.current) return;
        if (!hasCapability(kb, 'quality.read') || !hasCapability(kb, 'chat.use')) throw new Error('当前没有复测权限；仍可保存个人备注。');
        runRequest.current = { clientRequestId: crypto.randomUUID(), name: '知识缺口复测', caseIds: [current.evaluationCaseId], config: kb.retrievalConfig };
      }
      const result = await createEvaluationRun(target.knowledgeBaseId, runRequest.current);
      if (!mounted.current) return;
      acknowledgedRun.current = result.id;
      const next = { ...current, status: 'retest' as const, evaluationRunId: result.id };
      if (mounted.current) { setIssue(next); setRun(result); }
      const saved = await saveChatQualityIssue(target.sessionId, next);
      if (mounted.current) { setIssue(saved); setBaseline(JSON.stringify(saved)); runRequest.current = null; acknowledgedRun.current = null; }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '复测或记录保存未确认，可重试；不会自动判定问题已解决。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const value = await listKnowledgeBases({ page: nextPage, pageSize: 100, sort: 'updatedAt_desc' });
      if (mounted.current) { setExtraBases((previous) => [...previous, ...value.items]); setNextPage(nextPage + 1); setHasMore(value.total !== undefined ? nextPage * 100 < value.total : value.items.length === 100); }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '更多知识库加载失败')); }
    finally { if (mounted.current) setLoadingMore(false); }
  }
  async function supplement() {
    if (!uploadTarget || pending.current || !session) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const kb = await getKnowledgeBase(uploadTarget);
      if (!mounted.current) return;
      if (!hasCapability(kb, 'content.write')) throw new Error('当前没有向此知识库补充资料的权限，请选择其他目标。');
      pending.current = false;
      if (await save()) { onClose(); navigate(`/knowledge-bases/${encodeURIComponent(kb.id)}/documents`); }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '补资料目标暂时无法确认')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const answerUrl = `/chat/${encodeURIComponent(target.sessionId)}${target.messageId ? `?messageId=${encodeURIComponent(target.messageId)}` : ''}`;
  return <>
    <Dialog open title="跟进知识缺口" description="补充资料后按原范围复测，核对结果后再手动标记已解决。" onClose={close}>
      <p>{target.question}</p>
      <p className="ui-muted">仅自己可见。同会话相同问题共用处理记录；回答版本共用备注与处理状态。</p>
      <Link className="ui-button ui-button--link" to={answerUrl} onClick={(event) => { if (busy || dirty) { event.preventDefault(); if (!busy) void save().then((saved) => { if (saved) { onClose(); navigate(answerUrl); } }); } else onClose(); }}>{target.messageId ? '查看这条回答' : '查看原会话'}</Link>
      <p className="ui-muted">原范围：{session ? session.scopeMode === 'auto' ? '自动跨库检索' : session.documents?.length ? `指定文档：${session.documents.map((item) => item.filename).join('、')}` : `固定知识库：${session.knowledgeBases?.map((item) => item.name).join('、') || primary?.name || '原会话知识库'}` : '正在确认' }。关联补充文档不会改变原范围；指定文档范围若需更换资料，请另开会话。</p>
      {scopeError && <p role="alert">{scopeError}<Button variant="link" onClick={() => setScopeAttempt((value) => value + 1)}>重新确认范围与权限</Button></p>}
      {!issue && !error && <p role="status">正在加载处理记录…</p>}
      {issue && <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="处理状态" htmlFor={`${fieldId}-status`}><Select id={`${fieldId}-status`} name="status" disabled={busy} value={issue.status} onChange={(event) => setIssue({ ...issue, status: event.target.value as ChatQualityIssue['status'] })}><option value="open">待处理</option><option value="retest">待复测／待核对</option><option value="resolved">已解决（已人工核对）</option></Select></Field>
        <Field label="处理备注" htmlFor={`${fieldId}-note`}><Textarea id={`${fieldId}-note`} name="note" rows={3} maxLength={4000} disabled={busy} value={issue.note} onChange={(event) => setIssue({ ...issue, note: event.target.value })} /></Field>
        {session && candidates.length > 0 && <>
          <Field label="补资料目标库" htmlFor={`${fieldId}-upload`} hint="请选择与问题相关的知识库。补资料目标不会修改原会话范围或复测范围。"><Select id={`${fieldId}-upload`} disabled={busy} value={uploadTarget} onChange={(event) => setUploadId(event.target.value)}><option value="">请选择有上传权限的知识库</option>{candidates.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}</Select></Field>
          <Button variant="ghost" disabled={busy || !uploadTarget} onClick={() => void supplement()}>去补充资料</Button>
        </>}
        {options.loading && <p role="status">正在确认可补资料的知识库…</p>}
        {!options.loading && !candidates.length && <p className="ui-muted">当前没有已确认可上传的知识库。你可以先保存备注、补充问题背景，或请有权限的资料维护者补充内容。</p>}
        {options.error && <p role="alert">{options.error}<Button variant="link" onClick={() => void options.reload()}>重试知识库列表</Button></p>}
        {hasMore && options.items.length >= 100 && <Button variant="link" loading={loadingMore} disabled={busy} onClick={() => void loadMore()}>加载更多知识库</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => setPicking(true)}>关联补充文档（{issue.documentIds.length}）</Button>
        {canEvaluate && session && <><Field label="复测问题" htmlFor={`${fieldId}-case`}><Select id={`${fieldId}-case`} name="evaluationCaseId" disabled={busy} value={issue.evaluationCaseId} onChange={(event) => setIssue({ ...issue, evaluationCaseId: event.target.value, evaluationRunId: '' })}><option value="">选择相同范围的测试问题</option>{cases.map((item) => <option value={item.id} key={item.id}>{item.question} · {item.sourceSessionId ? '来源会话范围' : '单库范围'}</option>)}</Select></Field>
        {!cases.length && <Button variant="ghost" disabled={busy} onClick={() => void save().then((saved) => { if (saved) onCreateCase(); })}>保存为测试问题</Button>}
        <Button variant="secondary" disabled={busy || !canRun || !issue.evaluationCaseId || run?.status === 'running' || run?.status === 'queued'} onClick={() => void retest()}>按原范围复测</Button>
        {run && <div role="status"><p>最近复测：{({ queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[run.status]}</p>{run.results?.map((result) => <div key={result.caseId}><p>{result.errorMessage || result.answer}</p><small>{result.rulePassed === true ? '显式规则通过，仍需人工核对' : result.rulePassed === false ? '显式规则未通过' : '待人工核对'}</small></div>)}</div>}</>}
        {!canEvaluate && <p className="ui-muted">复测需有原会话首选知识库的质量权限；你仍可保存个人备注并手动更新处理状态。</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={close}>关闭</Button><Button type="submit" loading={busy} disabled={!dirty}>保存处理记录</Button></div>
      </form>}
      {error && <p role="alert">{error}{!issue && <Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}</p>}
      {notice && <p role="status">{notice}</p>}
      {!issue && <div className="ui-dialog__actions"><Button variant="secondary" onClick={close}>关闭</Button></div>}
    </Dialog>
    {picking && issue && <ChatDocumentPicker onClose={() => setPicking(false)} onSelect={(documents) => { setIssue({ ...issue, documentIds: documents.map((item) => item.id), status: 'retest' }); setPicking(false); }} />}
    {discard && <ConfirmDialog title="放弃未保存的处理记录？" description="未保存的备注和关联修改将丢失。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}
