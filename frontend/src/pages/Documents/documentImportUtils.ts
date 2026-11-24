import { ApiError } from '../../api/client';
import type { UploadDocumentOptions } from '../../api/resources';
import type { DocumentDuplicateDetails, SystemCapabilities, TextDocumentInput } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatDocumentBytes } from './documentDisplay';
import type { ImportStatus } from './DocumentImportContext';

/**
 * The accept attribute is a file-picker hint only; validateDocumentFile enforces
 * the real allow list, which comes from GET /system/capabilities.
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

export function acceptAttribute(extensions: string[]): string {
  const hints = extensions.flatMap((extension) => {
    const mime = MIME_BY_EXTENSION[extension];
    return mime ? [`.${extension}`, mime] : [`.${extension}`];
  });
  return hints.join(',');
}

export function extensionSummary(extensions: string[]): string {
  return extensions.map((extension) => extension.toUpperCase()).join('、');
}

/**
 * `duplicate` is not a failure: the request was well formed and the server is
 * asking the user to choose. It is kept out of the failed count for that reason —
 * telling someone "部分文档导入失败" when they simply have a decision to make would
 * misdescribe what happened.
 */
export type ImportItem = {
  tableImport?: UploadDocumentOptions['tableImport'];
  requestId: string;
  allowDuplicate?: boolean;
  replaceId?: string;
  sourcePath?: string;
  text?: TextDocumentInput;
  error: string;
  file: File;
  key: string;
  progress: number;
  status: ImportStatus;
  /** Present only while status is `duplicate`: what the new file collides with. */
  duplicate?: DocumentDuplicateDetails;
};

export function validateDocumentFile(file: File, upload: SystemCapabilities['upload']): string {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!upload.allowedExtensions.includes(extension)) {
    return `仅支持 ${extensionSummary(upload.allowedExtensions)}。`;
  }
  if (file.size === 0) {
    return '文件不能为空。';
  }
  if (file.size > upload.maxFileBytes) {
    return `单个文件不得超过 ${formatDocumentBytes(upload.maxFileBytes)}。`;
  }
  return '';
}

export function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function updateImportItem(
  items: ImportItem[],
  key: string,
  update: Partial<ImportItem>,
): ImportItem[] {
  return items.map((item) => item.key === key ? { ...item, ...update } : item);
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function importStatusLabel(status: ImportStatus): string {
  switch (status) {
    case 'uploading': return '上传中';
    case 'succeeded': return '已上传';
    case 'failed': return '上传失败';
    case 'unconfirmed': return '结果待确认';
    case 'unavailable': return '文档已不可用';
    case 'duplicate': return '内容重复';
    default: return '待上传';
  }
}

/**
 * The 409 payload the duplicate check returns, or null for any other error. Read
 * defensively: this comes off the wire, and a partially shaped payload must fall
 * through to the generic failure path rather than render a dialog with blanks in it.
 */
export function duplicateDetails(error: unknown): DocumentDuplicateDetails | null {
  if (!(error instanceof ApiError) || error.code !== 'DOCUMENT_DUPLICATE_CONTENT') {
    return null;
  }
  const details = error.details as Partial<DocumentDuplicateDetails> | undefined;
  if (!details || typeof details.existingDocumentId !== 'string' || !details.existingDocumentId) {
    return null;
  }
  return {
    existingDocumentId: details.existingDocumentId,
    // The filename is what the user recognises the existing copy by, so a missing
    // one gets a placeholder rather than being left blank.
    existingFilename: typeof details.existingFilename === 'string' && details.existingFilename
      ? details.existingFilename
      : '已有文档',
    existingStatus: details.existingStatus ?? 'completed',
    existingUploadedAt: typeof details.existingUploadedAt === 'string' ? details.existingUploadedAt : '',
  };
}

export function documentUploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'DOCUMENT_TYPE_UNSUPPORTED') {
      const reason = error.details.reason;
      if (reason === 'legacy_doc') return '不支持旧版 .doc，请另存为 .docx';
      if (reason === 'legacy_or_encrypted') return '文件是旧版 .doc 或已加密，请另存为未加密的 .docx';
      return '格式不受支持';
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fileError = error.details.file;
      if (fileError === 'file size exceeds limit') {
        return '文件超过大小限制';
      }
      if (typeof fileError === 'string' && fileError) {
        return fileError === 'file is required' ? '文件不能为空' : '文件校验失败';
      }
    }
  }
  return getErrorMessage(error, '上传失败');
}
