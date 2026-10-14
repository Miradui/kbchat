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
  status?: 'active' | 'disabled' | string;
  lastLoginAt?: string | null;
};

export type AdminUser = User & { status: 'active' | 'disabled'; createdAt: string; ownedKnowledgeBaseCount: number };
export type AdminUserListResponse = { items: AdminUser[]; total: number; page: number; pageSize: number };
export type AdminUserCreateInput = { username: string; displayName?: string; password?: string };
export type TransferOwnershipInput = { newOwnerId: string; keepPreviousOwnerAsManager: boolean };
export type AdminActivity = {
  id: string; action: string; resourceType: string; resourceId: string; resourceName: string;
  actor: { id: string; username: string; displayName: string }; createdAt: string;
};
export type AdminActivityListResponse = { items: AdminActivity[]; total: number; page: number; pageSize: number };

export type LoginResponse = {
  token: string;
  user: User;
};

export type RetrievalConfig = {
  vectorTopN: number;
  rerankTopK: number;
  scoreThreshold: number;
  enableRerank: boolean;
  enableKeyword: boolean;
};
export type AnswerConfig = {
  systemPromptAddition: string;
  answerLanguage: 'auto' | 'zh' | 'en';
  allowGeneralKnowledge: boolean;
  model: string;
  temperature?: number | null;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  categoryId?: string | null;
  visibility?: 'private' | 'public';
  retrievalConfig: RetrievalConfig;
  answerConfig: AnswerConfig;
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
  /**
   * The caller's own standing in this knowledge base. The server always sends it,
   * but it stays optional here so a response from an older build reads as unknown
   * rather than as `viewer` — see `roleAtLeast`, which treats unknown as no access.
   */
  effectiveRole?: EffectiveRole;
  /**
   * What `effectiveRole` permits. Present so the UI can hide actions the server
   * would only answer with 403. It is a convenience, never the boundary: the
   * server checks every request regardless of what it told the client.
   */
  capabilities?: Capability[];
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
  answerConfig?: AnswerConfig;
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
 * to is permanently deleted. See docs/04-api-design.md (GET /activities).
 */
export type ActivityItemResponse = {
  id: string;
  action: string;
  resourceType: 'knowledgeBase' | 'document' | 'chatSession' | 'member' | 'user';
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
 * See docs/04-api-design.md (GET /home/summary).
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
  role: EffectiveRole;
};

export type KnowledgeBasePermissionResponse = {
  knowledgeBaseId: string;
  visibility: 'private' | 'public';
  owner: UserSummary;
  managers: PermissionMember[];
  members: PermissionMember[];
};

/**
 * The roles that can be granted to a member. `owner` is absent on purpose:
 * ownership comes from the knowledge base row, so a grantable owner role would be
 * a second source of truth and the server rejects it.
 */
export type MemberRole = 'viewer' | 'editor' | 'manager';

/** A member role, or ownership, which outranks all of them. */
export type EffectiveRole = MemberRole | 'owner';

/**
 * The capability names the server sends in `capabilities`. Kept as a union rather
 * than `string` so a typo in a gating check fails the build instead of silently
 * hiding a button forever.
 */
export type Capability =
  | 'kb.read'
  | 'kb.write'
  | 'kb.delete'
  | 'kb.transfer'
  | 'kb.search'
  | 'members.read'
  | 'members.write'
  | 'document.read'
  | 'document.download'
  | 'content.write'
  | 'content.purge'
  | 'chat.use'
  | 'chat.export'
  | 'feedback.write'
  | 'quality.read';

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
  | 'table_limit_exceeded'
  | 'unsupported_type'
  | 'corrupt_file'
  | 'encoding_invalid'
  | 'empty_content'
  | 'embedding_failed'
  | 'storage_failed'
  | 'cancelled'
  | 'internal';

export type PdfTextSummary = {
  totalPages: number;
  textPages: number;
  pagesWithoutText: number[];
};

export type DocumentItem = {
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

export type SystemCapabilities = {
  rerankEnabled: boolean;
  keywordSearchEnabled: boolean;
  chatModels?: string[];
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
    maxAvatarBytes?: number;
    avatarSize?: number;
    avatarContentTypes?: string[];
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
  enableKeyword?: boolean;
  debug?: boolean;
};

export type KnowledgeBaseSearchResult = {
  table?: TableSource;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  chunkId: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  vectorScore: number;
  keywordScore?: number | null;
  rerankScore?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
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
    /** True when the index scan came back short and the stage was rerun exhaustively. */
    exactFallback?: boolean;
  };
  keywordStage: {
    status: 'completed' | 'disabled' | 'failed';
    items: Array<{
      chunkId: string;
      documentId: string;
      filename: string;
      pageNumber: number | null;
      content: string;
      keywordScore: number;
      rank: number;
    }>;
  };
  fusionStage: {
    status: 'completed' | 'skipped';
    items: Array<{
      chunkId: string;
      pageNumber: number | null;
      vectorRank: number | null;
      keywordRank: number | null;
      fusionScore: number;
      vectorScore: number;
      keywordScore: number | null;
      rank: number;
    }>;
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
      keywordScore: number | null;
      fusionScore: number | null;
      rerankScore: number | null;
      rank: number;
    }>;
  };
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type ChatSession = {
  branchFromSessionId?: string;
  branchFromMessageId?: string;
  scopeMode?: 'auto' | 'manual';
  knowledgeBaseIds?: string[];
  knowledgeBases?: Array<{ id: string; name: string }>;
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
  table?: TableSource;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number | null;
  content: string;
  vectorScore: number;
  rerankScore: number | null;
  /**
   * UTF-8 byte range of the chunk's own text in the normalized source (BOM
   * removed, CRLF/CR as LF); absent on citations stored before offsets existed.
   */
  startOffset?: number | null;
  endOffset?: number | null;
};

/**
 * Why an answer came out the way it did. The three failure modes need different
 * responses from the user: `no_basis` means upload something, `retrieval_failed`
 * means retry because the system broke, `model_refused` means neither will help.
 */
export type ChatAnswerStatus = 'answered' | 'no_basis' | 'retrieval_failed' | 'model_refused';

export type ChatMessage = {
  bookmark?: ChatBookmark | null;
  id: string;
  sessionId: string;
  clientRequestId?: string | null;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  feedback?: ChatMessageFeedback | null;
  /**
   * Null on user messages and on answers recorded before migration 019. Null means
   * *unknown*, not `answered` — treating it as answered would relabel history.
   */
  answerStatus?: ChatAnswerStatus | null;
  createdAt: string;
};

export type ChatFeedbackRating = 'positive' | 'negative';

export type ChatFeedbackReason = 'inaccurate' | 'missing_evidence' | 'irrelevant' | 'incomplete' | 'other';
export type ChatFeedbackDetails = { reason?: ChatFeedbackReason | ''; comment?: string };

export type ChatMessageFeedback = ChatFeedbackDetails & {
	messageId: string;
	rating: ChatFeedbackRating;
	updatedAt: string;
};

export type ChatQualityPeriod = 'day' | 'month';

export type ChatQualityOverviewParams = {
	period?: ChatQualityPeriod;
	knowledgeBaseId?: string;
};

export type ChatQualityOverview = {
	period: ChatQualityPeriod;
	startAt: string;
	endAt: string;
	answerCount: number;
	feedbackCount: number;
	positiveFeedbackCount: number;
	negativeFeedbackCount: number;
	/** Answers classified as knowledge_base; the denominator of withoutCitationsRate. */
	knowledgeAnswerCount: number;
	/**
	 * Answers with an empty citation list *and* knowledge_base intent. Conversation
	 * answers are given no citations on purpose and are excluded.
	 */
	withoutCitationsCount: number;
	/**
	 * Answers written before intent was recorded. They are excluded from
	 * withoutCitationsCount and withoutCitationsRate rather than assumed grounded,
	 * so a non-zero value means those rates cover only part of the period.
	 */
	unclassifiedAnswerCount: number;
	feedbackCoverage: number;
	positiveRate: number;
	/** withoutCitationsCount / knowledgeAnswerCount, or 0 when there are none. */
	withoutCitationsRate: number;
};

export type ChatUsageGroupBy = 'day' | 'knowledgeBase' | 'user' | 'model' | 'purpose';

export type ChatUsageItem = {
  /** "YYYY-MM-DD" (UTC) for day grouping, the UUID for knowledgeBase/user, the model name for model. */
  groupKey: string;
  groupLabel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** Only set per row for model grouping when that model is priced. */
  estimatedCost: number | null;
};

export type ChatUsageResponse = {
  from: string; to: string; groupBy: string;
  items: ChatUsageItem[];
  totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number;
  pricingConfigured: boolean;
  estimatedCost: number | null;
  unpricedModels: string[];
};

export type ChatQualityFeedbackParams = ChatQualityOverviewParams & {
	hasCitations?: boolean;
	page?: number;
	pageSize?: number;
};

export type ChatQualityFeedbackItem = ChatFeedbackDetails & {
	messageId: string;
	sessionId: string;
	sessionTitle: string;
	knowledgeBaseId: string;
	knowledgeBaseName: string;
	question: string;
	answer: string;
	citations: Citation[];
	rerankFallback: KnowledgeBaseRerankFallback | null;
	createdAt: string;
	feedbackUpdatedAt: string;
};

export type ChatQualityFeedbackListResponse = {
	items: ChatQualityFeedbackItem[];
	total: number;
	page: number;
	pageSize: number;
};

/**
 * `no_citations` is one knowledge answer that retrieved nothing.
 * `repeated_rewrite` is a cluster: one question rephrased at least twice inside a
 * session. Regenerations are excluded, since asking for another attempt at the
 * same question is a different problem from rephrasing it.
 */
/**
 * `retrieval_failed` and `model_refused` were carved out of `no_citations`: all
 * three have no citations, but only the first is fixed by uploading documents.
 */
export type ChatKnowledgeGapCategory =
  | 'no_citations'
  | 'retrieval_failed'
  | 'model_refused'
  | 'repeated_rewrite';

export type ChatKnowledgeGapParams = ChatQualityOverviewParams & {
	category?: ChatKnowledgeGapCategory | 'all';
	page?: number;
	pageSize?: number;
};

export type ChatKnowledgeGapItem = {
	category: ChatKnowledgeGapCategory;
	/** Null for a repeated_rewrite cluster, which spans several answers. */
	messageId: string | null;
	sessionId: string;
	sessionTitle: string;
	knowledgeBaseId: string;
	knowledgeBaseName: string;
	question: string;
	retrievalQuery: string;
	/** Always 1 for no_citations; the cluster size for repeated_rewrite. */
	occurrenceCount: number;
	/** How many answers in the row retrieved nothing. */
	ungroundedCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
};

export type ChatKnowledgeGapListResponse = {
	items: ChatKnowledgeGapItem[];
	total: number;
	page: number;
	pageSize: number;
	/** Reported regardless of the requested category so a filter can be labelled. */
	noCitationsTotal: number;
	/**
	 * Only counts turns recorded after migration 019 added `answer_status`. A zero
	 * means "not observed yet", not "never happens".
	 */
	retrievalFailedTotal: number;
	modelRefusedTotal: number;
	repeatedRewriteTotal: number;
};

export type ChatMessageListResponse = {
  items: ChatMessage[];
  hasMore?: boolean;
  nextCursor?: string;
  hasNewer?: boolean;
  newerCursor?: string;
  revision?: string;
};

export type ChatMessagePageParams = { limit: number; before?: string; after?: string; around?: string; since?: string; revision?: string };

export type ChatSearchExcerpt = { before: string; match: string; after: string };
export type ChatMessageSearchItem = {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  archivedAt: string | null;
  role: 'user' | 'assistant';
  createdAt: string;
  excerpt: ChatSearchExcerpt;
};
export type ChatMessageSearchParams = { q: string; sessionId?: string; page?: number; pageSize?: number };
export type ChatMessageSearchResponse = { items: ChatMessageSearchItem[]; total: number; page: number; pageSize: number };

export type PersonalListParams = { q?: string; page?: number; pageSize?: number };
export type QuestionTemplate = { id: string; title: string; body: string; variables: string[]; createdAt: string; updatedAt: string };
export type QuestionTemplateListResponse = { items: QuestionTemplate[]; total: number; page: number; pageSize: number };
export type DocumentVersion = { id: string; filename: string; status: string; createdAt: string; supersededById: string | null };
export type DocumentDiffLine = { kind: 'equal' | 'add' | 'remove'; content: string; baseLine: number | null; headLine: number | null };
export type DocumentCompareResponse = { base: DocumentVersion; head: DocumentVersion; addedLines: number; removedLines: number; lines: DocumentDiffLine[] };
export type TableSource = { sheetName: string; rowStart: number; rowEnd: number; headerRow: number };
export type ChatBookmark = { messageId: string; note: string; createdAt: string; updatedAt: string };
export type ChatBookmarkItem = ChatMessageSearchItem & { bookmark: ChatBookmark };
export type ChatBookmarkListResponse = { items: ChatBookmarkItem[]; total: number; page: number; pageSize: number };

export type SendChatMessageRequest = {
  content: string;
  clientRequestId: string;
};

export type EditChatMessageRequest = SendChatMessageRequest;

export type SendChatMessageResponse = {
  clientRequestId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  answer: string;
  citations: Citation[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type RegenerateChatMessageResponse = {
  message: ChatMessage;
  rerankFallback: KnowledgeBaseRerankFallback | null;
};

export type SystemDependencyState = 'ok' | 'degraded' | 'down' | 'not_configured';

/**
 * The closed reason set the server may return. It carries no error text, host or
 * connection string by design, so the UI maps codes to copy rather than
 * displaying whatever arrives.
 */
export type SystemFailureReason =
  | 'timeout'
  | 'unreachable'
  | 'auth_rejected'
  | 'not_configured'
  | 'not_found'
  | 'unavailable';

export type SystemDependencyStatus = {
  name: string;
  status: SystemDependencyState;
  reason?: string;
  latencyMs: number | null;
};

export type SystemProviderStatus = {
  name: string;
  configured: boolean;
  model?: string;
  status: SystemDependencyState;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason?: string;
  successCount: number;
  failureCount: number;
  recentFailures: number;
};

export type SystemDocumentQueueStatus = {
  pending: number;
  running: number;
  failed: number;
  completed: number;
  cancelled: number;
  oldestPendingSeconds: number | null;
  oldestRunningSeconds: number | null;
  failureWindowHours: number;
  finishedInWindow: number;
  failedInWindow: number;
  /** Null when the window holds no finished jobs, which is not a zero rate. */
  recentFailureRate: number | null;
};

export type SystemCleanupQueueStatus = {
  backlog: number;
  retrying: number;
  locked: number;
  oldestPendingSeconds: number | null;
};

export type SystemLatencyMetric = {
  metric: string;
  count: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type SystemEmbeddingCacheMetrics = {
  hits: number;
  misses: number;
  errors: number;
  /** Null until this process has observed at least one cache hit or miss. */
  hitRate: number | null;
};

export type SystemVectorSearchStatus = {
  /** Empty when the version could not be read. */
  pgvectorVersion: string;
  /** pgvector 0.8.0 and later keep scanning the HNSW index until the page is full. */
  iterativeScan: boolean;
  /** Searches since restart whose approximate scan was rerun exhaustively. */
  exactFallbacks: number;
};

export type SystemEmbeddingStatus = {
  status: SystemDependencyState; model: string; configuredDimension: number; columnDimension: number | null;
  totalDocuments: number; unknownDocuments: number; mismatchedDocuments: number;
  groups: Array<{ model: string | null; dimension: number | null; count: number }>;
};

export type SystemDiagnostics = {
  status: SystemDependencyState;
  checkedAt: string;
  env: string;
  dependencies: SystemDependencyStatus[];
  queues: {
    documents: SystemDocumentQueueStatus;
    cleanup: SystemCleanupQueueStatus;
  };
  providers: SystemProviderStatus[];
  latency: SystemLatencyMetric[];
  rerankFallbacks: Record<string, number>;
  rateLimitTriggers: Record<string, number>;
  embeddingCache: SystemEmbeddingCacheMetrics;
  vectorSearch: SystemVectorSearchStatus;
  embedding?: SystemEmbeddingStatus;
  /** Latency, fallback, rate-limit and cache counters reset on restart. */
  metricsSinceRestart: boolean;
};
