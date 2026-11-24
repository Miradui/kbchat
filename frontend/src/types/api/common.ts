export type APIError = {
  traceId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type UserSummary = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
};

export type BatchResultResponse = {
  processedCount: number;
};

export type RecycleBinItem = {
  resourceType: 'knowledgeBase' | 'document' | 'chatSession';
  id: string;
  name: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  deletedAt: string;
};

export type RecycleBinListResponse = {
  items: RecycleBinItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type PersonalListParams = { q?: string; page?: number; pageSize?: number };

export type TableSource = { sheetName: string; rowStart: number; rowEnd: number; headerRow: number };
