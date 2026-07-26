import type { DocumentItem, DocumentJobStatus, DocumentStatus } from '../../types/api';

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
};

type DocumentProgressProps = {
  compact?: boolean;
  document: DocumentItem;
};

export function DocumentProgress({ compact = false, document }: DocumentProgressProps) {
  const stage = document.stage ?? document.status;
  const progress = document.progress ?? progressForStage(stage);
  const retryCount = document.retryCount ?? 0;
  const maxRetries = document.maxRetries ?? 0;
  return (
    <section
      aria-label={`${document.filename} 处理进度`}
      className={compact ? 'document-progress is-compact' : 'document-progress'}
    >
      <header>
        <strong>{stageLabels[stage]}</strong>
        <span>{progress}%</span>
      </header>
      <progress aria-label="处理进度" max={100} value={progress} />
      <div className="document-progress-meta">
        <span>任务 {jobStatusLabels[document.jobStatus ?? inferredJobStatus(stage)]}</span>
        {maxRetries > 0 && <span>重试 {retryCount} / {maxRetries}</span>}
        {document.nextRetryAt && <span>下次重试 {formatDateTime(document.nextRetryAt)}</span>}
      </div>
    </section>
  );
}

function progressForStage(stage: DocumentStatus): number {
  switch (stage) {
    case 'parsing': return 25;
    case 'chunking': return 50;
    case 'embedding': return 75;
    case 'completed': return 100;
    case 'failed': return 0;
    default: return 0;
  }
}

function inferredJobStatus(stage: DocumentStatus): DocumentJobStatus {
  if (stage === 'completed' || stage === 'failed') {
    return stage;
  }
  return stage === 'uploaded' ? 'pending' : 'running';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
