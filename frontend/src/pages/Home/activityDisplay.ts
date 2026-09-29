import type { ActivityItemResponse } from '../../types/api';

export type ActivityItem = {
  key: string;
  kind: 'session' | 'knowledgeBase' | 'document' | 'member';
  title: string;
  context: string;
  at: string;
  to: string;
};

/**
 * Copy for the recorded actions in `GET /activities`.
 *
 * The action strings are a closed set defined by the backend
 * (`service.Activity*`); an unknown one falls back to the resource type rather
 * than rendering a raw identifier.
 */
export const actionLabels: Record<string, string> = {
  'knowledgeBase.created': '创建了知识库',
  'knowledgeBase.deleted': '删除了知识库',
  'knowledgeBase.restored': '恢复了知识库',
  'document.uploaded': '导入了文档',
  'document.deleted': '删除了文档',
  'document.restored': '恢复了文档',
  'document.moved': '移动了文档',
  'document.cancelled': '取消了文档处理',
  'member.added': '添加了成员',
  'member.roleChanged': '调整了成员角色',
  'member.removed': '移除了成员',
  'chatSession.deleted': '删除了会话',
  'chatSession.restored': '恢复了会话',
  'admin.user.created': '创建了用户',
  'admin.user.updated': '更新了用户',
  'admin.user.disabled': '禁用了用户',
  'admin.user.enabled': '启用了用户',
  'kb.ownership_transferred': '转移了知识库所有权',
  'admin.user.passwordReset': '重置了用户密码',
  'admin.user.roleChanged': '调整了用户角色',
};

const resourceLabels: Record<ActivityItemResponse['resourceType'], string> = {
  knowledgeBase: '知识库',
  document: '文档',
  chatSession: '问答会话',
  member: '成员',
  user: '用户',
};

const kindByResource: Record<ActivityItemResponse['resourceType'], ActivityItem['kind']> = {
  knowledgeBase: 'knowledgeBase',
  document: 'document',
  chatSession: 'session',
  member: 'member',
  // Account entries reuse the person icon; there is no dedicated user kind.
  user: 'member',
};

export function activityToItem(activity: ActivityItemResponse): ActivityItem {
  const label = actionLabels[activity.action] ?? resourceLabels[activity.resourceType] ?? '更新';
  const context = activity.knowledgeBaseName
    ? `${label} · ${activity.knowledgeBaseName}`
    : label;

  return {
    key: activity.id,
    kind: kindByResource[activity.resourceType] ?? 'knowledgeBase',
    title: activity.resourceName || resourceLabels[activity.resourceType] || '未命名',
    context,
    at: activity.createdAt,
    to: activityHref(activity),
  };
}

/**
 * Deleted resources have no page to open, so those entries point at the place
 * the user can act on them instead of at a route that would 404.
 */
function activityHref(activity: ActivityItemResponse): string {
  const removed = activity.action.endsWith('.deleted');

  switch (activity.resourceType) {
    case 'knowledgeBase':
      return removed ? '/knowledge-bases' : `/knowledge-bases/${activity.resourceId}`;
    case 'document': {
      if (!activity.knowledgeBaseId) return '/documents';
      const base = `/knowledge-bases/${activity.knowledgeBaseId}/documents`;
      return removed ? base : `${base}?documentId=${encodeURIComponent(activity.resourceId)}`;
    }
    case 'chatSession':
      return removed ? '/chat' : `/chat/${activity.resourceId}`;
    case 'member':
      return activity.knowledgeBaseId
        ? `/knowledge-bases/${activity.knowledgeBaseId}/settings`
        : '/knowledge-bases';
    case 'user':
      // Only system administrators record these; the entry leads back to the
      // page where the account can be acted on again.
      return '/admin/users';
    default:
      return '/home';
  }
}
