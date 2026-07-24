export type APIError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type User = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  role?: string;
};

export type LoginResponse = {
  token: string;
  user: User;
};

export type RetrievalConfig = {
  vectorTopN: number;
  rerankTopK: number;
  scoreThreshold: number;
  enableRerank: boolean;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  categoryId?: string | null;
  visibility?: 'private' | 'public';
  retrievalConfig: RetrievalConfig;
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
  viewCount?: number;
  questionCount?: number;
  isFavorite?: boolean;
  lastViewedAt?: string | null;
  updatedBy?: UserSummary;
  tags?: KnowledgeBaseTag[];
};

export type KnowledgeBaseListResponse = {
  items: KnowledgeBase[];
  total?: number;
  page?: number;
  pageSize?: number;
};

export type KnowledgeBaseInput = {
  name: string;
  description: string;
  categoryId?: string | null;
  visibility?: 'private' | 'public';
  retrievalConfig?: RetrievalConfig;
  tagIds?: string[];
};

export type UserSummary = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
};

export type KnowledgeBaseScope = 'all' | 'created' | 'managed' | 'favorite' | 'recent';

export type KnowledgeBaseSort = 'updatedAt_desc' | 'createdAt_desc' | 'name_asc';

export type WorkspaceViewMode = 'table' | 'card';

export type WorkspaceVisibility = 'all' | 'private' | 'public';

export type KnowledgeBaseListParams = {
  q?: string;
  categoryId?: string | null;
  tagIds?: string[];
  visibility?: WorkspaceVisibility;
  scope?: KnowledgeBaseScope;
  sort?: KnowledgeBaseSort;
  page?: number;
  pageSize?: number;
};

export type KnowledgeBaseCategory = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  children?: KnowledgeBaseCategory[];
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseCategoryListResponse = {
  items: KnowledgeBaseCategory[];
};

export type KnowledgeBaseCategoryInput = {
  name: string;
  parentId?: string | null;
  sortOrder: number;
};

export type KnowledgeBaseCategoryReorderItem = {
  id: string;
  parentId: string | null;
  sortOrder: number;
};

export type KnowledgeBaseTag = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeBaseTagInput = {
  name: string;
};

export type KnowledgeBaseTagListResponse = {
  items: KnowledgeBaseTag[];
};

export type WorkspaceMetric = {
  value: number;
  changeRatio: number | null;
};

export type KnowledgeBaseStatsResponse = {
  period: 'day' | 'month';
  knowledgeBases: WorkspaceMetric;
  documents: WorkspaceMetric;
  views: WorkspaceMetric;
  questions: WorkspaceMetric;
};

export type KnowledgeBaseWorkspacePreference = {
  viewMode: WorkspaceViewMode;
  scope: KnowledgeBaseScope;
  sort: KnowledgeBaseSort;
  visibility: WorkspaceVisibility;
  expandedCategoryIds: string[];
};

export type BatchResultResponse = {
  processedCount: number;
};

export type RecycleBinItem = {
  resourceType: 'knowledgeBase' | 'document';
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

export type PermissionMember = UserSummary & {
  role: 'owner' | 'manager' | 'member';
};

export type KnowledgeBasePermissionResponse = {
  knowledgeBaseId: string;
  visibility: 'private' | 'public';
  owner: UserSummary;
  managers: PermissionMember[];
  members: PermissionMember[];
};

export type MemberRole = 'manager' | 'member';

export type UserSearchResponse = {
  items: UserSummary[];
};

export type DocumentStatus =
  | 'uploaded'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'completed'
  | 'failed';

export type DocumentJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DocumentItem = {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  fileType: string;
  fileSize: number;
  status: DocumentStatus;
  errorMessage: string | null;
  jobStatus?: DocumentJobStatus;
  progress?: number;
  stage?: DocumentStatus;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type DocumentListResponse = {
  items: DocumentItem[];
};

export type GlobalDocumentItem = DocumentItem & {
  knowledgeBaseName: string;
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
};

export type DocumentPreviewResponse = {
  id: string;
  filename: string;
  fileType: string;
  contentType: string;
  kind: 'text' | 'file';
  content?: string;
  downloadUrl: string;
};

export type DocumentSort = 'updatedAt_desc' | 'createdAt_desc' | 'filename_asc';

export type GlobalDocumentListParams = {
  q?: string;
  knowledgeBaseId?: string;
  status?: DocumentStatus | '';
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

export type GlobalSearchResultType = 'knowledgeBase' | 'document' | 'chunk';

export type GlobalSearchResult = {
  type: GlobalSearchResultType;
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId?: string;
  filename?: string;
  title: string;
  snippet: string;
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
};

export type KnowledgeBaseSearchRequest = {
  query: string;
  vectorTopN?: number;
  rerankTopK?: number;
  enableRerank?: boolean;
  debug?: boolean;
};

export type KnowledgeBaseSearchResult = {
  chunkId: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  vectorScore: number;
  rerankScore?: number | null;
};

export type KnowledgeBaseRerankFallback = {
  used: boolean;
  reason?: string;
};

export type KnowledgeBaseSearchResponse = {
  items: KnowledgeBaseSearchResult[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
  debug?: KnowledgeBaseSearchDebug;
};

export type KnowledgeBaseSearchDebug = {
  query: string;
  rewrittenQuery?: string;
  vectorStage: {
    status: string;
    items: Array<KnowledgeBaseSearchResult & { rank: number }>;
  };
  rerankStage: {
    status: 'completed' | 'disabled' | 'fallback';
    input: Array<{ chunkId: string; pageNumber: number | null; rank: number }>;
    output: Array<{ chunkId: string; pageNumber: number | null; rerankScore: number | null; rank: number }>;
  };
  finalStage: {
    items: Array<{
      chunkId: string;
      pageNumber: number | null;
      vectorScore: number;
      rerankScore: number | null;
      rank: number;
    }>;
  };
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type ChatSession = {
  id: string;
  knowledgeBaseId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ChatSessionListResponse = {
  items: ChatSession[];
};

export type Citation = {
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number | null;
  content: string;
  vectorScore: number;
  rerankScore: number | null;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  createdAt: string;
};

export type ChatMessageListResponse = {
  items: ChatMessage[];
};

export type SendChatMessageResponse = {
  answer: string;
  citations: Citation[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type RegenerateChatMessageResponse = {
  message: ChatMessage;
  rerankFallback: KnowledgeBaseRerankFallback | null;
};
