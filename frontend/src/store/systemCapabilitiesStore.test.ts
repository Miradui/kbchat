import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSystemCapabilities, systemCapabilitiesStore } from './systemCapabilitiesStore';
import type { SystemCapabilities } from '../types/api';

const serverCapabilities: SystemCapabilities = {
  rerankEnabled: true,
  upload: { maxFileBytes: 10 * 1024 * 1024, allowedExtensions: ['txt'] },
  retrieval: { maxVectorTopN: 60, maxRerankTopK: 8 },
  account: {
    minPasswordLength: 10,
    maxPasswordBytes: 72,
    maxDisplayNameLength: 100,
    maxAvatarUrlLength: 400,
  },
};

describe('systemCapabilitiesStore', () => {
  beforeEach(() => systemCapabilitiesStore.clear());

  it('requests once and serves the cached value afterwards', async () => {
    const request = vi.fn().mockResolvedValue(serverCapabilities);

    const [first, second] = await Promise.all([
      systemCapabilitiesStore.load(request),
      systemCapabilitiesStore.load(request),
    ]);
    const third = await systemCapabilitiesStore.load(request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toEqual(serverCapabilities);
    expect(second).toEqual(serverCapabilities);
    expect(third).toEqual(serverCapabilities);
    expect(systemCapabilitiesStore.peek()).toEqual(serverCapabilities);
  });

  it('falls back to the defaults so forms stay usable when the request fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));

    expect(await systemCapabilitiesStore.load(request)).toEqual(defaultSystemCapabilities);
    // A failure is not cached, so a later mount can still pick up the real values.
    expect(systemCapabilitiesStore.peek()).toBeNull();
  });
});
