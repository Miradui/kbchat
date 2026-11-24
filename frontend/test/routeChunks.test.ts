import { describe, expect, it } from 'vitest';

import { verifyRouteChunks } from '../scripts/verify-route-chunks.mjs';

describe('route chunk verifier', () => {
  it('rejects unrelated JavaScript chunks when a route page chunk is missing', () => {
    expect(() => verifyRouteChunks([
      'index-a.js', 'resources-b.js', 'ConfirmDialog-c.js',
      'vendor-d.js', 'shared-e.js', 'icons-f.js',
    ])).toThrow(/LoginPage/);
  });

  it('requires all 12 route chunks including UsersPage', () => {
    const eleven = [
      'LoginPage-1.js', 'HomePage-2.js', 'KnowledgeBaseListPage-3.js',
      'KnowledgeBaseOverviewPage-4.js', 'KnowledgeBaseSettingsPage-5.js',
      'DocumentsPage-6.js', 'ChatPage-7.js', 'SearchPage-8.js',
      'TagsPage-9.js', 'QualityPage-10.js', 'DiagnosticsPage-11.js',
    ];
    expect(() => verifyRouteChunks(eleven)).toThrow(/UsersPage/);
    expect(verifyRouteChunks([...eleven, 'UsersPage-12.js'])).toBe(12);
  });
});
