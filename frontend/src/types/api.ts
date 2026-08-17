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
  completedDocumentCount?: number;
  processingDocumentCount?: number;
  failedDocumentCount?: number;
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
  /**
   * Knowledge bases filed directly under this category. Only the category tree
   * endpoint returns it; create/update responses leave it undefined.
   */
  directCount?: number;
  /** directCount plus every descendant category's directCount. */
  totalCount?: number;
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
  /**
   * Knowledge bases referencing this tag, including ones sitting in the recycle
   * bin. A non-zero value means deletion will be rejected with TAG_NOT_EMPTY.
   * Tag summaries embedded on knowledge base payloads leave it undefined.
   */
  knowledgeBaseCount?: number;
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

/**
 * Single knowledge base trends. Deliberately has no `knowledgeBases` metric —
 * that count is always 0 or 1 for one knowledge base and carries no trend.
 */
export type KnowledgeBaseDetailStatsResponse = {
  knowledgeBaseId: string;
  period: 'day' | 'month';
  documents: WorkspaceMetric;
  views: WorkspaceMetric;
  questions: WorkspaceMetric;
};

export type KnowledgeBaseBatchTagMode = 'add' | 'remove' | 'replace';

/**
 * One recorded workspace event. `resourceName` / `knowledgeBaseName` are stored
 * with the event, so an entry still reads correctly after the resource it refers
 * to is permanently deleted. See docs/14-frontend-api-gaps.md G18.
 */
export type ActivityItemResponse = {
  id: string;
  action: string;
  resourceType: 'knowledgeBase' | 'document' | 'chatSession' | 'member';
  resourceId: string;
  resourceName: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  createdAt: string;
};

export type ActivityListResponse = {
  items: ActivityItemResponse[];
};

/**
 * The whole workspace landing page in one response. List lengths are chosen by
 * the server; each is paired with the unfiltered total so the page can show
 * "5 of 42" without guessing a pageSize.
 * See docs/14-frontend-api-gaps.md G17.
 */
export type HomeSummaryResponse = {
  period: 'day' | 'month';
  stats: KnowledgeBaseStatsResponse;
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseTotal: number;
  documents: GlobalDocumentItem[];
  documentTotal: number;
  failedDocuments: GlobalDocumentItem[];
  failedDocumentTotal: number;
  sessions: ChatSession[];
  sessionTotal: number;
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

export type DocumentJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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

/**
 * GET /knowledge-bases/:id/documents is the knowledge-base-scoped view of
 * GET /documents and returns the same paginated shape. See docs/14-frontend-api-gaps.md G20.
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

export type SystemCapabilities = {
  rerankEnabled: boolean;
  upload: {
    maxFileBytes: number;
    allowedExtensions: string[];
  };
  retrieval: {
    maxVectorTopN: number;
    maxRerankTopK: number;
  };
  account: {
    minPasswordLength: number;
    maxPasswordBytes: number;
    maxDisplayNameLength: number;
    maxAvatarUrlLength: number;
  };
};

export type UpdateProfileInput = {
  displayName: string;
  avatarUrl?: string;
};

export type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
};

export type GlobalSearchResultType = 'knowledgeBase' | 'document' | 'chunk';

/**
 * One match position inside a result field.
 *
 * `start`/`end` are **UTF-16 code units** — plain JavaScript string indices, so
 * `text.slice(start, end)` is the matched text. They are not byte offsets and
 * not code-point indices; with CJK content those three disagree.
 */
export type SearchHighlight = {
  field: 'title' | 'snippet';
  start: number;
  end: number;
};

export type GlobalSearchResult = {
  type: GlobalSearchResultType;
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId?: string;
  filename?: string;
  title: string;
  snippet: string;
  highlights?: SearchHighlight[];
};

export type SearchSuggestItem = {
  type: 'knowledgeBase' | 'document';
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId?: string;
  title: string;
};

export type SearchSuggestResponse = {
  items: SearchSuggestItem[];
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
  total: number;
  page: number;
  pageSize: number;
};

export type GlobalSearchParams = {
  query: string;
  type?: 'all' | GlobalSearchResultType;
  page?: number;
  pageSize?: number;
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
  /**
   * The three fields below only come back from the session list endpoint.
   * Single-session responses (create/get/rename/archive/unarchive) omit them.
   */
  knowledgeBaseName?: string;
  messageCount?: number;
  lastMessagePreview?: string;
};

export type ChatSessionListParams = {
  knowledgeBaseId?: string;
  archived?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ChatSessionListResponse = {
  items: ChatSession[];
  total: number;
  page: number;
  pageSize: number;
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
  clientRequestId?: string | null;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  feedback?: ChatMessageFeedback | null;
  createdAt: string;
};

export type ChatFeedbackRating = 'positive' | 'negative';

export type ChatMessageFeedback = {
  messageId: string;
  rating: ChatFeedbackRating;
  updatedAt: string;
};

export type ChatMessageListResponse = {
  items: ChatMessage[];
};

export type SendChatMessageRequest = {
  content: string;
  clientRequestId: string;
};

export type SendChatMessageResponse = {
  clientRequestId?: string;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  answer: string;
  citations: Citation[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type RegenerateChatMessageResponse = {
  message: ChatMessage;
  rerankFallback: KnowledgeBaseRerankFallback | null;
};
