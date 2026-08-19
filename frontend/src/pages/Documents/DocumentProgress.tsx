import type { DocumentItem, DocumentJobStatus, DocumentStatus } from '../../types/api';
import { formatDateTime } from '../../utils/format';

const stageLabels: Record<DocumentStatus, string> = {
  uploaded: '等待处理',
  parsing: '解析中',
  chunking: '切分中',
  embedding: '向量化中',
  completed: '已完成',
  failed: '处理失败',
};

const jobStatusLabels: Record<DocumentJobStatus, string> = {
  pending: '等待处理',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  // A cancelled job also leaves the document on `failed`; only the job status
  // tells the two apart. See docs/14-frontend-api-gaps.md G8.
  cancelled: '已取消',
};

type DocumentProgressProps = {
  compact?: boolean;
  document: DocumentItem;
};

/**
 * `failed` is deliberately not rendered as 100%: it is a distinct terminal state,
 * and an older backend without progress fields reports it as 0.
 */
export function DocumentProgress({ compact = false, document }: DocumentProgressProps) {
  const stage = document.stage ?? document.status;
  const progress = document.progress ?? progressForStage(stage);
  const retryCount = document.retryCount ?? 0;
  const maxRetries = document.maxRetries ?? 0;
  const cancelled = document.jobStatus === 'cancelled';
  const tone = cancelled ? '' : stage === 'failed' ? 'danger' : stage === 'completed' ? '' : 'warn';

  if (compact) {
    return (
      <div aria-label={`${document.filename} 处理进度`} className="doc-progress doc-progress--compact">
        <ProgressBar label="处理进度" progress={progress} tone={tone} />
        <span className="doc-progress__pct ui-num">{progress}%</span>
      </div>
    );
  }

  return (
    <section aria-label={`${document.filename} 处理进度`} className="doc-progress">
      <header>
        <strong>{cancelled ? '已取消' : stageLabels[stage]}</strong>
        <span className="ui-num">{progress}%</span>
      </header>
      <ProgressBar label="处理进度" progress={progress} tone={tone} />
      <div className="doc-progress__meta">
        <span>任务 {jobStatusLabels[document.jobStatus ?? inferredJobStatus(stage)]}</span>
        {maxRetries > 0 && <span>重试 {retryCount} / {maxRetries}</span>}
        {document.nextRetryAt && <span>下次重试 {formatDateTime(document.nextRetryAt)}</span>}
      </div>
    </section>
  );
}

/** Keeps the native progressbar semantics that a styled `div` would otherwise drop. */
function ProgressBar({ label, progress, tone }: { label: string; progress: number; tone: string }) {
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={progress}
      className="ui-progress"
      role="progressbar"
    >
      <span
        className={tone ? `ui-progress__fill ui-progress__fill--${tone}` : 'ui-progress__fill'}
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

function progressForStage(stage: DocumentStatus): number {
  switch (stage) {
    case 'parsing': return 25;
    case 'chunking': return 50;
    case 'embedding': return 75;
    case 'completed': return 100;
    default: return 0;
  }
}

function inferredJobStatus(stage: DocumentStatus): DocumentJobStatus {
  if (stage === 'completed' || stage === 'failed') return stage;
  return stage === 'uploaded' ? 'pending' : 'running';
}
