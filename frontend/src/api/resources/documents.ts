import { invalidateDocumentQueriesAfter } from '../../store/queryClient';
import type {
  BatchResultResponse,
  DocumentChunkListParams,
  DocumentChunkListResponse,
  DocumentCompareResponse,
  DocumentCountsParams,
  DocumentCountsResponse,
  DocumentItem,
  DocumentListResponse,
  DocumentPreviewResponse,
  DocumentUpdateInput,
  DocumentVersion,
  DocumentVersionStatus,
  GlobalDocumentListParams,
  GlobalDocumentListResponse,
  RecycleBinListResponse,
  TableImportOptions,
  TableImportPreview,
  TextDocumentInput,
} from '../../types/api';
import { apiBlobRequest, apiRequest, apiUploadRequest } from '../client';
import { withQuery } from './helpers';

/**
 * Knowledge-base-scoped document list. Same query surface as
 * {@link listGlobalDocuments}; knowledgeBaseId comes from the path.
 */
export function listDocuments(
  knowledgeBaseId: string,
  params: Omit<GlobalDocumentListParams, 'knowledgeBaseId'> = {},
): Promise<DocumentListResponse> {
  return apiRequest<DocumentListResponse>(
    withQuery(`/knowledge-bases/${knowledgeBaseId}/documents`, params),
  );
}

export function listGlobalDocuments(
  params: GlobalDocumentListParams = {},
  signal?: AbortSignal,
): Promise<GlobalDocumentListResponse> {
  return apiRequest<GlobalDocumentListResponse>(withQuery('/documents', params), { signal });
}

export function getDocumentCounts(params: DocumentCountsParams = {}, signal?: AbortSignal): Promise<DocumentCountsResponse> {
  return apiRequest<DocumentCountsResponse>(withQuery('/documents/counts', params), { signal });
}

export function getDocument(id: string, signal?: AbortSignal): Promise<DocumentItem> {
  return apiRequest<DocumentItem>(`/documents/${id}`, { signal });
}

export function createTextDocument(knowledgeBaseId: string, input: TextDocumentInput, signal?: AbortSignal): Promise<DocumentItem> {
  return invalidateDocumentQueriesAfter(apiRequest<DocumentItem>(`/knowledge-bases/${knowledgeBaseId}/documents/text`, { method: 'POST', body: input, signal }));
}

export function getDocumentPreview(id: string): Promise<DocumentPreviewResponse> {
  return apiRequest<DocumentPreviewResponse>(`/documents/${id}/preview`);
}

export function getEditableDocumentText(id: string, signal?: AbortSignal) {
  return apiRequest<{ documentId: string; filename: string; content: string; maxBytes: number }>(`/documents/${id}/editable-text`, { signal });
}

export function saveDocumentTextRevision(id: string, input: { requestId: string; content: string }) {
  return invalidateDocumentQueriesAfter(apiRequest<DocumentItem>(`/documents/${id}/text-revisions`, { method: 'POST', body: input }));
}

export function downloadDocument(id: string): Promise<Blob> {
  return apiBlobRequest(`/documents/${id}/download`);
}

export function listDocumentChunks(
  id: string,
  params: DocumentChunkListParams = {},
): Promise<DocumentChunkListResponse> {
  return apiRequest<DocumentChunkListResponse>(
    withQuery(`/documents/${id}/chunks`, params),
  );
}

/**
 * Carried in the multipart body rather than the query string because the file and
 * the decision about it belong to the same request — a query parameter would let
 * the two disagree. Omitting it means the default: a duplicate is rejected with a
 * 409 so the user can choose.
 */
export type UploadDocumentOptions = {
  tableImport?: TableImportOptions;
  requestId?: string;
  allowDuplicate?: boolean;
  sourcePath?: string;
};

/**
 * The field is only sent when the override is on. The server reads anything other
 * than "true" as the default, so sending "false" would be equivalent, but omitting
 * it keeps a normal upload's body identical to what it was before this existed.
 */
function appendUploadOptions(body: FormData, options: UploadDocumentOptions): void {
  if (options.tableImport) body.append('tableImport', JSON.stringify(options.tableImport));
  if (options.requestId) body.append('requestId', options.requestId);
  if (options.sourcePath) body.append('sourcePath', options.sourcePath);
  if (options.allowDuplicate) {
    body.append('allowDuplicate', 'true');
  }
}

export function uploadDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  options: UploadDocumentOptions = {},
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('file', file);
  appendUploadOptions(body, options);

  return invalidateDocumentQueriesAfter(apiUploadRequest<DocumentItem>(`/knowledge-bases/${knowledgeBaseId}/documents`, body, {
    onProgress,
    signal,
  }));
}

export function uploadGlobalDocument(
  knowledgeBaseId: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  options: UploadDocumentOptions = {},
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('knowledgeBaseId', knowledgeBaseId);
  body.append('file', file);
  appendUploadOptions(body, options);

  return invalidateDocumentQueriesAfter(apiUploadRequest<DocumentItem>('/documents', body, { onProgress, signal }));
}

export function inspectTableImport(knowledgeBaseId: string, file: File, signal?: AbortSignal): Promise<TableImportPreview> {
  const body = new FormData(); body.append('file', file);
  return apiUploadRequest(`/knowledge-bases/${knowledgeBaseId}/document-import-preview`, body, { signal });
}

