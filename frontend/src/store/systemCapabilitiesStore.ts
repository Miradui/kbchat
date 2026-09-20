import { getSystemCapabilities } from '../api/resources';
import type { SystemCapabilities } from '../types/api';
import { DEFAULT_MAX_PASSWORD_BYTES } from '../utils/password';

/**
 * Mirrors the server defaults (MAX_UPLOAD_SIZE_MB=50, the validateFile allow
 * list, the retrieval ceilings, and the account field limits). Used until
 * GET /system/capabilities answers and as the fallback when it fails, so forms
 * stay usable either way — the server still rejects anything past its own
 * limits.
 */
export const defaultSystemCapabilities: SystemCapabilities = {
  rerankEnabled: false,
  keywordSearchEnabled: true,
  chatModels: [],
  upload: {
    maxFileBytes: 50 * 1024 * 1024,
    allowedExtensions: ['txt', 'md', 'pdf', 'docx'],
  },
  retrieval: {
    maxVectorTopN: 100,
    maxRerankTopK: 20,
  },
  account: {
    minPasswordLength: 8,
    maxPasswordBytes: DEFAULT_MAX_PASSWORD_BYTES,
    maxDisplayNameLength: 128,
    maxAvatarUrlLength: 512,
    maxAvatarBytes: 2 * 1024 * 1024,
    avatarSize: 256,
    avatarContentTypes: ['image/png', 'image/jpeg'],
  },
};

type CapabilitiesRequest = () => Promise<SystemCapabilities>;

type CacheEntry = {
  request: CapabilitiesRequest;
  pending: Promise<SystemCapabilities> | null;
  capabilities: SystemCapabilities | null;
};

let cache: CacheEntry | null = null;

export const systemCapabilitiesStore = {
  /** Resolves to the server values, or to the defaults when the request fails. */
  load(request: CapabilitiesRequest = getSystemCapabilities): Promise<SystemCapabilities> {
    if (!cache || cache.request !== request) {
      cache = { request, pending: null, capabilities: null };
    }
    if (cache.capabilities) {
      return Promise.resolve(cache.capabilities);
    }
    if (cache.pending) {
      return cache.pending;
    }

    const entry = cache;
    const pending = request()
      .then((capabilities) => {
        if (cache === entry) entry.capabilities = capabilities;
        return capabilities;
      })
      .catch(() => defaultSystemCapabilities)
      .finally(() => {
        if (cache === entry && entry.pending === pending) {
          entry.pending = null;
        }
      });
    entry.pending = pending;
    return pending;
  },

  peek(): SystemCapabilities | null {
    return cache?.capabilities ?? null;
  },

  clear(): void {
    cache = null;
  },
};
