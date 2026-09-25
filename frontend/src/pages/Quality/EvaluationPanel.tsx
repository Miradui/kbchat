import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { cancelEvaluationRun, createEvaluationRun, deleteEvaluationCase, getEvaluationRun, listEvaluationCases, listEvaluationRuns } from '../../api/evaluations';
import { getCurrentUser } from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { useToast } from '../../components/feedback/ToastProvider';
import { Button } from '../../components/ui/Button';
import { Checkbox, Field, Input, Select } from '../../components/ui/Field';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import { currentUserStore } from '../../store/currentUserStore';
import { tokenStore } from '../../store/tokenStore';
import type { KnowledgeBase, RetrievalConfig } from '../../types/api';
import type { EvaluationCase, EvaluationRun, EvaluationRunInput } from '../../types/evaluation';
import { getErrorMessage } from '../../utils/errors';
import { formatDateTime } from '../../utils/format';
import { EvaluationCaseDialog } from './EvaluationCaseDialog';
import { EvaluationComparison, evaluationStatusLabels, isEvaluationActive } from './EvaluationComparison';

function readPending(key: string): EvaluationRunInput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null') as EvaluationRunInput | null;
    return value && typeof value.clientRequestId === 'string' && typeof value.name === 'string' && Array.isArray(value.caseIds)
      && value.caseIds.every((id) => typeof id === 'string') && value.config
      && typeof value.config.vectorTopN === 'number' && typeof value.config.rerankTopK === 'number'
      && typeof value.config.scoreThreshold === 'number' && typeof value.config.enableRerank === 'boolean' ? value : null;
  } catch { return null; }
}

