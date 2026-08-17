import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Route-level pages must stay in their own lazily loaded chunks. Keep this list
 * in sync with the lazy imports in `src/router/index.tsx`.
 */
const expectedRouteChunks = [
  'LoginPage',
  'HomePage',
  'KnowledgeBaseListPage',
  'KnowledgeBaseOverviewPage',
  'KnowledgeBaseSettingsPage',
  'DocumentsPage',
  'ChatPage',
  'SearchPage',
  'TagsPage',
];

export function verifyRouteChunks(javascriptChunks) {
  const missing = expectedRouteChunks.filter((routeName) => (
    !javascriptChunks.some((chunkName) => chunkName.startsWith(`${routeName}-`) && chunkName.endsWith('.js'))
  ));
  if (missing.length > 0) {
    throw new Error(`Missing route-level JavaScript chunks: ${missing.join(', ')}`);
  }
  return expectedRouteChunks.length;
}

if (import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assetsDirectory = new URL('../dist/assets/', import.meta.url);
  const javascriptChunks = readdirSync(assetsDirectory).filter((name) => name.endsWith('.js'));
  const verifiedCount = verifyRouteChunks(javascriptChunks);
  process.stdout.write(`Verified ${verifiedCount} route-level JavaScript chunks.\n`);
}
