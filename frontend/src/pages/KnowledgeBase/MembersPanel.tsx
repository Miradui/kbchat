import { Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import {
  addKnowledgeBaseMember,
  deleteKnowledgeBaseMember,
  getKnowledgeBasePermissions,
  searchUsers,
  updateKnowledgeBaseMember,
  updateKnowledgeBasePermissions,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Field, SearchInput, Select } from '../../components/ui/Field';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import type {
  KnowledgeBase,
  KnowledgeBasePermissionResponse,
  MemberRole,
  PermissionMember,
  UserSummary,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

const roleLabels = { owner: '所有者', manager: '管理员', member: '成员' } as const;

type MembersPanelProps = {
  knowledgeBase: KnowledgeBase;
  onVisibilityChange: (visibility: 'private' | 'public') => void;
};

export function MembersPanel({ knowledgeBase, onVisibilityChange }: MembersPanelProps) {
  const toast = useToast();
  const mutation = useEntityMutation();
  const [permissions, setPermissions] = useState<KnowledgeBasePermissionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberRole, setMemberRole] = useState<MemberRole>('member');
  const [userResults, setUserResults] = useState<UserSummary[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PermissionMember | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const requestRef = useRef(0);
  const userSearchRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await getKnowledgeBasePermissions(knowledgeBase.id);
      if (requestRef.current === request) {
        setPermissions(response);
        setError('');
        onVisibilityChange(response.visibility);
      }
    } catch (caught) {
      if (requestRef.current === request) {
        setPermissions(null);
        setError(getErrorMessage(caught, '成员权限加载失败'));
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
    // `onVisibilityChange` is a setter from the page; re-running on its identity
    // would refetch permissions on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeBase.id]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
      userSearchRef.current += 1;
    };
  }, [load]);

  async function reload() {
    const response = await getKnowledgeBasePermissions(knowledgeBase.id);
    setPermissions(response);
    onVisibilityChange(response.visibility);
  }

  async function handleUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = memberQuery.trim();
    if (!query) {
      userSearchRef.current += 1;
      setUserResults([]);
      return;
    }

    const request = ++userSearchRef.current;
    setSearchingUsers(true);
    try {
      const response = await searchUsers(query);
      if (userSearchRef.current === request) setUserResults(response.items);
    } catch (caught) {
      if (userSearchRef.current === request) {
        setUserResults([]);
        toast.error(getErrorMessage(caught, '用户搜索失败'));
      }
    } finally {
      if (userSearchRef.current === request) setSearchingUsers(false);
    }
  }

  function runMemberAction(key: string, action: () => Promise<void>, failure: string) {
    void mutation.run(key, async () => {
      try {
        await action();
        await reload();
      } catch (caught) {
        toast.error(getErrorMessage(caught, failure));
      }
    });
  }

  const visibility = permissions?.visibility ?? knowledgeBase.visibility ?? 'private';
  const managers = (permissions?.managers ?? []).filter((member) => member.role !== 'owner');

  return (
    <>
      <section className="ui-panel">
        <div className="ui-panel__head">
          <h2>成员与可见性</h2>
          <span className="ui-panel__head-note">管理谁能看到这个知识库</span>
        </div>
        <div className="ui-panel__body" style={{ display: 'grid', gap: 'var(--s-4)' }}>
          {loading && !permissions ? (
            <LoadingSkeleton announce compact columns={2} rows={4} />
          ) : error ? (
            <div className="ui-inline-error" role="alert">
              <span>{error}</span>
              <Button variant="link" onClick={() => void load()}>重试</Button>
            </div>
          ) : permissions ? (
            <>
              <Field
                hint="可见性目前只影响展示，不改变文档和问答的访问控制。"
                label="可见性"
              >
                <Select
                  disabled={mutation.anyPending}
                  onChange={(event) => {
                    const next = event.target.value as 'private' | 'public';
                    if (next === visibility) return;
                    runMemberAction('visibility', async () => {
                      await updateKnowledgeBasePermissions(knowledgeBase.id, next);
                    }, '可见性更新失败');
                  }}
                  value={visibility}
                >
                  <option value="private">私有</option>
                  <option value="public">公开</option>
                </Select>
              </Field>

              <div className="member-list">
                <h3>所有者</h3>
                <MemberRow member={{ ...permissions.owner, role: 'owner' }} />
              </div>

              <form className="member-search" onSubmit={(event) => void handleUserSearch(event)} role="search">
                <SearchInput
                  aria-label="搜索用户"
                  icon={<Search aria-hidden="true" />}
                  onChange={(event) => setMemberQuery(event.target.value)}
                  placeholder="按用户名或显示名搜索"
                  value={memberQuery}
                />
                <Select
                  aria-label="新增成员角色"
                  onChange={(event) => setMemberRole(event.target.value as MemberRole)}
                  value={memberRole}
                >
                  <option value="member">成员</option>
                  <option value="manager">管理员</option>
                </Select>
                <Button
                  disabled={!memberQuery.trim()}
                  loading={searchingUsers}
                  loadingLabel="搜索中"
                  type="submit"
                  variant="secondary"
                >
                  搜索
                </Button>
              </form>

              {userResults.length > 0 && (
                <div className="member-list">
                  <h3>搜索结果</h3>
                  {userResults.map((user) => (
                    <div className="member-row" key={user.id}>
                      <UserInline user={user} />
                      <Button
                        disabled={mutation.isPending(user.id) || user.id === permissions.owner.id}
                        loading={mutation.isPending(user.id)}
                        loadingLabel="添加中"
                        variant="secondary"
                        onClick={() => runMemberAction(user.id, async () => {
                          await addKnowledgeBaseMember(knowledgeBase.id, user.id, memberRole);
                          toast.success('成员添加成功');
                        }, '成员添加失败')}
                      >
                        设为{roleLabels[memberRole]}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <MemberGroup
                emptyText="暂无管理员。"
                isPending={mutation.isPending}
                members={managers}
                onDelete={(member) => {
                  setDeleteError('');
                  setDeleteTarget(member);
                }}
                onRoleChange={(member, role) => runMemberAction(member.id, async () => {
                  await updateKnowledgeBaseMember(knowledgeBase.id, member.id, role);
                  toast.success('成员角色已更新');
                }, '成员角色更新失败')}
                title="管理员"
              />

              <MemberGroup
                emptyText="暂无成员。"
                isPending={mutation.isPending}
                members={permissions.members}
                onDelete={(member) => {
                  setDeleteError('');
                  setDeleteTarget(member);
                }}
                onRoleChange={(member, role) => runMemberAction(member.id, async () => {
                  await updateKnowledgeBaseMember(knowledgeBase.id, member.id, role);
                  toast.success('成员角色已更新');
                }, '成员角色更新失败')}
                title="成员"
              />
            </>
          ) : null}
        </div>
      </section>

      {deleteTarget && (
        <ConfirmDialog
          busy={mutation.isPending(`remove-${deleteTarget.id}`)}
          confirmLabel="移除成员"
          description={`移除“${deleteTarget.displayName || deleteTarget.username}”后，该成员将无法继续访问此知识库。`}
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError('');
          }}
          onConfirm={() => {
            const target = deleteTarget;
            void mutation.run(`remove-${target.id}`, async () => {
              try {
                await deleteKnowledgeBaseMember(knowledgeBase.id, target.id);
                setDeleteTarget(null);
                toast.success('成员移除成功');
                await reload();
              } catch (caught) {
                setDeleteError(getErrorMessage(caught, '成员移除失败'));
              }
            });
          }}
          title="移除成员"
        />
      )}
    </>
  );
}

function MemberGroup({
  title,
  members,
  emptyText,
  isPending,
  onDelete,
  onRoleChange,
}: {
  title: string;
  members: PermissionMember[];
  emptyText: string;
  isPending: (key: string) => boolean;
  onDelete: (member: PermissionMember) => void;
  onRoleChange: (member: PermissionMember, role: MemberRole) => void;
}) {
  return (
    <div className="member-list">
      <h3>{title}</h3>
      {members.length === 0 ? (
        <p className="ui-field__hint">{emptyText}</p>
      ) : (
        members.map((member) => (
          <MemberRow
            isPending={isPending(member.id)}
            key={member.id}
            member={member}
            onDelete={onDelete}
            onRoleChange={onRoleChange}
          />
        ))
      )}
    </div>
  );
}

function MemberRow({
  member,
  isPending = false,
  onDelete,
  onRoleChange,
}: {
  member: PermissionMember;
  isPending?: boolean;
  onDelete?: (member: PermissionMember) => void;
  onRoleChange?: (member: PermissionMember, role: MemberRole) => void;
}) {
  const mutable = member.role !== 'owner';
  return (
    <div className="member-row">
      <UserInline user={member} />
      {mutable ? (
        <div className="member-row__actions">
          <Select
            aria-label={`修改 ${member.displayName || member.username} 的角色`}
            disabled={isPending}
            onChange={(event) => onRoleChange?.(member, event.target.value as MemberRole)}
            value={member.role}
          >
            <option value="manager">管理员</option>
            <option value="member">成员</option>
          </Select>
          <Button disabled={isPending} variant="ghost" onClick={() => onDelete?.(member)}>移除</Button>
        </div>
      ) : (
        <span className="ui-badge ui-badge--neutral ui-badge--plain">{roleLabels.owner}</span>
      )}
    </div>
  );
}

function UserInline({ user }: { user: UserSummary }) {
  const name = user.displayName || user.username;
  return (
    <span className="ui-user-inline">
      <span className="ui-avatar">
        {user.avatarUrl ? <img alt="" src={user.avatarUrl} /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}
      </span>
      <span>
        <strong>{name}</strong>
        <small>{user.username}</small>
      </span>
    </span>
  );
}