export function EvaluationPanel({ knowledgeBase }: { knowledgeBase: KnowledgeBase }) {
  const kbId = knowledgeBase.id;
  const toast = useToast();
  const capabilities = useSystemCapabilities();
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [caseError, setCaseError] = useState('');
  const [runError, setRunError] = useState('');
  const [createError, setCreateError] = useState('');
  const [caseLoading, setCaseLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(true);
  const [config, setConfig] = useState<RetrievalConfig>(knowledgeBase.retrievalConfig);
  const [name, setName] = useState('当前配置');
  const [editing, setEditing] = useState<Partial<EvaluationCase> | null>(null);
  const [deleting, setDeleting] = useState<EvaluationCase | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<EvaluationRunInput | null>(null);
  const [storageKey, setStorageKey] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const [candidate, setCandidate] = useState<EvaluationRun | null>(null);
  const [baseline, setBaseline] = useState<EvaluationRun | null>(null);
  const [detailsVersion, setDetailsVersion] = useState(0);
  const [detailsError, setDetailsError] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const mounted = useRef(true);
  const creatingRef = useRef(false);
  const pendingRef = useRef<EvaluationRunInput | null>(null);
  const casesRequest = useRef(0);
  const runsRequest = useRef(0);
  const focusAfterDelete = useRef<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadCases = useCallback(async () => {
    const sequence = ++casesRequest.current;
    try {
      const response = await listEvaluationCases(kbId);
      if (!mounted.current || sequence !== casesRequest.current) return;
      setCases(response.items); setCaseError('');
      setSelected((current) => current.length ? current.filter((id) => response.items.some((item) => item.id === id)) : response.items.slice(0, 20).map((item) => item.id));
    } catch (error) { if (mounted.current && sequence === casesRequest.current) setCaseError(getErrorMessage(error, '测试问题加载失败')); }
    finally { if (mounted.current && sequence === casesRequest.current) setCaseLoading(false); }
  }, [kbId]);
  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++runsRequest.current;
    try {
      const response = await listEvaluationRuns(kbId, signal);
      if (!mounted.current || signal?.aborted || sequence !== runsRequest.current) return false;
      setRuns(response.items); setRunError(''); setDetailsVersion((value) => value + 1);
      setCandidateId((current) => current || response.items[0]?.id || '');
      return true;
    } catch (error) {
      if (mounted.current && !signal?.aborted && sequence === runsRequest.current) setRunError(getErrorMessage(error, '运行记录加载失败'));
      return false;
    } finally { if (mounted.current && sequence === runsRequest.current) setRunLoading(false); }
  }, [kbId]);
  useEffect(() => { void loadCases(); void loadRuns(); }, [loadCases, loadRuns]);

  useEffect(() => {
    let active = true;
    const revision = tokenStore.getRevision();
    void currentUserStore.load(getCurrentUser).then((user) => {
      if (!active || tokenStore.getRevision() !== revision) return;
      const key = `rag.evaluation.pending:${user.id}:${kbId}`;
      setStorageKey(key);
      const saved = readPending(key);
      if (saved) { pendingRef.current = saved; setPending(saved); setName(saved.name); setConfig(saved.config); setSelected(saved.caseIds); }
    }).catch(() => { if (active) setCreateError('当前账户信息加载失败，请刷新页面后重试。'); });
    return () => { active = false; };
  }, [kbId]);

  const clearPending = useCallback(() => {
    try { sessionStorage.removeItem(storageKey); } catch { /* The persisted key is safe to reconcile again. */ }
    pendingRef.current = null; setPending(null);
  }, [storageKey]);
  useEffect(() => {
    if (!pending) return;
    const found = runs.find((run) => run.clientRequestId === pending.clientRequestId);
    if (found) { clearPending(); setCandidateId(found.id); setCreateError(''); }
  }, [pending, runs, clearPending]);

  const polling = runs.some(isEvaluationActive);
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function poll() {
      const ok = await loadRuns(controller.signal);
      if (controller.signal.aborted) return;
      failures = ok ? 0 : failures + 1;
      timer = setTimeout(() => void poll(), Math.min(30000, 2500 * 2 ** Math.min(failures, 4)));
    }
    timer = setTimeout(() => void poll(), 2500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loadRuns, polling]);

  useEffect(() => {
    const controller = new AbortController();
    setDetailsError('');
    const ids = [...new Set([candidateId, baselineId].filter(Boolean))];
    void Promise.allSettled(ids.map((id) => getEvaluationRun(kbId, id, controller.signal))).then((results) => {
      if (controller.signal.aborted) return;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (ids[index] === candidateId) setCandidate(result.value);
          if (ids[index] === baselineId) setBaseline(result.value);
        } else setDetailsError(getErrorMessage(result.reason, '评测详情加载失败'));
      });
    });
    return () => controller.abort();
  }, [baselineId, candidateId, detailsVersion, kbId]);

  useEffect(() => {
    if (focusAfterDelete.current === null) return;
    const element = document.getElementById(`evaluation-case-${focusAfterDelete.current}`);
    (element || addButton.current)?.focus(); focusAfterDelete.current = null;
  }, [cases]);

  async function startRun() {
    if (creatingRef.current || !storageKey) return;
    const request = pendingRef.current || { clientRequestId: crypto.randomUUID(), name: name.trim() || '回归评测', caseIds: selected, config: { ...config } };
    if (!request.caseIds.length || request.caseIds.length > 20) { setCreateError('每次请选择 1–20 道测试问题。'); return; }
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); } catch { setCreateError('无法保存请求编号，请启用浏览器存储后重试。'); return; }
    pendingRef.current = request; setPending(request);
    creatingRef.current = true; setCreating(true); setCreateError('');
    try {
      const run = await createEvaluationRun(kbId, request);
      if (!mounted.current) return;
      // A list fetched before the create response may not contain this run yet.
      ++runsRequest.current;
      setRunLoading(false); setRunError('');
      clearPending(); setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]); setCandidateId(run.id); setCandidate(run);
      toast.success('评测已提交，可在运行记录中查看进度');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) clearPending();
      setCreateError(getErrorMessage(error, '创建结果待确认，请刷新运行记录或使用同一请求继续确认。'));
    } finally { creatingRef.current = false; if (mounted.current) setCreating(false); }
  }

  async function removeCase() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true); setDeleteError('');
    const target = deleting;
    try {
      await deleteEvaluationCase(kbId, target.id);
      if (!mounted.current) return;
      ++casesRequest.current;
      const index = cases.findIndex((item) => item.id === target.id);
      focusAfterDelete.current = cases[index + 1]?.id || cases[index - 1]?.id || '';
      setCases((current) => current.filter((item) => item.id !== target.id)); setSelected((current) => current.filter((id) => id !== target.id)); setDeleting(null);
      void loadCases();
    } catch (error) { if (mounted.current) setDeleteError(getErrorMessage(error, '删除测试问题失败')); }
    finally { if (mounted.current) setDeleteBusy(false); }
  }

  async function cancelRun(run: EvaluationRun) {
    if (cancelBusy) return;
    setCancelBusy(true);
    try {
      const stopped = await cancelEvaluationRun(kbId, run.id);
      if (!mounted.current) return;
      setCandidate((current) => current?.id === stopped.id ? stopped : current);
      setBaseline((current) => current?.id === stopped.id ? stopped : current);
      setRuns((current) => current.map((item) => item.id === stopped.id ? stopped : item));
      setDetailsVersion((value) => value + 1);
      void loadRuns();
    } catch (error) {
      if (mounted.current) setRunError(getErrorMessage(error, '取消失败，请刷新运行状态'));
    } finally {
      if (mounted.current) setCancelBusy(false);
    }
  }
  const activeRun = candidate?.id === candidateId ? candidate : null;
  const baseRun = baselineId && baseline?.id === baselineId ? baseline : null;
  const formLocked = creating || Boolean(pending);

  return <div className="evaluation-panel">
    <section aria-label="测试问题集" className="ui-panel">
      <div className="ui-panel__head"><div><h2>测试问题</h2><span className="ui-panel__head-note">已选 {selected.length} 题 · 每次最多 20 题 · 共 {cases.length} / 200 题</span></div>
        <Button data-modal-focus-fallback disabled={formLocked} leadingIcon={<Plus aria-hidden="true" />} ref={addButton} onClick={() => setEditing({})}>新增测试问题</Button></div>
      <div className="ui-panel__body evaluation-cases">
        {caseError && <p className="ui-inline-error" role="alert">{caseError} <Button onClick={() => void loadCases()} variant="link">重试</Button></p>}
        {caseLoading ? <p>正在加载测试问题…</p> : !cases.length ? <EmptyState title="还没有测试问题" description="从差评保存问题，或手工添加常见问题与预期答案。" /> : <>
          <div className="evaluation-case-actions"><Button disabled={formLocked} onClick={() => setSelected(cases.slice(0, 20).map((item) => item.id))} variant="ghost">选择前 20 题</Button><Button disabled={formLocked} onClick={() => setSelected([])} variant="ghost">取消选择</Button></div>
          {cases.map((item) => <article className="evaluation-case" key={item.id}>
            <label><Checkbox id={`evaluation-case-${item.id}`} aria-label={`选择测试问题：${item.question}`} checked={selected.includes(item.id)} disabled={formLocked || (!selected.includes(item.id) && selected.length >= 20)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><strong>{item.question}</strong></label>
            <p>{item.requireCitation ? '要求引用' : '不要求引用'} · {item.requiredKeywords.length ? `关键词：${item.requiredKeywords.join('、')}` : '未设置关键词'}</p>
            <div><Button disabled={formLocked} variant="ghost" onClick={() => setEditing(item)}>编辑</Button><Button disabled={formLocked} variant="ghost" onClick={() => { setDeleting(item); setDeleteError(''); }}>删除</Button></div>
          </article>)}
        </>}
      </div>
    </section>

    <section aria-label="运行评测" className="ui-panel">
      <div className="ui-panel__head"><div><h2>批量重测</h2><span className="ui-panel__head-note">本次参数独立保存，知识库继续使用现有配置。</span></div></div>
      <form className="ui-panel__body ui-form" onSubmit={(event) => { event.preventDefault(); void startRun(); }}>
        <div className="evaluation-config">
          <Field label="运行名称"><Input aria-label="评测运行名称" disabled={formLocked} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="向量召回数量"><Input aria-label="评测向量召回数量" type="number" min={1} max={capabilities.retrieval.maxVectorTopN} required disabled={formLocked} value={config.vectorTopN} onChange={(event) => setConfig({ ...config, vectorTopN: Number(event.target.value) })} /></Field>
          <Field label="精排保留数量"><Input aria-label="评测精排保留数量" type="number" min={1} max={Math.min(capabilities.retrieval.maxRerankTopK, config.vectorTopN)} required disabled={formLocked} value={config.rerankTopK} onChange={(event) => setConfig({ ...config, rerankTopK: Number(event.target.value) })} /></Field>
          <Field label="最低相关度"><Input aria-label="评测最低相关度" type="number" min={0} max={1} step={0.01} required disabled={formLocked} value={config.scoreThreshold} onChange={(event) => setConfig({ ...config, scoreThreshold: Number(event.target.value) })} /></Field>
        </div>
        <label className="evaluation-checkbox"><Checkbox disabled={formLocked} checked={config.enableRerank} onChange={(event) => setConfig({ ...config, enableRerank: event.target.checked })} />使用精排</label>
        {!capabilities.rerankEnabled && config.enableRerank && <p className="ui-muted">当前环境未启用精排，本次运行会记录实际生效状态。</p>}
        <label className="evaluation-checkbox"><Checkbox disabled={formLocked} checked={config.enableKeyword ?? true} onChange={(event) => setConfig({ ...config, enableKeyword: event.target.checked })} />使用关键词召回</label>
        {!capabilities.keywordSearchEnabled && config.enableKeyword && <p className="ui-muted">当前环境未启用关键词召回（KEYWORD_SEARCH_ENABLED=false），本次运行只使用向量召回。</p>}
        {pending && !creating && <p>上次创建结果待确认。继续操作会复用原请求编号，已创建的运行会直接返回。</p>}
        {createError && <p className="ui-inline-error" role="alert">{createError}</p>}
        <div><Button disabled={!storageKey || (!selected.length && !pending)} loading={creating} type="submit" variant="primary">{pending ? '继续确认本次评测' : `批量重测（${selected.length} 题）`}</Button></div>
      </form>
    </section>

    <section aria-label="评测运行记录" className="ui-panel">
      <div className="ui-panel__head"><div><h2>运行记录与对比</h2><span className="ui-panel__head-note">保留最近 50 次运行入口；执行中的任务在后台继续。</span></div><Button leadingIcon={<RefreshCw aria-hidden="true" />} onClick={() => void loadRuns()} variant="ghost">刷新运行记录</Button></div>
      <div className="ui-panel__body ui-form">
        {runError && <p className="ui-inline-error" role="alert">{runError}</p>}
        {runLoading ? <p>正在加载运行记录…</p> : !runs.length ? <p className="ui-muted">选择测试问题，提交第一次评测后即可查看回答和来源。</p> : <>
          <div className="evaluation-run-selectors">
            <Field label="查看运行"><Select aria-label="查看评测运行" value={candidateId} onChange={(event) => { setCandidateId(event.target.value); if (event.target.value === baselineId) setBaselineId(''); }}>
              {runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {formatDateTime(run.createdAt)} · {evaluationStatusLabels[run.status]} {run.completedCount}/{run.total}</option>)}
            </Select></Field>
            <Field label="对比基准"><Select aria-label="评测对比基准" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">不对比，只看本次</option>
              {runs.filter((run) => run.id !== candidateId).map((run) => <option key={run.id} value={run.id}>{run.name} · {formatDateTime(run.createdAt)} · {evaluationStatusLabels[run.status]}</option>)}
            </Select></Field>
          </div>
          {activeRun && isEvaluationActive(activeRun) && <div className="evaluation-running"><span role="status">{evaluationStatusLabels[activeRun.status]} · 已完成 {activeRun.completedCount} / {activeRun.total} 题</span>
            <Button loading={cancelBusy} variant="secondary" onClick={() => void cancelRun(activeRun)}>取消运行</Button></div>}
          {detailsError && <p className="ui-inline-error" role="alert">{detailsError} <Button variant="link" onClick={() => setDetailsVersion((value) => value + 1)}>重试详情</Button></p>}
          {activeRun && (!baselineId || baseRun) ? <EvaluationComparison run={activeRun} baseline={baseRun} /> : <p>正在加载评测详情…</p>}
        </>}
      </div>
    </section>
    {editing && <EvaluationCaseDialog initial={editing} knowledgeBaseId={kbId} onClose={() => setEditing(null)} onSaved={(item) => {
      ++casesRequest.current;
      setCaseLoading(false);
      setCases((current) => [item, ...current.filter((existing) => existing.id !== item.id)]);
      setSelected((current) => current.includes(item.id) || current.length >= 20 ? current : [...current, item.id]); toast.success('测试问题已保存');
      void loadCases();
    }} />}
    {deleting && <ConfirmDialog title="删除测试问题？" description="已保存的历史评测结果会保留。" confirmLabel="删除" busy={deleteBusy} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={() => void removeCase()} />}
  </div>;
}
