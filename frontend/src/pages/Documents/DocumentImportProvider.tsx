import { ArrowRight, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { getDocument, replaceDocument, uploadDocument, uploadGlobalDocument } from '../../api/resources';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { tokenStore } from '../../store/tokenStore';
import type { DocumentItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatBytes } from '../../utils/format';
import { DocumentImportContext, type ImportOptions, type ImportSnapshot, type ImportStatus } from './DocumentImportContext';
import { DocumentImportDialog } from './DocumentImportDialog';
import { DocumentProgress } from './DocumentProgress';
import { documentDisplayStatusLabel, documentDisplayStatusTone } from './documentDisplay';
import { documentFailureCopy } from './documentFailure';

type ProcessingTask = {
  document: DocumentItem;
  knowledgeBaseName: string;
  error: string;
  paused: boolean;
  failures: number;
  nextCheckAt: number;
};

function isProcessing(document: DocumentItem) {
  if (document.jobStatus === 'cancelled' || document.status === 'completed') return false;
  return document.status !== 'failed' || document.jobStatus === 'pending' || document.jobStatus === 'running';
}

/** One session-scoped owner, mounted above the Outlet so route changes cannot abort uploads. */
export function DocumentImportProvider({ children }: { children: ReactNode }) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision, tokenStore.getRevision);
  // An auth change disposes Files, in-flight transfers, polling and task history together.
  return <DocumentImportSession key={revision}>{children}</DocumentImportSession>;
}

