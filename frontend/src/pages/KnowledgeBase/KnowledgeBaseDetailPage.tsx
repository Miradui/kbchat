import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  addKnowledgeBaseMember,
  createChatSession,
  deleteKnowledgeBaseMember,
  getKnowledgeBase,
  getKnowledgeBasePermissions,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
  recordKnowledgeBaseView,
  searchKnowledgeBase,
  searchUsers,
  updateKnowledgeBaseMember,
  updateKnowledgeBasePermissions,
} from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  DocumentItem,
  DocumentStatus,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBasePermissionResponse,
  KnowledgeBaseRerankFallback,
  KnowledgeBaseSearchResult,
  KnowledgeBaseWorkspacePreference,
  MemberRole,
  PermissionMember,
  RetrievalConfig,
  UserSummary,
} from '../../types/api';

const terminalStatuses: DocumentStatus[] = ['completed', 'failed'];

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function KnowledgeBaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<KnowledgeBasePermissionResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeBaseSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingChat, setStartingChat] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>('member');
  const [userResults, setUserResults] = useState<UserSummary[]>([]);
  const [searchFallback, setSearchFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [memberWorkingId, setMemberWorkingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadPage = useCallback(async () => {
    if (!id) {
      return;
    }

    setError('');
    const [kb, docs, categoryResponse, permissionResponse, preference] = await Promise.all([
      getKnowledgeBase(id),
      listDocuments(id),
      listKnowledgeBaseCategories(),
      getKnowledgeBasePermissions(id),
      getWorkspacePreference().catch(() => fallbackPreference),
    ]);
    setKnowledgeBase(kb);
    setDocuments(docs.items);
    setCategories(categoryResponse.items);
    setPermissions(permissionResponse);
    setExpandedIds(preference.expandedCategoryIds);
  }, [id]);

  useEffect(() => {
    if (!id) {
      return;
    }

    let mounted = true;
    setLoading(true);

    loadPage()
      .then(() => {
        recordKnowledgeBaseView(id).catch(() => undefined);
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '知识库详情加载失败'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [id, loadPage]);

  async function handleStartChat() {
    if (!knowledgeBase) {
      return;
    }

    setStartingChat(true);
    setError('');

    try {
      const session = await createChatSession(knowledgeBase.id, `${knowledgeBase.name} 问答`);
      navigate(`/chat/${session.id}`);
    } catch (err) {
      setError(errorMessage(err, '会话创建失败'));
    } finally {
      setStartingChat(false);
    }
  }

  async function handleVisibilityChange(visibility: 'private' | 'public') {
    if (!knowledgeBase || visibility === (permissions?.visibility ?? knowledgeBase.visibility)) {
      return;
    }

    setSavingVisibility(true);
    setError('');

    try {
      const nextPermissions = await updateKnowledgeBasePermissions(knowledgeBase.id, visibility);
      setPermissions(nextPermissions);
      setKnowledgeBase({ ...knowledgeBase, visibility: nextPermissions.visibility });
    } catch (err) {
      setError(errorMessage(err, '权限展示字段更新失败'));
    } finally {
      setSavingVisibility(false);
    }
  }

  async function reloadPermissions() {
    if (!knowledgeBase) {
      return;
    }
    const nextPermissions = await getKnowledgeBasePermissions(knowledgeBase.id);
    setPermissions(nextPermissions);
    setKnowledgeBase({ ...knowledgeBase, visibility: nextPermissions.visibility });
  }

  async function handleUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = memberQuery.trim();
    if (!query) {
      setUserResults([]);
      return;
    }

    setSearchingUsers(true);
    setError('');

    try {
      const response = await searchUsers(query);
      setUserResults(response.items);
    } catch (err) {
      setError(errorMessage(err, '用户搜索失败'));
      setUserResults([]);
    } finally {
      setSearchingUsers(false);
    }
  }

  async function handleAddMember(user: UserSummary) {
    if (!knowledgeBase) {
      return;
    }

    setMemberWorkingId(user.id);
    setError('');

    try {
      await addKnowledgeBaseMember(knowledgeBase.id, user.id, memberRole);
      await reloadPermissions();
    } catch (err) {
      setError(errorMessage(err, '成员添加失败'));
    } finally {
      setMemberWorkingId(null);
    }
  }

  async function handleUpdateMemberRole(member: PermissionMember, role: MemberRole) {
    if (!knowledgeBase || member.role === 'owner' || member.role === role) {
      return;
    }

    setMemberWorkingId(member.id);
    setError('');

    try {
      await updateKnowledgeBaseMember(knowledgeBase.id, member.id, role);
      await reloadPermissions();
    } catch (err) {
      setError(errorMessage(err, '成员角色更新失败'));
    } finally {
      setMemberWorkingId(null);
    }
  }

  async function handleDeleteMember(member: PermissionMember) {
    if (!knowledgeBase || member.role === 'owner') {
      return;
    }

    const confirmed = window.confirm(`确认移除成员“${member.displayName || member.username}”？`);
    if (!confirmed) {
      return;
    }

    setMemberWorkingId(member.id);
    setError('');

    try {
      await deleteKnowledgeBaseMember(knowledgeBase.id, member.id);
      await reloadPermissions();
    } catch (err) {
      setError(errorMessage(err, '成员移除失败'));
    } finally {
      setMemberWorkingId(null);
    }
  }

  async function handleSemanticSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!knowledgeBase || !searchQuery.trim()) {
      return;
    }

    setSearching(true);
    setError('');
    setSearchFallback(null);

    try {
      const response = await searchKnowledgeBase(knowledgeBase.id, {
        query: searchQuery.trim(),
        vectorTopN: knowledgeBase.retrievalConfig.vectorTopN,
        rerankTopK: knowledgeBase.retrievalConfig.rerankTopK,
        enableRerank: knowledgeBase.retrievalConfig.enableRerank,
      });
      setSearchResults(response.items);
      setSearchFallback(response.rerankFallback?.used ? response.rerankFallback : null);
    } catch (err) {
      setError(errorMessage(err, '知识库内检索失败'));
      setSearchResults([]);
      setSearchFallback(null);
    } finally {
      setSearching(false);
    }
  }

  const categoryName = useMemo(() => {
    if (!knowledgeBase?.categoryId) {
      return '未分类';
    }
    return findCategoryName(categories, knowledgeBase.categoryId) ?? '未分类';
  }, [categories, knowledgeBase?.categoryId]);

  if (loading) {
    return (
      <WorkspaceShell active="knowledge-bases" categories={categories} expandedIds={expandedIds}>
        <div className="kb-detail-page">
          <div className="panel">
            <LoadingSkeleton rows={5} columns={4} />
          </div>
        </div>
      </WorkspaceShell>
    );
  }

  if (!knowledgeBase) {
    return (
      <WorkspaceShell active="knowledge-bases" categories={categories} expandedIds={expandedIds}>
        <div className="kb-detail-page">
          <div className="empty-state">{error || '知识库不存在或无权访问。'}</div>
        </div>
      </WorkspaceShell>
    );
  }

  const completedCount = documents.filter((document) => document.status === 'completed').length;
  const failedCount = documents.filter((document) => document.status === 'failed').length;
  const processingCount = documents.filter((document) => !terminalStatuses.includes(document.status)).length;
  const visibility = permissions?.visibility ?? knowledgeBase.visibility ?? 'private';
  const managers = (permissions?.managers ?? []).filter((member) => member.role !== 'owner');

  return (
    <WorkspaceShell active="knowledge-bases" categories={categories} expandedIds={expandedIds}>
      <div className="kb-detail-page">
        <header className="page-header detail-hero">
          <div>
            <p className="breadcrumb">首页 / 知识库 / {knowledgeBase.name}</p>
            <div className="detail-title-row">
              <span className={`kb-icon ${visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
              <h1>{knowledgeBase.name}</h1>
              <span className={visibility === 'public' ? 'visibility-pill public' : 'visibility-pill private'}>
                {visibility === 'public' ? '公开' : '私有'}
              </span>
            </div>
            <p className="page-description">{knowledgeBase.description || '这个知识库还没有描述。'}</p>
          </div>
          <div className="toolbar">
            <Link className="secondary-link" to="/knowledge-bases">
              返回列表
            </Link>
            <Link className="secondary-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
              文档管理
            </Link>
            <button type="button" onClick={handleStartChat} disabled={startingChat}>
              {startingChat ? '创建会话中...' : '开始问答'}
            </button>
          </div>
        </header>

        {error && <p className="error-text">{error}</p>}

        <div className="summary-grid detail-summary">
          <MetricCard label="文档总数" value={documents.length} />
          <MetricCard label="已完成" value={completedCount} />
          <MetricCard label="处理中" value={processingCount} />
          <MetricCard label="失败文档" value={failedCount} tone="danger" />
        </div>

        <div className="detail-grid">
          <section className="panel detail-main-panel">
            <div className="panel-header">
              <h2>基础信息</h2>
              <span className="muted-text">来自知识库详情接口</span>
            </div>
            <div className="detail-info-grid">
              <InfoItem label="分类" value={categoryName} />
              <InfoItem label="更新时间" value={formatDateTime(knowledgeBase.updatedAt)} />
              <InfoItem label="创建时间" value={formatDateTime(knowledgeBase.createdAt)} />
              <InfoItem label="最后更新人" value={knowledgeBase.updatedBy?.displayName || knowledgeBase.updatedBy?.username || '未知'} />
              <InfoItem label="浏览量" value={String(knowledgeBase.viewCount ?? 0)} />
              <InfoItem label="问答数" value={String(knowledgeBase.questionCount ?? 0)} />
            </div>
            <div className="tag-section">
              <h3>标签</h3>
              <div className="tag-row">
                {knowledgeBase.tags && knowledgeBase.tags.length > 0 ? (
                  knowledgeBase.tags.map((tag) => (
                    <span className="tag-pill" key={tag.id}>
                      {tag.name}
                    </span>
                  ))
                ) : (
                  <span className="muted-text">暂无标签</span>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>成员权限</h2>
              <span className="muted-text">owner、manager、member</span>
            </div>
            <div className="permission-panel-body">
              <label>
                可见性
                <select
                  value={visibility}
                  onChange={(event) => void handleVisibilityChange(event.target.value as 'private' | 'public')}
                  disabled={savingVisibility}
                >
                  <option value="private">私有</option>
                  <option value="public">公开</option>
                </select>
              </label>
              {permissions?.owner && (
                <PermissionMemberCard member={{ ...permissions.owner, role: 'owner' }} title="Owner" />
              )}
              <form className="member-search-form" onSubmit={handleUserSearch}>
                <input
                  aria-label="搜索用户"
                  placeholder="按用户名或显示名搜索"
                  value={memberQuery}
                  onChange={(event) => setMemberQuery(event.target.value)}
                />
                <select
                  aria-label="新增成员角色"
                  value={memberRole}
                  onChange={(event) => setMemberRole(event.target.value as MemberRole)}
                >
                  <option value="member">member</option>
                  <option value="manager">manager</option>
                </select>
                <button type="submit" disabled={searchingUsers || !memberQuery.trim()}>
                  {searchingUsers ? '搜索中...' : '搜索'}
                </button>
              </form>
              {userResults.length > 0 && (
                <div className="member-search-results">
                  {userResults.map((user) => (
                    <article className="member-search-result" key={user.id}>
                      <UserInline user={user} />
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleAddMember(user)}
                        disabled={memberWorkingId === user.id || user.id === permissions?.owner.id}
                      >
                        {memberWorkingId === user.id ? '添加中...' : `设为 ${memberRole}`}
                      </button>
                    </article>
                  ))}
                </div>
              )}
              <PermissionList
                title="Managers"
                members={managers}
                workingId={memberWorkingId}
                onDelete={handleDeleteMember}
                onRoleChange={handleUpdateMemberRole}
              />
              <PermissionList
                title="Members"
                members={permissions?.members ?? []}
                emptyText="暂无成员。"
                workingId={memberWorkingId}
                onDelete={handleDeleteMember}
                onRoleChange={handleUpdateMemberRole}
              />
            </div>
          </section>

          <section className="panel detail-main-panel">
            <div className="panel-header">
              <h2>检索配置</h2>
              <span className="muted-text">RAG 默认路径包含 rerank</span>
            </div>
            <RetrievalConfigGrid config={knowledgeBase.retrievalConfig} />
          </section>

          <section className="panel detail-main-panel semantic-search-panel">
            <div className="panel-header">
              <h2>检索测试</h2>
              <span className="muted-text">调用知识库内语义检索接口</span>
            </div>
            <div className="semantic-search-body">
              <form className="semantic-search-form" onSubmit={handleSemanticSearch}>
                <input
                  aria-label="知识库内检索问题"
                  placeholder="输入问题，测试当前知识库召回片段"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <button type="submit" disabled={searching || !searchQuery.trim()}>
                  {searching ? '检索中...' : '检索'}
                </button>
              </form>

              {searchFallback?.used && (
                <div className="semantic-fallback-notice" role="status">
                  <strong>Rerank 已降级</strong>
                  <span>
                    本次检索未完成精排，结果按向量召回顺序展示。
                    {searchFallback.reason ? `原因：${searchFallback.reason}` : ''}
                  </span>
                </div>
              )}

              {searchResults.length === 0 ? (
                <div className="empty-state">暂无检索结果。完成文档处理后可在这里测试召回片段。</div>
              ) : (
                <div className="semantic-result-list">
                  {searchResults.map((result) => (
                    <article className="semantic-result-item" key={result.chunkId}>
                      <header>
                        <strong>{result.filename}</strong>
                        <span>
                          vector {formatScore(result.vectorScore)}
                          {result.rerankScore !== null && result.rerankScore !== undefined
                            ? ` · rerank ${formatScore(result.rerankScore)}`
                            : ' · rerank 未精排'}
                        </span>
                      </header>
                      <p>{result.content}</p>
                      <small>{result.pageNumber ? `第 ${result.pageNumber} 页` : '页码未返回'}</small>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>文档状态</h2>
              <Link className="secondary-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
                查看文档
              </Link>
            </div>
            <div className="document-status-list">
              {documents.length === 0 ? (
                <div className="empty-state">还没有文档。进入文档管理上传 txt、md 或 pdf。</div>
              ) : (
                documents.slice(0, 6).map((document) => (
                  <article className="document-status-item" key={document.id}>
                    <div>
                      <strong>{document.filename}</strong>
                      <span>{formatBytes(document.fileSize)} · {document.fileType}</span>
                    </div>
                    <span className={`status-pill status-${statusClass(document.status)}`}>
                      {document.status}
                    </span>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className={tone === 'danger' ? 'stat-card danger-stat' : 'stat-card'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RetrievalConfigGrid({ config }: { config: RetrievalConfig }) {
  return (
    <div className="config-grid detail-config-grid">
      <div className="stat-card">
        <span>vectorTopN</span>
        <strong>{config.vectorTopN}</strong>
      </div>
      <div className="stat-card">
        <span>rerankTopK</span>
        <strong>{config.rerankTopK}</strong>
      </div>
      <div className="stat-card">
        <span>scoreThreshold</span>
        <strong>{config.scoreThreshold}</strong>
      </div>
      <div className="stat-card">
        <span>enableRerank</span>
        <small>{config.enableRerank ? '开启' : '关闭'}</small>
      </div>
    </div>
  );
}

function PermissionList({
  title,
  members,
  emptyText = '暂无成员',
  workingId,
  onDelete,
  onRoleChange,
}: {
  title: string;
  members: PermissionMember[];
  emptyText?: string;
  workingId?: string | null;
  onDelete?: (member: PermissionMember) => void;
  onRoleChange?: (member: PermissionMember, role: MemberRole) => void;
}) {
  return (
    <div className="permission-list">
      <h3>{title}</h3>
      {members.length === 0 ? (
        <p className="muted-text">{emptyText}</p>
      ) : (
        members.map((member) => (
          <PermissionMemberCard
            member={member}
            working={workingId === member.id}
            key={`${title}-${member.id}-${member.role}`}
            onDelete={onDelete}
            onRoleChange={onRoleChange}
          />
        ))
      )}
    </div>
  );
}

function PermissionMemberCard({
  member,
  title,
  working = false,
  onDelete,
  onRoleChange,
}: {
  member: PermissionMember;
  title?: string;
  working?: boolean;
  onDelete?: (member: PermissionMember) => void;
  onRoleChange?: (member: PermissionMember, role: MemberRole) => void;
}) {
  const name = member.displayName || member.username;
  const mutable = member.role !== 'owner';
  return (
    <article className="permission-member-card">
      {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}
      <div>
        {title && <em>{title}</em>}
        <strong>{name}</strong>
        <small>{member.username} · {member.role}</small>
      </div>
      {mutable && (
        <div className="permission-member-actions">
          <select
            aria-label={`修改 ${name} 的角色`}
            value={member.role}
            disabled={working}
            onChange={(event) => onRoleChange?.(member, event.target.value as MemberRole)}
          >
            <option value="manager">manager</option>
            <option value="member">member</option>
          </select>
          <button
            className="link-button"
            type="button"
            disabled={working}
            onClick={() => onDelete?.(member)}
          >
            移除
          </button>
        </div>
      )}
    </article>
  );
}

function UserInline({ user }: { user: UserSummary }) {
  const name = user.displayName || user.username;
  return (
    <span className="user-cell">
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}
      <span>
        <strong>{name}</strong>
        <small>{user.username}</small>
      </span>
    </span>
  );
}

function findCategoryName(categories: KnowledgeBaseCategory[], id: string): string | null {
  for (const category of categories) {
    if (category.id === id) {
      return category.name;
    }
    const child = findCategoryName(category.children ?? [], id);
    if (child) {
      return child;
    }
  }
  return null;
}

function statusClass(status: DocumentStatus): string {
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  return 'processing';
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
