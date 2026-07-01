import { FormEvent, useEffect, useMemo, useState } from 'react';

import { ApiError } from '../../api/client';
import {
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  getWorkspacePreference,
  listKnowledgeBaseCategories,
  listKnowledgeBaseTags,
  updateKnowledgeBaseTag,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  KnowledgeBaseCategory,
  KnowledgeBaseTag,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';

type TagFormState = {
  id?: string;
  name: string;
};

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function TagsPage() {
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [form, setForm] = useState<TagFormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseTag | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;

    Promise.all([
      listKnowledgeBaseTags(),
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ])
      .then(([tagResponse, categoryResponse, preference]) => {
        if (!mounted) {
          return;
        }
        setTags(tagResponse.items);
        setCategories(categoryResponse.items);
        setExpandedIds(preference.expandedCategoryIds);
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '标签加载失败'));
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
  }, []);

  const visibleTags = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const sorted = [...tags].sort((left, right) => {
      const updatedDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      return updatedDiff || left.name.localeCompare(right.name, 'zh-CN');
    });
    if (!keyword) {
      return sorted;
    }
    return sorted.filter((tag) => tag.name.toLocaleLowerCase().includes(keyword));
  }, [query, tags]);

  async function reloadTags() {
    const response = await listKnowledgeBaseTags();
    setTags(response.items);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    const name = form.name.trim();
    if (!name) {
      setError('标签名称不能为空');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      if (form.id) {
        await updateKnowledgeBaseTag(form.id, { name });
      } else {
        await createKnowledgeBaseTag({ name });
      }
      setForm(null);
      await reloadTags();
    } catch (err) {
      setError(errorMessage(err, '标签保存失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await deleteKnowledgeBaseTag(deleteTarget.id);
      setDeleteTarget(null);
      await reloadTags();
    } catch (err) {
      setError(errorMessage(err, '标签删除失败'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WorkspaceShell active="tags" categories={categories} expandedIds={expandedIds}>
      <header className="page-header workspace-heading">
        <div>
          <h1>标签管理</h1>
          <p className="page-description">维护知识库标签；知识库创建和编辑时可绑定这些标签。</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => setForm({ name: '' })}>
            + 新建标签
          </button>
        </div>
      </header>

      <div className="summary-grid detail-summary tags-summary">
        <MetricCard label="标签总数" value={tags.length} />
        <MetricCard label="当前筛选" value={visibleTags.length} />
      </div>

      {form && (
        <form className="form-panel workspace-form tag-form-panel" onSubmit={handleSubmit}>
          <div>
            <h2>{form.id ? '编辑标签' : '新建标签'}</h2>
            <p className="page-description">标签名称会提交到当前用户的标签接口；已被知识库引用的标签不能直接删除。</p>
          </div>
          <div className="form-grid">
            <label>
              标签名称
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </label>
          </div>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => setForm(null)} disabled={submitting}>
              取消
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? '保存中...' : '保存标签'}
            </button>
          </div>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}

      <section className="workspace-list-panel tags-panel">
        <header className="panel-header tags-panel-header">
          <div>
            <h2>标签列表</h2>
            <span className="muted-text">只展示后端提供的标签基础字段</span>
          </div>
          <input
            aria-label="搜索标签"
            placeholder="搜索标签名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </header>

        {loading ? (
          <LoadingSkeleton rows={5} columns={4} />
        ) : visibleTags.length === 0 ? (
          <div className="empty-state">当前没有匹配的标签。可以新建标签后在知识库表单中绑定。</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table tags-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>创建时间</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleTags.map((tag) => (
                  <tr key={tag.id}>
                    <td className="table-title" data-label="名称">
                      <span className="tag-management-name">{tag.name}</span>
                    </td>
                    <td data-label="创建时间">{formatDateTime(tag.createdAt)}</td>
                    <td data-label="更新时间">{formatDateTime(tag.updatedAt)}</td>
                    <td data-label="操作">
                      <div className="table-actions">
                        <button className="link-button" type="button" onClick={() => setForm({ id: tag.id, name: tag.name })}>
                          编辑
                        </button>
                        <button className="link-button" type="button" onClick={() => setDeleteTarget(tag)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleteTarget && (
        <ConfirmDialog
          title="删除标签"
          description={`确认删除“${deleteTarget.name}”？如果标签仍被知识库引用，后端会拒绝删除。`}
          confirmLabel="删除"
          busy={submitting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </WorkspaceShell>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
