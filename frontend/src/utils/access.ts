import type { Capability, EffectiveRole, KnowledgeBase, MemberRole } from '../types/api';

/**
 * Client-side reading of the server's capability matrix, used to hide actions the
 * server would answer with 403.
 *
 * This is presentation only. The server checks every request against the same
 * matrix, so a gap here shows a button that fails rather than granting anything.
 * The bias is therefore deliberate in one direction: an unknown role or a missing
 * `capabilities` field denies, because a hidden button a user can ask about is a
 * better failure than a visible one that always errors.
 */

const roleRank: Record<EffectiveRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  owner: 4,
};

export const memberRoles: MemberRole[] = ['viewer', 'editor', 'manager'];

export const roleLabels: Record<EffectiveRole, string> = {
  viewer: '只读成员',
  editor: '编辑成员',
  manager: '管理员',
  owner: '所有者',
};

/**
 * What each role adds, shown next to the role selector. Without it "编辑成员" and
 * "管理员" are two words a person picking a role has no way to choose between.
 */
export const roleHints: Record<MemberRole, string> = {
  viewer: '可以查看文档、检索和问答',
  editor: '还可以上传、修改和下载文档',
  manager: '还可以管理成员、清空回收站和查看问答质量',
};

export function roleAtLeast(role: EffectiveRole | undefined, minimum: EffectiveRole): boolean {
  // An unrecognised value ranks as no access rather than as the lowest role: the
  // realistic source of one is a newer server, and ranking it upward would grant
  // on the strength of a string this build cannot interpret.
  const actual = role ? roleRank[role] : undefined;
  return actual !== undefined && actual >= roleRank[minimum];
}

export function hasCapability(
  knowledgeBase: Pick<KnowledgeBase, 'capabilities'> | null | undefined,
  capability: Capability,
): boolean {
  return knowledgeBase?.capabilities?.includes(capability) ?? false;
}

/**
 * True when the knowledge base was loaded but carries no capability list, which is
 * what an older server returns. Callers that would otherwise hide everything can
 * fall back to showing actions and letting the server refuse.
 */
export function capabilitiesUnknown(
  knowledgeBase: Pick<KnowledgeBase, 'capabilities'> | null | undefined,
): boolean {
  return Boolean(knowledgeBase) && knowledgeBase?.capabilities === undefined;
}

/**
 * `hasCapability` unless the server never said, in which case the action stays
 * visible. Used for the entry points that exist in every build -- hiding document
 * upload against an older server would look like the feature was removed.
 */
export function canUnlessUnknown(
  knowledgeBase: Pick<KnowledgeBase, 'capabilities'> | null | undefined,
  capability: Capability,
): boolean {
  return capabilitiesUnknown(knowledgeBase) || hasCapability(knowledgeBase, capability);
}
