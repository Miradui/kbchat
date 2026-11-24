import type { TableSource } from './common';

export type DocumentStatus =
  | 'uploaded'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'completed'
  | 'failed';

export type DocumentJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TextDocumentInput = { title: string; content: string; format: 'md' | 'txt'; allowDuplicate?: boolean; requestId?: string };

/**
 * The closed set written to `documents.error_code`. `unsupported_type` never
 * arrives from processing — upload validation rejects those with a 400 before a
 * document exists — but it is part of the column's constraint.
 *
 * Treat an unrecognised value as a generic failure rather than assuming: the set
 * can grow server-side before the client knows the new member.
 */
export type DocumentErrorCode =
  | 'pdf_limit_exceeded'
  | 'ocr_unavailable'
  | 'ocr_timeout'
  | 'ocr_failed'
  | 'ocr_limit_exceeded'
  | 'table_limit_exceeded'
  | 'table_import_invalid'
  | 'unsupported_type'
  | 'corrupt_file'
  | 'encoding_invalid'
  | 'empty_content'
  | 'embedding_failed'
  | 'storage_failed'
  | 'cancelled'
  | 'internal';

export type PdfTextSummary = {
  ocr?: {
    status: 'disabled' | 'running' | 'completed' | 'unavailable' | 'timeout' | 'failed' | 'limit_exceeded';
    pages: number[];
    completedPages: number;
    totalPages: number;
  };
  totalPages: number;
  textPages: number;
  pagesWithoutText: number[];
};

export type TableImportOptions = { sheets: Array<{ name: string; headerRow: number; columns?: number[] }> };
export type TableImportPreview = { sheets: Array<{ name: string; suggestedHeaderRow: number; columnCount: number; lastRow: number; rows: Array<{ rowStart: number; rowEnd: number; values: string[] }>; truncated: boolean }> };

export type DocumentItem = {
  tableImport?: TableImportOptions;
  sourcePath?: string;
  id: string;
  knowledgeBaseId: string;
  filename: string;
  fileType: string;
  fileSize: number;
  status: DocumentStatus;
  errorMessage: string | null;
  /**
   * Absent on documents that have not failed, and on failures recorded before
   * migration 019. `errorMessage` stays the human sentence; this is what selects
   * the specific advice to show.
   */
  errorCode?: DocumentErrorCode | string;
  /**
   * Set when this document has been replaced by a newer revision, which makes it
   * history rather than a live document. Null on every current document.
   */
  supersededById?: string | null;
  supersededAt?: string | null;
  /**
   * Whether the document is old enough to be worth re-checking. Advisory only —
   * a stale document is still retrieved and still cited.
   */
  isStale?: boolean;
  /** The configured threshold in days; 0 means staleness reporting is off. */
  staleAfterDays?: number;
  jobStatus?: DocumentJobStatus;
  progress?: number;
  stage?: DocumentStatus;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: string | null;
  /** Detail response only; absent/null means page extraction has not been recorded. */
  pdfTextSummary?: PdfTextSummary | null;
  createdAt: string;
  updatedAt?: string;
};

/** Details on a 409 DOCUMENT_DUPLICATE_CONTENT, enough to describe the conflict. */
export type DocumentDuplicateDetails = {
  existingDocumentId: string;
  existingFilename: string;
  existingStatus: DocumentStatus;
  existingUploadedAt: string;
};

/**
 * GET /knowledge-bases/:id/documents is the knowledge-base-scoped view of
 * GET /documents and returns the same paginated shape. See docs/04-api-design.md (GET /knowledge-bases/:kbId/documents).
 */
export type DocumentListResponse = GlobalDocumentListResponse;

export type GlobalDocumentItem = DocumentItem & {
  knowledgeBaseName: string;
};

/**
 * Rename and/or move. The extension must stay the same — `fileType` is derived
 * from it at upload and picks the parser used on the next reprocess.
 */
export type DocumentUpdateInput = {
  filename?: string;
  knowledgeBaseId?: string;
};

export type DocumentChunk = {
  id: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber?: number | null;
  metadata: Record<string, unknown>;
};

export type DocumentChunkListResponse = {
  items: DocumentChunk[];
  total: number;
  page: number;
  pageSize: number;
};

export type DocumentChunkListParams = {
  page?: number;
  pageSize?: number;
  q?: string;
  chunkId?: string;
};

export type DocumentPreviewResponse = {
  tableRows?: Array<TableSource & { startOffset: number; endOffset: number }>;
  id: string;
  filename: string;
  fileType: string;
  contentType: string;
  kind: 'text' | 'file';
  content?: string;
  downloadUrl: string;
};

export type DocumentSort = 'updatedAt_desc' | 'createdAt_desc' | 'filename_asc';

/** A list-query alias; documents themselves keep their concrete processing stage. */
export type DocumentStatusFilter = DocumentStatus | 'processing' | '';

export type GlobalDocumentListParams = {
  q?: string;
  knowledgeBaseId?: string;
  status?: DocumentStatusFilter;
  fileType?: string;
  sort?: DocumentSort;
  page?: number;
  pageSize?: number;
};

export type GlobalDocumentListResponse = {
  items: GlobalDocumentItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type DocumentCountsParams = Pick<GlobalDocumentListParams, 'q' | 'knowledgeBaseId' | 'fileType'>;

export type DocumentCountsResponse = {
  total: number;
  completed: number;
  processing: number;
  failed: number;
};

export type DocumentVersionStatus = {
  documentId: string;
  state: 'current' | 'newer_available' | 'unavailable';
  newerPending: boolean;
  current: { id: string; knowledgeBaseId: string; filename: string } | null;
};

export type DocumentVersion = { id: string; filename: string; status: string; createdAt: string; supersededById: string | null };
export type DocumentDiffLine = { kind: 'equal' | 'add' | 'remove'; content: string; baseLine: number | null; headLine: number | null };
export type DocumentCompareResponse = { base: DocumentVersion; head: DocumentVersion; addedLines: number; removedLines: number; lines: DocumentDiffLine[] };
