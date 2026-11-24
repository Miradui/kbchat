import type { UserSummary } from './common';

export type User = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  role?: string;
  status?: 'active' | 'disabled' | string;
  lastLoginAt?: string | null;
};

export type AdminUser = User & { status: 'active' | 'disabled'; createdAt: string; ownedKnowledgeBaseCount: number };
export type AdminUserListResponse = { items: AdminUser[]; total: number; page: number; pageSize: number };
export type AdminUserCreateInput = { username: string; displayName?: string; password?: string };
export type TransferOwnershipInput = { newOwnerId: string; keepPreviousOwnerAsManager: boolean };
export type AdminActivity = {
  id: string; action: string; resourceType: string; resourceId: string; resourceName: string;
  actor: { id: string; username: string; displayName: string }; createdAt: string;
};
export type AdminActivityListResponse = { items: AdminActivity[]; total: number; page: number; pageSize: number };

export type LoginResponse = {
  token: string;
  user: User;
};

export type SystemCapabilities = {
  rerankEnabled: boolean;
  keywordSearchEnabled: boolean;
  chatModels?: string[];
  upload: {
    maxFileBytes: number;
    allowedExtensions: string[];
  };
  retrieval: {
    maxVectorTopN: number;
    maxRerankTopK: number;
  };
  account: {
    minPasswordLength: number;
    maxPasswordBytes: number;
    maxDisplayNameLength: number;
    maxAvatarUrlLength: number;
    maxAvatarBytes?: number;
    avatarSize?: number;
    avatarContentTypes?: string[];
  };
};

export type UpdateProfileInput = {
  displayName: string;
  avatarUrl?: string;
};

export type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
};

export type UserSearchResponse = {
  items: UserSummary[];
};
