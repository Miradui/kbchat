import type { ChatSession } from './chat';
import type { UserSummary } from './common';
import type { GlobalDocumentItem } from './document';

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

export type KnowledgeBase = {
  documentVersionPolicy?: 'all' | 'current';
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
  documentVersionPolicy?: 'all' | 'current';
  name: string;
  description: string;
  categoryId?: string | null;
  visibility?: 'private' | 'public';
  retrievalConfig?: RetrievalConfig;
  answerConfig?: AnswerConfig;
  tagIds?: string[];
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
  processingDocumentTotal: number;
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