function DocumentImportSession({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<(ImportOptions & { batchId: number }) | null>(null);
  const [visible, setVisible] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ImportSnapshot | null>(null);
  const [tasks, setTasks] = useState<ProcessingTask[]>([]);
  const [changeVersion, setChangeVersion] = useState(0);
  const [lastBatch, setLastBatch] = useState<{ documents: DocumentItem[] } | null>(null);
  const tasksRef = useRef(tasks);
  const snapshotRef = useRef(snapshot);
  const batchCounter = useRef(0);
  tasksRef.current = tasks;
  snapshotRef.current = snapshot;

  const openImport = useCallback((next: ImportOptions) => {
    if (!tokenStore.getToken()) return;
    if (!options || !snapshotRef.current?.items.length) {
      setOptions({ ...next, batchId: ++batchCounter.current });
      setSnapshot(null);
    }
    setTasksOpen(false);
    setVisible(true);
  }, [options]);

  const closeImport = useCallback(() => {
    setVisible(false);
    setOptions(null);
    setSnapshot(null);
  }, []);

  const onUploaded = useCallback((document: DocumentItem) => {
    const knowledgeBaseName = options?.knowledgeBases.find((kb) => kb.id === document.knowledgeBaseId)?.name
      || options?.fixedKnowledgeBaseName || '目标知识库';
    setTasks((current) => [
      ...current.filter((task) => task.document.id !== document.id),
      { document, knowledgeBaseName, error: '', paused: false, failures: 0, nextCheckAt: 0 },
    ]);
  }, [options]);

  const onBatchComplete = useCallback((documents: DocumentItem[]) => {
    setLastBatch({ documents });
    setChangeVersion((value) => value + 1);
  }, []);

  const hasPolling = tasks.some((task) => isProcessing(task.document) && !task.paused);
  useEffect(() => {
    if (!hasPolling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    const controller = new AbortController();

    async function poll() {
      const eligible = tasksRef.current.filter((task) => isProcessing(task.document) && !task.paused && task.nextCheckAt <= Date.now());
      // Rotate through large batches with at most three concurrent status reads.
      const batch = eligible.length ? Array.from({ length: Math.min(3, eligible.length) }, (_, index) => eligible[(cursor + index) % eligible.length]) : [];
      cursor = eligible.length ? (cursor + batch.length) % eligible.length : 0;
      const results = await Promise.allSettled(batch.map((task) => getDocument(task.document.id, controller.signal)));
      if (!active) return;
      const updates = new Map<string, ProcessingTask>();
      let terminalChange = false;
      results.forEach((result, index) => {
        const task = batch[index];
        if (result.status === 'fulfilled') {
          const document = result.value;
          if (document.knowledgeBaseId !== task.document.knowledgeBaseId) {
            updates.set(task.document.id, { ...task, error: '文档已移动，请在文档页确认当前位置。', paused: true });
          } else {
            terminalChange ||= !isProcessing(document);
            updates.set(document.id, { ...task, document, error: '', failures: 0, nextCheckAt: 0 });
          }
        } else {
          const unavailable = result.reason instanceof ApiError && [403, 404].includes(result.reason.status);
          const failures = task.failures + 1;
          updates.set(task.document.id, { ...task, error: getErrorMessage(result.reason, '处理状态更新失败，稍后自动重试。'), paused: unavailable, failures, nextCheckAt: Date.now() + Math.min(30_000, 3_000 * 2 ** Math.min(failures, 4)) });
        }
      });
      if (updates.size) setTasks((current) => current.map((task) => updates.get(task.document.id) ?? task));
      if (terminalChange) setChangeVersion((value) => value + 1);
      timer = setTimeout(() => void poll(), 2500);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [hasPolling]);

  const localItems = snapshot?.items.filter((item) => item.status !== 'succeeded') ?? [];
  const busyCount = localItems.filter((item) => item.status === 'pending' || item.status === 'uploading').length + tasks.filter((task) => isProcessing(task.document) && !task.paused).length;
  const attentionCount = localItems.filter((item) => ['failed', 'unconfirmed', 'duplicate', 'unavailable'].includes(item.status)).length + tasks.filter((task) => task.error || (task.document.status === 'failed' && task.document.jobStatus !== 'cancelled')).length;
  const taskCount = localItems.length + tasks.length;
  const hasTasks = Boolean(options) || tasks.length > 0;
  const openTasks = useCallback(() => { setVisible(false); setTasksOpen(true); }, []);
  const value = useMemo(() => ({ openImport, openTasks, hasTasks, busyCount, attentionCount, taskCount, changeVersion, lastBatch }), [openImport, openTasks, hasTasks, busyCount, attentionCount, taskCount, changeVersion, lastBatch]);

  return (
    <DocumentImportContext.Provider value={value}>
      {children}
      {options && <DocumentImportDialog
        {...options}
        key={options.batchId}
        minimized={!visible}
        onBatchComplete={onBatchComplete}
        onClose={closeImport}
        onMinimize={() => setVisible(false)}
        onReplace={replaceDocument}
        onStateChange={setSnapshot}
        onUpload={options.fixedKnowledgeBaseId ? uploadDocument : uploadGlobalDocument}
        onUploaded={onUploaded}
        open
      />}
      <Drawer onClose={() => setTasksOpen(false)} open={tasksOpen} title="上传任务" wide>
        <div className="upload-tasks">
          <div className="upload-tasks__summary">
            <strong>{busyCount ? `${busyCount} 项进行中` : attentionCount ? `${attentionCount} 项需要处理` : !taskCount && options ? '等待选择文件' : '当前任务已结束'}</strong>
            <p>切换页面后上传会继续。文件传输完成后，将继续跟踪解析、切片和向量化。</p>
          </div>
          {options && (
            <section aria-label="当前导入" className="upload-tasks__group">
              <header><h3>{snapshot?.knowledgeBaseName || '当前导入'}</h3><Button onClick={() => { setTasksOpen(false); setVisible(true); }} variant="secondary">{snapshot?.uploading ? '查看上传清单' : '继续导入'}</Button></header>
              {localItems.length ? localItems.map((item) => (
                <article aria-label={item.name} className="upload-tasks__item" key={item.key}>
                  <div className="upload-tasks__item-title"><strong>{item.name}</strong><Badge tone={['failed', 'unconfirmed'].includes(item.status) ? 'warn' : 'neutral'}>{transferLabels[item.status]}</Badge></div>
                  <small>{formatBytes(item.size)}</small>
                  {item.status === 'uploading' && <div aria-label={`${item.name} 上传进度`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={item.progress} className="ui-progress" role="progressbar"><span className="ui-progress__fill" style={{ width: `${item.progress}%` }} /></div>}
                  {item.status === 'uploading' && <small>{item.progress}% · {item.progress === 100 ? '文件已传输，等待服务器确认' : '正在传输文件'}</small>}
                  {item.error && <p>{item.error}</p>}
                  {item.status === 'duplicate' && <p>已有相同内容，请返回导入清单选择替换或保留两份。</p>}
                </article>
              )) : <p className="ui-muted">可返回导入清单选择文件。</p>}
              <p className="upload-tasks__note">刷新或关闭浏览器会中断尚未完成的本地文件传输。</p>
              {snapshot?.knowledgeBaseId && <Link className="ui-button ui-button--link" onClick={() => setTasksOpen(false)} to={`/knowledge-bases/${encodeURIComponent(snapshot.knowledgeBaseId)}/documents`}>查看目标知识库文档 <ArrowRight aria-hidden="true" /></Link>}
            </section>
          )}
          {tasks.length > 0 && <section aria-label="文档处理任务" className="upload-tasks__group">
            <header><h3>文档处理</h3><Button disabled={!tasks.some((task) => !isProcessing(task.document))} onClick={() => setTasks((current) => current.filter((task) => isProcessing(task.document)))} variant="ghost">清除已结束记录</Button></header>
            {tasks.map((task) => {
              const document = task.document;
              const failed = document.status === 'failed' && document.jobStatus !== 'cancelled';
              return <article aria-label={document.filename} className="upload-tasks__item" key={document.id}>
                <div className="upload-tasks__item-title"><strong>{document.filename}</strong><Badge tone={documentDisplayStatusTone(document.status, document.jobStatus)}>{documentDisplayStatusLabel(document.status, document.jobStatus)}</Badge></div>
                <small>{task.knowledgeBaseName} · 已上传</small>
                {typeof document.progress === 'number' && <DocumentProgress document={document} />}
                {failed && <p>{documentFailureCopy(document).reason}</p>}
                {task.error && <p className="ui-inline-error">{task.error}</p>}
                <div className="upload-tasks__actions">
                  {task.error && <Button leadingIcon={<RotateCw aria-hidden="true" />} onClick={() => setTasks((current) => current.map((item) => item.document.id === document.id ? { ...item, paused: false, error: '', failures: 0, nextCheckAt: 0 } : item))} variant="ghost">重试状态查询</Button>}
                  <Link className="ui-button ui-button--link" onClick={() => setTasksOpen(false)} to={`/documents?documentId=${encodeURIComponent(document.id)}`}>{failed ? '查看失败原因' : '查看文档'}</Link>
                  {document.status === 'completed' && <Link className="ui-button ui-button--link" onClick={() => setTasksOpen(false)} to={`/chat?knowledgeBaseId=${encodeURIComponent(document.knowledgeBaseId)}`}>开始提问 <ArrowRight aria-hidden="true" /></Link>}
                </div>
              </article>;
            })}
          </section>}
          {!options && tasks.length === 0 && <p className="ui-muted">暂无上传任务，可从文档页开始导入。</p>}
        </div>
      </Drawer>
    </DocumentImportContext.Provider>
  );
}

const transferLabels: Record<ImportStatus, string> = { pending: '待上传', uploading: '上传中', succeeded: '已上传', failed: '上传失败', unconfirmed: '结果待确认', duplicate: '内容重复', unavailable: '文档已不可用' };
