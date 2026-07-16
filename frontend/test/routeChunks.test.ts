import { describe, expect, it } from 'vitest';

import { verifyRouteChunks } from '../scripts/verify-route-chunks.mjs';

describe('route chunk verifier', () => {
  it('rejects unrelated JavaScript chunks when a route page chunk is missing', () => {
    expect(() => verifyRouteChunks([
      'index-a.js', 'resources-b.js', 'ConfirmDialog-c.js',
      'vendor-d.js', 'shared-e.js', 'icons-f.js',
    ])).toThrow(/LoginPage/);
  });
});
