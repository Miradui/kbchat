import type {
  GlobalSearchParams,
  GlobalSearchResponse,
  KnowledgeBaseSearchRequest,
  KnowledgeBaseSearchResponse,
  SearchSuggestResponse,
} from '../../types/api';
import { apiRequest } from '../client';
import { withQuery } from './helpers';

export function globalSearch(params: GlobalSearchParams, signal?: AbortSignal): Promise<GlobalSearchResponse> {
  return apiRequest<GlobalSearchResponse>(withQuery('/search', {
    q: params.query,
    type: params.type === 'all' ? undefined : params.type,
    page: params.page,
    pageSize: params.pageSize,
  }), { signal });
}

/**
 * Title-level results for the command palette. Searches knowledge base names and
 * filenames only — no chunk content, no snippets — which is what makes it
 * cheaper than a full `globalSearch` on every keystroke pause.
 */
export function searchSuggest(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<SearchSuggestResponse> {
  return apiRequest<SearchSuggestResponse>(withQuery('/search/suggest', { q: query, limit }), { signal });
}

export function searchKnowledgeBase(
  knowledgeBaseId: string,
  input: KnowledgeBaseSearchRequest,
): Promise<KnowledgeBaseSearchResponse> {
  return apiRequest<KnowledgeBaseSearchResponse>(`/knowledge-bases/${knowledgeBaseId}/search`, {
    method: 'POST',
    body: input,
  });
}
