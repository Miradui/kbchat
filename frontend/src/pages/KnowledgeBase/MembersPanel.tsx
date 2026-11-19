import { Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { UserAvatar } from '../../components/UserAvatar';
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
import { hasCapability, memberRoles, roleHints, roleLabels } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';

type MembersPanelProps = {
  knowledgeBase: KnowledgeBase;
  onVisibilityChange: (visibility: 'private' | 'public') => void;
};

/**
 * A write that took effect but left the list stale. Reported apart from the write
 * failure so the user does not repeat a change that already happened.
 */
const MEMBER_REFRESH_FAILED = '成员列表刷新失败，请重试。';

export function MembersPanel({ knowledgeBase, onVisibilityChange }: MembersPanelProps) {
  const toast = useToast();
  const mutation = useEntityMutation();
  const visibilityId = useId();
  const [permissions, setPermissions] = useState<KnowledgeBasePermissionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  // Viewer by default: the least access is the safe default for someone being added,
  // and raising a role afterwards is one click.
  const [memberRole, setMemberRole] = useState<MemberRole>('viewer');
  const [userResults, setUserResults] = useState<UserSummary[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [usersSearched, setUsersSearched] = useState(false);
  const [userSearchError, setUserSearchError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PermissionMember | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const requestRef = useRef(0);
  const userSearchRef = useRef(0);
  const searchingUsersRef = useRef(false);

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

  /**
   * Refresh the member list after a write, reporting whether it worked.
   *
   * The write and the refresh fail separately. Folding them together told the user
   * "成员添加失败" for a write that had already succeeded, and the retry then failed
   * as a duplicate; a failed refresh after a removal was invisible because it was
   * written into a dialog that had already closed.
   */
  async function reload(): Promise<boolean> {
    try {
      const response = await getKnowledgeBasePermissions(knowledgeBase.id);
      setPermissions(response);
      onVisibilityChange(response.visibility);
      return true;
    } catch {
      return false;
    }
  }

  async function handleUserSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = memberQuery.trim();
    if (!query || searchingUsersRef.current) return;

    const request = ++userSearchRef.current;
    searchingUsersRef.current = true;
    setSearchingUsers(true);
    setUsersSearched(false);
    setUserSearchError('');
    setUserResults([]);
    try {
      const response = await searchUsers(query);
      if (userSearchRef.current === request) {
        setUserResults(response.items);
        setUsersSearched(true);
      }
    } catch (caught) {
      if (userSearchRef.current === request) {
        setUserResults([]);
        setUserSearchError(getErrorMessage(caught, '用户搜索失败，请重试'));
      }
    } finally {
      if (userSearchRef.current === request) {
        searchingUsersRef.current = false;
        setSearchingUsers(false);
      }
    }
  }

  function changeMemberQuery(value: string) {
    userSearchRef.current++;
    searchingUsersRef.current = false;
    setMemberQuery(value);
    setSearchingUsers(false);
    setUserResults([]);
    setUsersSearched(false);
    setUserSearchError('');
  }

  function runMemberAction(key: string, action: () => Promise<void>, failure: string) {
    void mutation.run(key, async () => {
      try {
        await action();
      } catch (caught) {
        toast.error(getErrorMessage(caught, failure));
        return;
      }
      if (!await reload()) {
        toast.error(MEMBER_REFRESH_FAILED);
      }
    });
  }

  const visibility = permissions?.visibility ?? knowledgeBase.visibility ?? 'private';
  const managers = (permissions?.managers ?? []).filter((member) => member.role !== 'owner');
  // This panel is only reachable with members.read, so a caller who lacks
  // members.write is a manager reading a base they cannot administer -- rare, but the
  // read and the write are separate capabilities and the UI should not imply
  // otherwise. Every control below is rendered read-only in that case rather than
  // hidden, because the member list is the point of the panel.
  const canManageMembers = hasCapability(knowledgeBase, 'members.write');

  return (
    <>
      <section className="ui-panel">
        <div className="ui-panel__head">
          <h2>成员与可见性</h2>
          <span className="ui-panel__head-note">管理谁能看到这个知识库</span>
        </div>
        <div className="ui-panel__body ui-panel__stack">
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
                htmlFor={visibilityId}
                hint="可见性目前只影响展示，不改变文档和问答的访问控制。"
                label="可见性"
              >
                <Select
                  id={visibilityId}
                  disabled={mutation.anyPending || !canManageMembers}
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

              {!canManageMembers && (
                <p className="ui-field__hint" role="note">
                  你可以查看成员，但没有变更成员和可见性的权限。
                </p>
              )}

              {canManageMembers && (
              <form className="member-search" onSubmit={(event) => void handleUserSearch(event)} role="search">
                <SearchInput
                  aria-label="搜索用户"
                  icon={<Search aria-hidden="true" />}
                  onChange={(event) => changeMemberQuery(event.target.value)}
                  placeholder="按用户名或显示名搜索"
                  value={memberQuery}
                />
                <Select
                  aria-label="新增成员角色"
                  disabled={!canManageMembers}
                  onChange={(event) => setMemberRole(event.target.value as MemberRole)}
                  value={memberRole}
                >
                  {memberRoles.map((role) => (
                    <option key={role} value={role}>{roleLabels[role]}</option>
                  ))}
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
              )}

              {canManageMembers && <p className="ui-field__hint">{roleHints[memberRole]}</p>}
              {canManageMembers && (
                <p className={searchingUsers || usersSearched ? 'ui-field__hint' : 'sr-only'} role="status">
                  {searchingUsers ? '正在搜索用户…' : !usersSearched ? '' : userResults.length === 0
                    ? '没有找到匹配的用户，请调整关键词。'
                    : `找到 ${userResults.length} 位用户。`}
                </p>
              )}
              {userSearchError && <p className="ui-inline-error" role="alert">{userSearchError}</p>}

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
                editable={canManageMembers}
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
                editable={canManageMembers}
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
                title="成员及协作者"
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
              } catch (caught) {
                setDeleteError(getErrorMessage(caught, '成员移除失败'));
                return;
              }
              // Refresh before closing: the dialog owns the removal error, and a
              // failed refresh must not be attributed to a removal that worked.
              const refreshed = await reload();
              setDeleteTarget(null);
              toast.success('成员移除成功');
              if (!refreshed) {
                toast.error(MEMBER_REFRESH_FAILED);
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
  editable,
  isPending,
  onDelete,
  onRoleChange,
}: {
  title: string;
  members: PermissionMember[];
  emptyText: string;
  editable: boolean;
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
            editable={editable}
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
  editable = false,
  isPending = false,
  onDelete,
  onRoleChange,
}: {
  member: PermissionMember;
  editable?: boolean;
  isPending?: boolean;
  onDelete?: (member: PermissionMember) => void;
  onRoleChange?: (member: PermissionMember, role: MemberRole) => void;
}) {
  // The owner row is never editable regardless of the caller: ownership lives on the
  // knowledge base, and the member endpoints reject it outright.
  const mutable = editable && member.role !== 'owner';
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
            {memberRoles.map((role) => (
              <option key={role} value={role}>{roleLabels[role]}</option>
            ))}
          </Select>
          <Button disabled={isPending} variant="ghost" onClick={() => onDelete?.(member)}>移除</Button>
        </div>
      ) : (
        <span className="ui-badge ui-badge--neutral ui-badge--plain">
          {roleLabels[member.role] ?? member.role}
        </span>
      )}
    </div>
  );
}

function UserInline({ user }: { user: UserSummary }) {
  const name = user.displayName || user.username;
  return (
    <span className="ui-user-inline">
      <UserAvatar url={user.avatarUrl} name={name} />
      <span>
        <strong>{name}</strong>
        <small>{user.username}</small>
      </span>
    </span>
  );
}
