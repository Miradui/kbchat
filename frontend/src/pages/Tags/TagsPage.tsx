import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  listKnowledgeBaseTags,
  updateKnowledgeBaseTag,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type { KnowledgeBaseTag } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { TagDialog } from './TagDialog';

type EditorState = { tag?: KnowledgeBaseTag } | null;

export function TagsPage() {
  const toast = useToast();
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseTag | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    void listKnowledgeBaseTags()
      .then((response) => {
        if (active) setTags(response.items);
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(getErrorMessage(caught, '标签加载失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const visibleTags = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return [...tags]
      .filter((tag) => !keyword || tag.name.toLocaleLowerCase().includes(keyword))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [query, tags]);

  async function saveTag(name: string) {
    if (editor?.tag) {
      const updated = await updateKnowledgeBaseTag(editor.tag.id, { name });
      setTags((items) => items.map((item) => item.id === updated.id ? updated : item));
      toast.success('标签更新成功');
    } else {
      const created = await createKnowledgeBaseTag({ name });
      setTags((items) => [created, ...items]);
      toast.success('标签创建成功');
    }
  }

  async function deleteTag() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteKnowledgeBaseTag(deleteTarget.id);
      setTags((items) => items.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast.success('标签删除成功');
    } catch (caught) {
      setDeleteError(getErrorMessage(caught, '标签删除失败'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <WorkspaceShell active="tags">
      <div className="tags-page">
        <header className="page-header workspace-heading tags-header">
          <div>
            <h1>标签管理</h1>
            <p className="page-description">维护知识库可绑定的标签。</p>
          </div>
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditor({})}>新建标签</Button>
        </header>

        <div className="tags-toolbar">
          <label className="sr-only" htmlFor="tag-search">搜索标签</label>
          <input id="tag-search" placeholder="搜索标签名称" value={query} onChange={(event) => setQuery(event.target.value)} />
          <span>{visibleTags.length} 个标签</span>
        </div>

        {loading ? (
          <LoadingSkeleton announce rows={5} columns={3} />
        ) : loadError ? (
          <ErrorState title="标签加载失败" description={loadError} onRetry={() => setReloadKey((value) => value + 1)} />
        ) : visibleTags.length === 0 ? (
          <EmptyState title="没有匹配的标签" description="调整关键词，或创建一个新标签。" />
        ) : (
          <div className="tags-table-wrap">
            <table className="tags-table">
              <thead><tr><th>名称</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                {visibleTags.map((tag) => (
                  <tr key={tag.id}>
                    <td data-label="名称"><strong>{tag.name}</strong></td>
                    <td data-label="更新时间">{formatDateTime(tag.updatedAt)}</td>
                    <td data-label="操作">
                      <div className="tags-row-actions">
                        <IconButton label={`编辑 ${tag.name}`} onClick={() => setEditor({ tag })}><Pencil aria-hidden="true" /></IconButton>
                        <IconButton label={`删除 ${tag.name}`} tone="danger" onClick={() => { setDeleteError(''); setDeleteTarget(tag); }}><Trash2 aria-hidden="true" /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <TagDialog
          initialName={editor?.tag?.name ?? ''}
          onClose={() => setEditor(null)}
          onSubmit={saveTag}
          open={editor !== null}
          title={editor?.tag ? '编辑标签' : '新建标签'}
        />

        {deleteTarget && (
          <ConfirmDialog
            busy={deleting}
            confirmLabel="删除"
            description={`确认删除“${deleteTarget.name}”？如果仍被知识库引用，后端会拒绝删除。`}
            error={deleteError}
            onCancel={() => { setDeleteError(''); setDeleteTarget(null); }}
            onConfirm={() => void deleteTag()}
            title="删除标签"
          />
        )}
      </div>
    </WorkspaceShell>
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