export type DocumentUploadResult = { status: 'committed'; document: DocumentItem } | { status: 'notFound' | 'unavailable'; document?: never };

export function getDocumentUploadResult(knowledgeBaseId: string, requestId: string, signal?: AbortSignal): Promise<DocumentUploadResult> {
  return apiRequest(`/knowledge-bases/${knowledgeBaseId}/document-uploads/${requestId}`, { signal });
}

/**
 * Replace a document with a new revision. The response is the *new* document: the
 * old one is kept and marked superseded rather than overwritten, so its chunks stay
 * answerable until the replacement finishes processing and the citation trail from
 * older answers does not break.
 *
 * Duplicate detection does not apply here — re-uploading the same content as a
 * deliberate replacement is not a conflict.
 */
export function replaceDocument(
  id: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  options: UploadDocumentOptions = {},
): Promise<DocumentItem> {
  const body = new FormData();
  body.append('file', file);

  appendUploadOptions(body, options);

  return invalidateDocumentQueriesAfter(apiUploadRequest<DocumentItem>(`/documents/${id}/replace`, body, {
    onProgress,
    signal,
  }));
}

export function deleteDocument(id: string): Promise<void> {
  return invalidateDocumentQueriesAfter(apiRequest<void>(`/documents/${id}`, {
    method: 'DELETE',
  }));
}

export function reprocessDocument(id: string): Promise<DocumentItem> {
  return invalidateDocumentQueriesAfter(apiRequest<DocumentItem>(`/documents/${id}/reprocess`, {
    method: 'POST',
  }));
}

/**
 * Rename and/or move a document. A move carries the document's chunks with it,
 * and is rejected with `DOCUMENT_JOB_ACTIVE` while a job is queued or running.
 */
export function updateDocument(id: string, input: DocumentUpdateInput): Promise<DocumentItem> {
  return invalidateDocumentQueriesAfter(apiRequest<DocumentItem>(`/documents/${id}`, {
    method: 'PUT',
    body: input,
  }));
}

/**
 * Cancel a queued or running processing job. Returns `DOCUMENT_JOB_NOT_CANCELLABLE`
 * when the document has no active job.
 */
export function cancelDocumentJob(id: string): Promise<DocumentItem> {
  return invalidateDocumentQueriesAfter(apiRequest<DocumentItem>(`/documents/${id}/cancel`, {
    method: 'POST',
  }));
}

export function restoreDocument(id: string): Promise<void> {
  return invalidateDocumentQueriesAfter(apiRequest<void>(`/documents/${id}/restore`, {
    method: 'POST',
  }));
}

export function batchDeleteDocuments(ids: string[]): Promise<BatchResultResponse> {
  return invalidateDocumentQueriesAfter(apiRequest<BatchResultResponse>('/documents/batch-delete', {
    method: 'POST',
    body: { documentIds: ids },
  }));
}

export function batchRestoreDocuments(ids: string[]): Promise<BatchResultResponse> {
  return invalidateDocumentQueriesAfter(apiRequest<BatchResultResponse>('/documents/batch-restore', {
    method: 'POST',
    body: { documentIds: ids },
  }));
}

export function batchReprocessDocuments(ids: string[]): Promise<BatchResultResponse> {
  return invalidateDocumentQueriesAfter(apiRequest<BatchResultResponse>('/documents/batch-reprocess', {
    method: 'POST',
    body: { documentIds: ids },
  }));
}

export function listDocumentRecycleBin(page = 1, pageSize = 20): Promise<RecycleBinListResponse> {
  return apiRequest<RecycleBinListResponse>(withQuery('/documents/recycle-bin', { page, pageSize }));
}

export function deleteDocumentPermanently(id: string): Promise<void> {
  return apiRequest<void>(`/documents/recycle-bin/${id}`, {
    method: 'DELETE',
  });
}

export function emptyDocumentRecycleBin(): Promise<void> {
  return apiRequest<void>('/documents/recycle-bin/empty', {
    method: 'POST',
  });
}

export function listDocumentVersions(id: string, signal?: AbortSignal) {
  return apiRequest<{ items: DocumentVersion[] }>(`/documents/${id}/versions`, { signal });
}

export function getDocumentVersionStatus(documentIds: string[], signal?: AbortSignal) {
  return apiRequest<{ items: DocumentVersionStatus[] }>('/documents/version-status', { method: 'POST', body: { documentIds }, signal });
}

export type PDFCorrectionPage = { pageNumber: number; content: string; textSource?: 'ocr' | 'ocr_corrected' };
export type PDFCorrection = { documentId: string; revision: string; pages: PDFCorrectionPage[] };

export function getPDFCorrection(id: string, signal?: AbortSignal) {
  return apiRequest<PDFCorrection>(`/documents/${id}/ocr-correction`, { signal });
}

export function savePDFCorrection(id: string, input: { requestId: string; revision: string; pages: PDFCorrectionPage[] }) {
  return apiRequest<DocumentItem>(`/documents/${id}/ocr-corrections`, { method: 'POST', body: input });
}

export function compareDocumentVersions(headId: string, baseId: string, signal?: AbortSignal) {
  return apiRequest<DocumentCompareResponse>(withQuery(`/documents/${headId}/compare`, { baseId }), { signal });
}
