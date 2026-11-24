import type { TableSource } from './common';

export type GlobalSearchResultType = 'knowledgeBase' | 'document' | 'chunk';

/**
 * One match position inside a result field.
 *
 * `start`/`end` are **UTF-16 code units** — plain JavaScript string indices, so
 * `text.slice(start, end)` is the matched text. They are not byte offsets and
 * not code-point indices; with CJK content those three disagree.
 */
export type SearchHighlight = {
  field: 'title' | 'snippet';
  start: number;
  end: number;
};

export type GlobalSearchResult = {
  type: GlobalSearchResultType;
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId?: string;
  filename?: string;
  title: string;
  snippet: string;
  highlights?: SearchHighlight[];
};

export type SearchSuggestItem = {
  type: 'knowledgeBase' | 'document';
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId?: string;
  title: string;
};

export type SearchSuggestResponse = {
  items: SearchSuggestItem[];
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
  total: number;
  page: number;
  pageSize: number;
};

export type GlobalSearchParams = {
  query: string;
  type?: 'all' | GlobalSearchResultType;
  page?: number;
  pageSize?: number;
};

export type KnowledgeBaseSearchRequest = {
  query: string;
  vectorTopN?: number;
  rerankTopK?: number;
  enableRerank?: boolean;
  enableKeyword?: boolean;
  debug?: boolean;
};

export type KnowledgeBaseSearchResult = {
  textSource?: 'ocr' | 'ocr_corrected';
  table?: TableSource;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  chunkId: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  vectorScore: number;
  keywordScore?: number | null;
  rerankScore?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
};

export type KnowledgeBaseRerankFallback = {
  used: boolean;
  reason?: string;
};

export type KnowledgeBaseSearchResponse = {
  items: KnowledgeBaseSearchResult[];
  rerankFallback: KnowledgeBaseRerankFallback | null;
  debug?: KnowledgeBaseSearchDebug;
};

export type KnowledgeBaseSearchDebug = {
  query: string;
  rewrittenQuery?: string;
  vectorStage: {
    status: string;
    items: Array<KnowledgeBaseSearchResult & { rank: number }>;
    /** True when the index scan came back short and the stage was rerun exhaustively. */
    exactFallback?: boolean;
  };
  keywordStage: {
    status: 'completed' | 'disabled' | 'failed';
    items: Array<{
      chunkId: string;
      documentId: string;
      filename: string;
      pageNumber: number | null;
      content: string;
      keywordScore: number;
      rank: number;
    }>;
  };
  fusionStage: {
    status: 'completed' | 'skipped';
    items: Array<{
      chunkId: string;
      pageNumber: number | null;
      vectorRank: number | null;
      keywordRank: number | null;
      fusionScore: number;
      vectorScore: number;
      keywordScore: number | null;
      rank: number;
    }>;
  };
  rerankStage: {
    status: 'completed' | 'disabled' | 'fallback';
    input: Array<{ chunkId: string; pageNumber: number | null; rank: number }>;
    output: Array<{ chunkId: string; pageNumber: number | null; rerankScore: number | null; rank: number }>;
  };
  finalStage: {
    items: Array<{
      chunkId: string;
      pageNumber: number | null;
      vectorScore: number;
      keywordScore: number | null;
      fusionScore: number | null;
      rerankScore: number | null;
      rank: number;
    }>;
  };
  rerankFallback: KnowledgeBaseRerankFallback | null;
};
