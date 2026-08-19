import type { BadgeTone } from '../../components/ui/Badge';
import type { DocumentJobStatus, DocumentStatus } from '../../types/api';

export const documentStatuses: DocumentStatus[] = [
  'uploaded',
  'parsing',
  'chunking',
  'embedding',
  'completed',
  'failed',
];

const statusLabels: Record<DocumentStatus, string> = {
  uploaded: '已上传',
  parsing: '解析中',
  chunking: '切分中',
  embedding: '向量化',
  completed: '已完成',
  failed: '失败',
};

export function documentStatusClass(status: DocumentStatus): string {
  return isTerminalDocumentStatus(status) ? status : 'processing';
}

export function documentStatusLabel(status: DocumentStatus): string {
  return statusLabels[status];
}

export function documentDisplayStatusLabel(status: DocumentStatus, jobStatus?: DocumentJobStatus): string {
  return jobStatus === 'cancelled' ? '已取消' : documentStatusLabel(status);
}

export function documentStatusTone(status: DocumentStatus): BadgeTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  return 'warn';
}

export function documentDisplayStatusTone(status: DocumentStatus, jobStatus?: DocumentJobStatus): BadgeTone {
  return jobStatus === 'cancelled' ? 'neutral' : documentStatusTone(status);
}

export function isTerminalDocumentStatus(status: DocumentStatus): boolean {
  return status === 'completed' || status === 'failed';
}

export { formatBytes as formatDocumentBytes, formatDateTime as formatDocumentDateTime } from '../../utils/format';
