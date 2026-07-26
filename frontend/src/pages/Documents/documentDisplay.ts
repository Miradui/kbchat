import type { DocumentStatus } from '../../types/api';

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

export function isTerminalDocumentStatus(status: DocumentStatus): boolean {
  return status === 'completed' || status === 'failed';
}

export function formatDocumentBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDocumentDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
