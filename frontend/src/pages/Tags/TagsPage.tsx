import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
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
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { SearchInput } from '../../components/ui/Field';
import { AppShell } from '../../layouts/AppShell';
import type { KnowledgeBaseTag } from '../../types/api';
import { formatCount, formatRelativeTime } from '../../utils/format';
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
      setTags((items) => items.map((item) => (item.id === updated.id ? updated : item)));
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
    <AppShell
      active="tags"
      breadcrumbs={[{ label: '标签' }]}
      topbarActions={
        <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditor({})}>新建标签</Button>
      }
    >
      <div className="tags-page">
        <div className="ui-toolbar">
          <SearchInput
            aria-label="搜索标签"
            icon={<Search aria-hidden="true" />}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标签名称"
            value={query}
          />
          <span className="ui-muted">{visibleTags.length} 个标签</span>
        </div>

        <div className="ui-panel">
          {loading ? (
            <LoadingSkeleton announce columns={3} rows={5} />
          ) : loadError ? (
            <ErrorState
              description={loadError}
              onRetry={() => setReloadKey((value) => value + 1)}
              title="标签加载失败"
            />
          ) : tags.length === 0 ? (
            <EmptyState
              action={<Button onClick={() => setEditor({})}>新建标签</Button>}
              description="标签用于给知识库分组和筛选，一个知识库可以有多个标签。"
              title="还没有标签"
            />
          ) : visibleTags.length === 0 ? (
            <EmptyState description="调整关键词，或创建一个新标签。" title="没有匹配的标签" />
          ) : (
            <div className="ui-table-wrap">
              <table className="ui-table tags-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>使用量</th>
                    <th>更新</th>
                    <th className="ui-table__actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTags.map((tag) => (
                    <tr key={tag.id}>
                      <td className="ui-table__primary" data-label="名称">{tag.name}</td>
                      <td data-label="使用量">
                        {tag.knowledgeBaseCount === undefined ? (
                          <span className="ui-muted">—</span>
                        ) : (
                          `${formatCount(tag.knowledgeBaseCount)} 个知识库`
                        )}
                      </td>
                      <td data-label="更新">{formatRelativeTime(tag.updatedAt)}</td>
                      <td className="ui-table__actions" data-label="操作">
                        <div>
                          <IconButton label={`编辑 ${tag.name}`} onClick={() => setEditor({ tag })}>
                            <Pencil aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            label={`删除 ${tag.name}`}
                            tone="danger"
                            onClick={() => {
                              setDeleteError('');
                              setDeleteTarget(tag);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

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
            description={
              deleteTarget.knowledgeBaseCount
                ? `“${deleteTarget.name}”正被 ${formatCount(deleteTarget.knowledgeBaseCount)} 个知识库使用（含回收站中的知识库），需要先解除引用才能删除。`
                : `确认删除“${deleteTarget.name}”？正在被知识库使用的标签无法删除。`
            }
            error={deleteError}
            onCancel={() => {
              setDeleteError('');
              setDeleteTarget(null);
            }}
            onConfirm={() => void deleteTag()}
            title="删除标签"
          />
        )}
      </div>
    </AppShell>
  );
}
