import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  addKnowledgeBaseMember,
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
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { RerankFallbackNotice } from '../../components/feedback/RerankFallbackNotice';
import { useToast } from '../../components/feedback/ToastProvider';
import type {
  DocumentItem,
  DocumentStatus,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBasePermissionResponse,
  KnowledgeBaseRerankFallback,
  KnowledgeBaseSearchDebug,
  KnowledgeBaseSearchResult,
  KnowledgeBaseWorkspacePreference,
  MemberRole,
  PermissionMember,
  RetrievalConfig,
  UserSummary,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { KnowledgeBaseEntityActions } from './KnowledgeBaseEntityActions';
import { KnowledgeBaseSectionNav, type KnowledgeBaseSection } from './KnowledgeBaseSectionNav';

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
  const [searchParams] = useSearchParams();
  const activeTab = normalizeDetailTab(searchParams.get('tab'));
  const toast = useToast();
  const activeKnowledgeBaseIdRef = useRef(id);
  const knowledgeBaseRequestRef = useRef(0);
  const documentRequestRef = useRef(0);
  const permissionRequestRef = useRef(0);
  const visibilityRequestRef = useRef(0);
  const userSearchRequestRef = useRef(0);
  const semanticSearchRequestRef = useRef(0);
  const memberMutationRef = useRef<symbol | null>(null);
  const visibilityMutationRef = useRef<symbol | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<KnowledgeBasePermissionResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeBaseSearchResult[]>([]);
  const [searchDebugEnabled, setSearchDebugEnabled] = useState(false);
  const [searchDebug, setSearchDebug] = useState<KnowledgeBaseSearchDebug | null>(null);
  const [loading, setLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentSummaryLoaded, setDocumentSummaryLoaded] = useState(false);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>('member');
  const [userResults, setUserResults] = useState<UserSummary[]>([]);
  const [searchFallback, setSearchFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [memberWorkingId, setMemberWorkingId] = useState<string | null>(null);
  const [memberDeleteTarget, setMemberDeleteTarget] = useState<PermissionMember | null>(null);
  const [memberDeleteError, setMemberDeleteError] = useState('');
  const [error, setError] = useState('');
  const [documentError, setDocumentError] = useState('');
  const [permissionError, setPermissionError] = useState('');
  activeKnowledgeBaseIdRef.current = id;

  const loadKnowledgeBase = useCallback(async () => {
    if (!id) {
      return false;
    }

    const requestedId = id;
    const request = ++knowledgeBaseRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await getKnowledgeBase(requestedId);
      if (activeKnowledgeBaseIdRef.current === requestedId && knowledgeBaseRequestRef.current === request) {
        setKnowledgeBase(response);
        recordKnowledgeBaseView(requestedId).catch(() => undefined);
      }
    } catch (err) {
      if (activeKnowledgeBaseIdRef.current === requestedId && knowledgeBaseRequestRef.current === request) {
        setKnowledgeBase(null);
        setError(errorMessage(err, '知识库详情加载失败'));
      }
    } finally {
      if (activeKnowledgeBaseIdRef.current === requestedId && knowledgeBaseRequestRef.current === request) {
        setLoading(false);
      }
    }
  }, [id]);

  const loadDocumentSummary = useCallback(async () => {
    if (!id) {
      return;
    }

    const requestedId = id;
    const request = ++documentRequestRef.current;
    setDocumentsLoading(true);
    setDocumentError('');
    try {
      const response = await listDocuments(requestedId);
      if (activeKnowledgeBaseIdRef.current === requestedId && documentRequestRef.current === request) {
        setDocuments(response.items);
      }
    } catch (err) {
      if (activeKnowledgeBaseIdRef.current === requestedId && documentRequestRef.current === request) {
        setDocuments([]);
        setDocumentError(errorMessage(err, '文档摘要加载失败'));
      }
    } finally {
      if (activeKnowledgeBaseIdRef.current === requestedId && documentRequestRef.current === request) {
        setDocumentsLoading(false);
        setDocumentSummaryLoaded(true);
      }
    }
  }, [id]);

  const loadPermissions = useCallback(async () => {
    if (!id) {
      return;
    }

    const requestedId = id;
    const request = ++permissionRequestRef.current;
    setPermissionsLoading(true);
    setPermissionError('');
    try {
      const response = await getKnowledgeBasePermissions(requestedId);
      if (activeKnowledgeBaseIdRef.current === requestedId && permissionRequestRef.current === request) {
        setPermissions(response);
        setKnowledgeBase((current) => current?.id === requestedId
          ? { ...current, visibility: response.visibility }
          : current);
      }
    } catch (err) {
      if (activeKnowledgeBaseIdRef.current === requestedId && permissionRequestRef.current === request) {
        setPermissions(null);
        setPermissionError(errorMessage(err, '成员权限加载失败'));
      }
    } finally {
      if (activeKnowledgeBaseIdRef.current === requestedId && permissionRequestRef.current === request) {
        setPermissionsLoading(false);
        setPermissionsLoaded(true);
      }
    }
  }, [id]);

  useEffect(() => {
    activeKnowledgeBaseIdRef.current = id;
    setKnowledgeBase(null);
    setDocuments([]);
    setDocumentSummaryLoaded(false);
    setPermissions(null);
    setPermissionsLoaded(false);
    setPermissionsLoading(false);
    setPermissionError('');
    setSearchResults([]);
    setUserResults([]);
    visibilityRequestRef.current += 1;
    userSearchRequestRef.current += 1;
    semanticSearchRequestRef.current += 1;
    memberMutationRef.current = null;
    visibilityMutationRef.current = null;
    setSavingVisibility(false);
    setMemberWorkingId(null);
    setMemberDeleteTarget(null);
    setMemberDeleteError('');
    void loadKnowledgeBase();

    return () => {
      if (activeKnowledgeBaseIdRef.current === id) {
        activeKnowledgeBaseIdRef.current = undefined;
      }
      knowledgeBaseRequestRef.current += 1;
      documentRequestRef.current += 1;
      permissionRequestRef.current += 1;
      visibilityRequestRef.current += 1;
      userSearchRequestRef.current += 1;
      semanticSearchRequestRef.current += 1;
      memberMutationRef.current = null;
      visibilityMutationRef.current = null;
    };
  }, [loadKnowledgeBase]);

  useEffect(() => {
    if (activeTab === 'settings' || documentSummaryLoaded) {
      return;
    }
    void loadDocumentSummary();
  }, [activeTab, documentSummaryLoaded, loadDocumentSummary]);

  useEffect(() => {
    if (activeTab === 'settings') {
      if (!permissionsLoaded && !permissionsLoading) {
        void loadPermissions();
      }
      return;
    }

    permissionRequestRef.current += 1;
    userSearchRequestRef.current += 1;
    setPermissionsLoading(false);
    setSearchingUsers(false);
    setMemberDeleteTarget(null);
    setMemberDeleteError('');
  }, [activeTab, loadPermissions, permissionsLoaded, permissionsLoading]);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ]).then(([categoryResponse, preference]) => {
      if (!mounted) return;
      setCategories(categoryResponse.items);
      setExpandedIds(preference.expandedCategoryIds);
    });
    return () => {
      mounted = false;
    };
  }, []);

  function handleStartChat() {
    if (!knowledgeBase) {
      return;
    }
    navigate(`/chat/new?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`);
  }

  async function handleVisibilityChange(visibility: 'private' | 'public') {
    if (
      !knowledgeBase
      || visibility === (permissions?.visibility ?? knowledgeBase.visibility)
      || memberMutationRef.current
      || visibilityMutationRef.current
    ) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('update-knowledge-base-visibility');
    visibilityMutationRef.current = operation;
    const request = ++visibilityRequestRef.current;
    permissionRequestRef.current += 1;
    setSavingVisibility(true);
    setError('');

    try {
      const nextPermissions = await updateKnowledgeBasePermissions(requestedId, visibility);
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && visibilityRequestRef.current === request
        && visibilityMutationRef.current === operation
      ) {
        setPermissions(nextPermissions);
        setKnowledgeBase((current) => current?.id === requestedId
          ? { ...current, visibility: nextPermissions.visibility }
          : current);
      }
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && visibilityRequestRef.current === request
        && visibilityMutationRef.current === operation
      ) {
        setError(errorMessage(err, '权限展示字段更新失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && visibilityRequestRef.current === request
        && visibilityMutationRef.current === operation
      ) {
        visibilityMutationRef.current = null;
        setSavingVisibility(false);
      }
    }
  }

  async function reloadPermissions(requestedId: string, operation: symbol) {
    const request = ++permissionRequestRef.current;
    const nextPermissions = await getKnowledgeBasePermissions(requestedId);
    if (
      activeKnowledgeBaseIdRef.current !== requestedId
      || memberMutationRef.current !== operation
      || permissionRequestRef.current !== request
    ) {
      return;
    }
    setPermissions(nextPermissions);
    setPermissionError('');
    setKnowledgeBase((current) => current?.id === requestedId
      ? { ...current, visibility: nextPermissions.visibility }
      : current);
  }

  async function handleUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = memberQuery.trim();
    if (!query) {
      userSearchRequestRef.current += 1;
      setUserResults([]);
      return;
    }

    const request = ++userSearchRequestRef.current;
    const requestedKnowledgeBaseId = knowledgeBase?.id;
    setSearchingUsers(true);
    setError('');

    try {
      const response = await searchUsers(query);
      if (
        userSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setUserResults(response.items);
      }
    } catch (err) {
      if (
        userSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setError(errorMessage(err, '用户搜索失败'));
        setUserResults([]);
      }
    } finally {
      if (
        userSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setSearchingUsers(false);
      }
    }
  }

  async function handleAddMember(user: UserSummary) {
    if (!knowledgeBase || memberMutationRef.current || visibilityMutationRef.current) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('add-knowledge-base-member');
    memberMutationRef.current = operation;
    setMemberWorkingId(user.id);
    setError('');

    try {
      await addKnowledgeBaseMember(requestedId, user.id, memberRole);
      await reloadPermissions(requestedId, operation);
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        setError(errorMessage(err, '成员添加失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        memberMutationRef.current = null;
        setMemberWorkingId(null);
      }
    }
  }

  async function handleUpdateMemberRole(member: PermissionMember, role: MemberRole) {
    if (
      !knowledgeBase
      || member.role === 'owner'
      || member.role === role
      || memberMutationRef.current
      || visibilityMutationRef.current
    ) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('update-knowledge-base-member');
    memberMutationRef.current = operation;
    setMemberWorkingId(member.id);
    setError('');

    try {
      await updateKnowledgeBaseMember(requestedId, member.id, role);
      await reloadPermissions(requestedId, operation);
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        setError(errorMessage(err, '成员角色更新失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        memberMutationRef.current = null;
        setMemberWorkingId(null);
      }
    }
  }

  function openMemberDelete(member: PermissionMember) {
    if (member.role === 'owner' || memberMutationRef.current || visibilityMutationRef.current) {
      return;
    }
    setMemberDeleteTarget(member);
    setMemberDeleteError('');
  }

  async function handleDeleteMember() {
    const member = memberDeleteTarget;
    if (!knowledgeBase || !member || member.role === 'owner' || memberMutationRef.current || visibilityMutationRef.current) {
      return;
    }

    const requestedId = knowledgeBase.id;
    const operation = Symbol('delete-knowledge-base-member');
    memberMutationRef.current = operation;
    setMemberWorkingId(member.id);
    setMemberDeleteError('');

    try {
      await deleteKnowledgeBaseMember(requestedId, member.id);
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        setPermissions((current) => current ? {
          ...current,
          managers: current.managers.filter((item) => item.id !== member.id),
          members: current.members.filter((item) => item.id !== member.id),
        } : current);
        setMemberDeleteTarget(null);
        toast.success('成员移除成功');
      }
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        setMemberDeleteError(errorMessage(err, '成员移除失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedId
        && memberMutationRef.current === operation
      ) {
        memberMutationRef.current = null;
        setMemberWorkingId(null);
      }
    }
  }

  async function handleSemanticSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!knowledgeBase || !searchQuery.trim()) {
      return;
    }

    const requestedKnowledgeBaseId = knowledgeBase.id;
    const request = ++semanticSearchRequestRef.current;
    const query = searchQuery.trim();
    setSearching(true);
    setError('');
    setSearchFallback(null);
    setSearchDebug(null);

    try {
      const response = await searchKnowledgeBase(requestedKnowledgeBaseId, {
        query,
        vectorTopN: knowledgeBase.retrievalConfig.vectorTopN,
        rerankTopK: knowledgeBase.retrievalConfig.rerankTopK,
        enableRerank: knowledgeBase.retrievalConfig.enableRerank,
        debug: searchDebugEnabled,
      });
      if (
        semanticSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setSearchResults(response.items);
        setSearchFallback(response.rerankFallback?.used ? response.rerankFallback : null);
        setSearchDebug(response.debug ?? null);
      }
    } catch (err) {
      if (
        semanticSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setError(errorMessage(err, '知识库内检索失败'));
        setSearchResults([]);
        setSearchFallback(null);
      }
    } finally {
      if (
        semanticSearchRequestRef.current === request
        && activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
      ) {
        setSearching(false);
      }
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
            <LoadingSkeleton rows={5} columns={4} announce />
          </div>
        </div>
      </WorkspaceShell>
    );
  }

  if (!knowledgeBase) {
    return (
      <WorkspaceShell active="knowledge-bases" categories={categories} expandedIds={expandedIds}>
        <div className="kb-detail-page">
          <div className="empty-state" role="alert">
            <p>{error || '知识库不存在或无权访问。'}</p>
            <div className="toolbar">
              <button className="secondary-button" type="button" onClick={() => void loadKnowledgeBase()}>
                重试详情
              </button>
              <Link className="secondary-link" to="/knowledge-bases">
                返回知识库列表
              </Link>
            </div>
          </div>
        </div>
      </WorkspaceShell>
    );
  }

  const completedCount = documents.filter((document) => document.status === 'completed').length;
  const failedCount = documents.filter((document) => document.status === 'failed').length;
  const processingCount = documents.filter((document) => !terminalStatuses.includes(document.status)).length;
  const documentMetricsKnown = documents.length > 0 || (!documentsLoading && !documentError);
  const visibility = permissions?.visibility ?? knowledgeBase.visibility ?? 'private';
  const managers = (permissions?.managers ?? []).filter((member) => member.role !== 'owner');
  const permissionMutationBusy = savingVisibility || memberWorkingId !== null;

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
            <KnowledgeBaseEntityActions
              disabled={permissionMutationBusy}
              knowledgeBase={knowledgeBase}
              onDeleted={() => navigate('/knowledge-bases', { replace: true })}
              onUpdated={(updated) => {
                const shouldReloadPermissions = permissions === null;
                permissionRequestRef.current += 1;
                setKnowledgeBase(updated);
                setPermissions((current) => current ? {
                  ...current,
                  visibility: updated.visibility ?? current.visibility,
                } : current);
                if (shouldReloadPermissions) {
                  setPermissionsLoaded(false);
                  setPermissionsLoading(false);
                }
              }}
            />
            {activeTab === 'overview' && (
              completedCount > 0 ? (
                <button type="button" onClick={handleStartChat}>基于此知识库提问</button>
              ) : documentsLoading ? (
                <button type="button" disabled>检查文档中...</button>
              ) : documentError ? (
                <button type="button" onClick={() => void loadDocumentSummary()}>重试文档摘要</button>
              ) : documents.length === 0 ? (
                <Link className="button-link" to={`/knowledge-bases/${knowledgeBase.id}/documents?intent=upload`}>
                  上传文档
                </Link>
              ) : processingCount > 0 ? (
                <Link className="button-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
                  查看处理进度
                </Link>
              ) : (
                <Link className="button-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
                  处理失败文档
                </Link>
              )
            )}
          </div>
        </header>

        <KnowledgeBaseSectionNav active={activeTab} knowledgeBaseId={knowledgeBase.id} />

        {error && <p className="error-text" role="alert">{error}</p>}

        {activeTab === 'overview' && (
          <>
            <div className="summary-grid detail-summary">
              <MetricCard label="文档总数" value={documentMetricsKnown ? documents.length : '--'} />
              <MetricCard label="已完成" value={documentMetricsKnown ? completedCount : '--'} />
              <MetricCard label="处理中" value={documentMetricsKnown ? processingCount : '--'} />
              <MetricCard label="失败文档" value={documentMetricsKnown ? failedCount : '--'} tone="danger" />
            </div>

            <div className="detail-grid">
          <section className="panel detail-main-panel">
            <div className="panel-header">
              <h2>基础信息</h2>
              <span className="muted-text">知识库概览</span>
            </div>
            <div className="detail-info-grid">
              <InfoItem label="分类" value={categoryName} />
              <InfoItem label="更新时间" value={formatDateTime(knowledgeBase.updatedAt)} />
              <InfoItem label="创建时间" value={formatDateTime(knowledgeBase.createdAt)} />
              <InfoItem label="最后更新人" value={knowledgeBase.updatedBy?.displayName || knowledgeBase.updatedBy?.username || '未知'} />
              <InfoItem label="浏览量" value={formatOptionalCount(knowledgeBase.viewCount)} />
              <InfoItem label="问答数" value={formatOptionalCount(knowledgeBase.questionCount)} />
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
                  <h2>最近文档</h2>
                  <Link className="secondary-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
                    查看全部
                  </Link>
                </div>
                <div className="document-status-list">
                  {documentsLoading ? (
                    <LoadingSkeleton rows={3} columns={2} compact announce />
                  ) : documentError ? (
                    <div className="empty-state" role="alert">
                      <p>{documentError}</p>
                    </div>
                  ) : documents.length === 0 ? (
                    <div className="empty-state">还没有文档。</div>
                  ) : (
                    documents.slice(0, 6).map((document) => (
                      <article className="document-status-item" key={document.id}>
                        <div>
                          <strong>{document.filename}</strong>
                          <span>{formatBytes(document.fileSize)} · {document.fileType}</span>
                        </div>
                        <span className={`status-pill status-${statusClass(document.status)}`}>
                          {documentStatusLabel(document.status)}
                        </span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}

        {activeTab === 'qa' && (
          <section className="panel kb-qa-panel">
            <div className="panel-header">
              <h2>AI 问答</h2>
              <span className="muted-text">{completedCount} 个文档可用</span>
            </div>
            <div className="kb-qa-panel__body">
              {documentsLoading ? (
                <LoadingSkeleton rows={3} columns={2} announce />
              ) : documentError ? (
                <div className="empty-state" role="alert">
                  <p>{documentError}</p>
                  <button className="secondary-button" type="button" onClick={() => void loadDocumentSummary()}>
                    重试文档摘要
                  </button>
                </div>
              ) : completedCount > 0 ? (
                <button type="button" onClick={handleStartChat}>基于此知识库提问</button>
              ) : documents.length === 0 ? (
                <Link className="button-link" to={`/knowledge-bases/${knowledgeBase.id}/documents?intent=upload`}>
                  先导入文档
                </Link>
              ) : (
                <Link className="button-link" to={`/knowledge-bases/${knowledgeBase.id}/documents`}>
                  查看文档处理状态
                </Link>
              )}
            </div>
          </section>
        )}

        {activeTab === 'settings' && (
          <div className="detail-grid kb-settings-grid">

          <section className="panel">
            <div className="panel-header">
              <h2>成员权限</h2>
              <span className="muted-text">管理成员及其角色</span>
            </div>
            <div className="permission-panel-body">
              {permissionsLoading ? (
                <LoadingSkeleton rows={4} columns={2} compact announce />
              ) : permissionError ? (
                <div className="empty-state" role="alert">
                  <p>{permissionError}</p>
                  <button className="secondary-button" type="button" onClick={() => void loadPermissions()}>
                    重试成员权限
                  </button>
                </div>
              ) : permissions ? (
                <>
                  <label>
                    可见性
                    <select
                      value={visibility}
                      onChange={(event) => void handleVisibilityChange(event.target.value as 'private' | 'public')}
                      disabled={savingVisibility || Boolean(memberWorkingId)}
                    >
                      <option value="private">私有</option>
                      <option value="public">公开</option>
                    </select>
                  </label>
                  <PermissionMemberCard member={{ ...permissions.owner, role: 'owner' }} title="所有者" />
                  <form className="member-search-form" onSubmit={handleUserSearch}>
                    <input
                      aria-label="搜索用户"
                      placeholder="按用户名或显示名搜索"
                      value={memberQuery}
                      onChange={(event) => setMemberQuery(event.target.value)}
                      disabled={savingVisibility || Boolean(memberWorkingId)}
                    />
                    <select
                      aria-label="新增成员角色"
                      value={memberRole}
                      onChange={(event) => setMemberRole(event.target.value as MemberRole)}
                      disabled={savingVisibility || Boolean(memberWorkingId)}
                    >
                      <option value="member">成员</option>
                      <option value="manager">管理员</option>
                    </select>
                    <button
                      aria-label="搜索"
                      type="submit"
                      disabled={savingVisibility || Boolean(memberWorkingId) || !memberQuery.trim()}
                    >
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
                            disabled={savingVisibility || Boolean(memberWorkingId) || user.id === permissions.owner.id}
                          >
                            {memberWorkingId === user.id ? '添加中...' : `设为${roleLabel(memberRole)}`}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  <PermissionList
                    title="管理员"
                    members={managers}
                    workingId={memberWorkingId}
                    disabled={permissionMutationBusy}
                    onDelete={openMemberDelete}
                    onRoleChange={handleUpdateMemberRole}
                  />
                  <PermissionList
                    title="成员"
                    members={permissions.members}
                    emptyText="暂无成员。"
                    workingId={memberWorkingId}
                    disabled={permissionMutationBusy}
                    onDelete={openMemberDelete}
                    onRoleChange={handleUpdateMemberRole}
                  />
                </>
              ) : null}
            </div>
          </section>

          <section className="panel detail-main-panel">
            <div className="panel-header">
              <h2>检索配置</h2>
              <span className="muted-text">控制召回范围与结果排序</span>
            </div>
            <RetrievalConfigGrid config={knowledgeBase.retrievalConfig} />
          </section>

          <section className="panel detail-main-panel semantic-search-panel">
            <div className="panel-header">
              <h2>检索测试</h2>
              <span className="muted-text">验证当前知识库能否找到相关内容</span>
            </div>
            <div className="semantic-search-body">
              <form className="semantic-search-form" onSubmit={handleSemanticSearch}>
                <input
                  aria-label="知识库内检索问题"
                  placeholder="输入问题，测试当前知识库召回片段"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <button aria-label="检索" type="submit" disabled={!searchQuery.trim()}>
                  {searching ? '检索中...' : '检索'}
                </button>
                <label className="semantic-debug-toggle">
                  <input
                    checked={searchDebugEnabled}
                    onChange={(event) => setSearchDebugEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  显示检索调试信息
                </label>
              </form>

              <RerankFallbackNotice fallback={searchFallback} />

              {searchDebugEnabled && searchDebug && <SearchDebugPanel debug={searchDebug} />}

              {searchResults.length === 0 ? (
                <div className="empty-state">暂无检索结果。完成文档处理后可在这里测试召回片段。</div>
              ) : (
                <div className="semantic-result-list">
                  {searchResults.map((result) => (
                    <article className="semantic-result-item" key={result.chunkId}>
                      <header>
                        <strong>{result.filename}</strong>
                        <span>
                          相关度 {formatScore(result.vectorScore)}
                          {result.rerankScore !== null && result.rerankScore !== undefined
                            ? ` · 排序分 ${formatScore(result.rerankScore)}`
                            : ' · 未精排'}
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

          </div>
        )}
      </div>
      {memberDeleteTarget && (
        <ConfirmDialog
          busy={memberWorkingId === memberDeleteTarget.id}
          confirmLabel="移除成员"
          description={`移除“${memberDeleteTarget.displayName || memberDeleteTarget.username}”后，该成员将无法继续访问此知识库。`}
          error={memberDeleteError}
          onCancel={() => {
            setMemberDeleteTarget(null);
            setMemberDeleteError('');
          }}
          onConfirm={() => void handleDeleteMember()}
          title="移除成员"
        />
      )}
    </WorkspaceShell>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: number | string; tone?: 'danger' }) {
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
        <span>向量召回数量</span>
        <strong>{config.vectorTopN}</strong>
      </div>
      <div className="stat-card">
        <span>精排候选数量</span>
        <strong>{config.rerankTopK}</strong>
      </div>
      <div className="stat-card">
        <span>最低相关度</span>
        <strong>{config.scoreThreshold}</strong>
      </div>
      <div className="stat-card">
        <span>启用精排</span>
        <small>{config.enableRerank ? '开启' : '关闭'}</small>
      </div>
    </div>
  );
}

function SearchDebugPanel({ debug }: { debug: KnowledgeBaseSearchDebug }) {
  return (
    <section aria-label="检索调试信息" className="semantic-debug-panel">
      <header>
        <div>
          <strong>检索调试</strong>
          <span>查询：{debug.rewrittenQuery || debug.query}</span>
        </div>
        <span className={`debug-stage-status is-${debug.rerankStage.status}`}>
          {retrievalStageStatusLabel(debug.rerankStage.status)}
        </span>
      </header>
      <div className="semantic-debug-grid">
        <section>
          <h3>向量召回</h3>
          {debug.vectorStage.items.length === 0 ? (
            <p className="muted-text">无候选片段</p>
          ) : (
            <ol>
              {debug.vectorStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank} {item.filename}</strong>
                  <span>向量分 {formatScore(item.vectorScore)}</span>
                  {item.pageNumber !== null && <span>第 {item.pageNumber} 页</span>}
                  <p>{item.content}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section>
          <h3>精排阶段</h3>
          <p className="muted-text">状态：{retrievalStageStatusLabel(debug.rerankStage.status)} · 输入 {debug.rerankStage.input.length} 条</p>
          {debug.rerankStage.input.length > 0 && (
            <ol aria-label="精排输入映射">
              {debug.rerankStage.input.map((item) => (
                <li key={`${item.chunkId}-input`}>
                  <strong>候选 #{item.rank}</strong>
                  {item.pageNumber !== null && <span>第 {item.pageNumber} 页</span>}
                </li>
              ))}
            </ol>
          )}
          {debug.rerankStage.output.length > 0 && (
            <ol>
              {debug.rerankStage.output.map((item) => (
                <li key={item.chunkId}>
                  <strong>精排 #{item.rank}</strong>
                  <span>精排分 {item.rerankScore === null ? '无' : formatScore(item.rerankScore)}</span>
                  {item.pageNumber !== null && <span>第 {item.pageNumber} 页</span>}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section>
          <h3>最终结果</h3>
          {debug.finalStage.items.length === 0 ? (
            <p className="muted-text">阈值过滤后没有可用片段</p>
          ) : (
            <ol>
              {debug.finalStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>结果 #{item.rank}</strong>
                  {item.pageNumber !== null && <span>第 {item.pageNumber} 页</span>}
                  <span>
                    向量分 {formatScore(item.vectorScore)} · 精排分 {item.rerankScore === null ? '无' : formatScore(item.rerankScore)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}

function retrievalStageStatusLabel(status: KnowledgeBaseSearchDebug['rerankStage']['status']): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'disabled':
      return '未启用';
    case 'fallback':
      return '已降级';
  }
}

function PermissionList({
  title,
  members,
  disabled = false,
  emptyText = '暂无成员',
  workingId,
  onDelete,
  onRoleChange,
}: {
  title: string;
  members: PermissionMember[];
  disabled?: boolean;
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
            working={disabled || workingId === member.id}
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
        <small>{member.username} · {roleLabel(member.role)}</small>
      </div>
      {mutable && (
        <div className="permission-member-actions">
          <select
            aria-label={`修改 ${name} 的角色`}
            value={member.role}
            disabled={working}
            onChange={(event) => onRoleChange?.(member, event.target.value as MemberRole)}
          >
            <option value="manager">管理员</option>
            <option value="member">成员</option>
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

function documentStatusLabel(status: DocumentStatus): string {
  const labels: Record<DocumentStatus, string> = {
    uploaded: '已上传',
    parsing: '解析中',
    chunking: '切分中',
    embedding: '向量化',
    completed: '已完成',
    failed: '失败',
  };
  return labels[status];
}

function roleLabel(role: PermissionMember['role'] | MemberRole): string {
  const labels = {
    owner: '所有者',
    manager: '管理员',
    member: '成员',
  } as const;
  return labels[role];
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

function formatOptionalCount(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : '--';
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
  return getErrorMessage(err, fallback);
}

function normalizeDetailTab(value: string | null): Exclude<KnowledgeBaseSection, 'documents'> {
  if (value === 'qa' || value === 'settings') {
    return value;
  }
  return 'overview';
}
