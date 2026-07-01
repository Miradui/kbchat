import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  getWorkspacePreference,
  globalSearch,
  listKnowledgeBaseCategories,
} from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  GlobalSearchResult,
  GlobalSearchResultType,
  KnowledgeBaseCategory,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

const resultTypeLabels: Record<GlobalSearchResultType, string> = {
  knowledgeBase: '知识库',
  document: '文档',
  chunk: '内容片段',
};

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const submittedQuery = searchParams.get('q')?.trim() ?? '';
  const [draft, setDraft] = useState(submittedQuery);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [items, setItems] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(submittedQuery);
  }, [submittedQuery]);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ])
      .then(([categoryResponse, preference]) => {
        if (!mounted) {
          return;
        }
        setCategories(categoryResponse.items);
        setExpandedIds(preference.expandedCategoryIds);
      })
      .finally(() => {
        if (mounted) {
          setBootstrapping(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const keyword = submittedQuery.trim();

    if (!keyword) {
      setItems([]);
      setError('');
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    setLoading(true);
    setError('');

    globalSearch(keyword)
      .then((response) => {
        if (mounted) {
          setItems(response.items);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '全局搜索失败'));
          setItems([]);
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
  }, [submittedQuery]);

  const groupedCount = useMemo(() => {
    return items.reduce<Record<GlobalSearchResultType, number>>(
      (acc, item) => {
        acc[item.type] += 1;
        return acc;
      },
      { knowledgeBase: 0, document: 0, chunk: 0 },
    );
  }, [items]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyword = draft.trim();
    if (keyword) {
      setSearchParams({ q: keyword });
    } else {
      setSearchParams({});
    }
  }

  return (
    <WorkspaceShell active="search" categories={categories} expandedIds={expandedIds}>
      <header className="page-header workspace-heading">
        <div>
          <h1>全局搜索</h1>
          <p className="page-description">关键词检索当前用户拥有的知识库、文档和内容片段。</p>
        </div>
      </header>

      <form className="form-panel search-form-panel" onSubmit={handleSubmit}>
        <label>
          搜索关键词
          <input
            autoFocus
            value={draft}
            placeholder="输入知识库、文件名或内容关键词"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="submit">搜索</button>
      </form>

      <div className="summary-grid detail-summary search-summary">
        <MetricCard label="全部结果" value={items.length} />
        <MetricCard label="知识库" value={groupedCount.knowledgeBase} />
        <MetricCard label="文档" value={groupedCount.document} />
        <MetricCard label="内容片段" value={groupedCount.chunk} />
      </div>

      {error && <p className="error-text">{error}</p>}

      <section className="workspace-list-panel search-results-panel">
        <header className="panel-header">
          <div>
            <h2>搜索结果</h2>
            <span className="muted-text">
              {submittedQuery ? `关键词：${submittedQuery}` : '请输入关键词开始搜索'}
            </span>
          </div>
        </header>

        {loading || bootstrapping ? (
          <LoadingSkeleton rows={5} columns={3} />
        ) : !submittedQuery ? (
          <div className="empty-state">输入关键词后会调用后端全局搜索接口。</div>
        ) : items.length === 0 ? (
          <div className="empty-state">没有找到匹配结果。可以尝试更换关键词。</div>
        ) : (
          <div className="search-result-list">
            {items.map((item) => (
              <SearchResultRow item={item} key={`${item.type}-${item.id}`} />
            ))}
          </div>
        )}
      </section>
    </WorkspaceShell>
  );
}

function SearchResultRow({ item }: { item: GlobalSearchResult }) {
  return (
    <article className="search-result-row">
      <span className={`search-type-pill ${item.type}`}>{resultTypeLabels[item.type]}</span>
      <div>
        <Link to={resultLink(item)}>
          <strong>{item.title || item.knowledgeBaseName}</strong>
        </Link>
        <p>{item.snippet || '暂无摘要'}</p>
        <small>
          {item.knowledgeBaseName}
          {item.filename ? ` / ${item.filename}` : ''}
        </small>
      </div>
    </article>
  );
}

function resultLink(item: GlobalSearchResult): string {
  if (item.type === 'knowledgeBase') {
    return `/knowledge-bases/${item.knowledgeBaseId}`;
  }
  return `/knowledge-bases/${item.knowledgeBaseId}/documents`;
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
