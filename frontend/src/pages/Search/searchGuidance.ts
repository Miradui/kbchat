/**
 * What to tell someone whose search returned nothing.
 *
 * "尝试更短的关键词，或切换结果类型" is the same sentence whatever went wrong, so it
 * reads as a shrug. This picks the one thing most likely to be the actual problem
 * for *this* query and says that instead.
 *
 * The advice has to match how the backend actually searches. `GlobalSearchRepository`
 * runs `LOWER(column) LIKE '%query%'` -- a single lowercased substring match, not a
 * tokenised full-text query. So:
 *
 *   - a space is matched literally: `员工 手册` only hits text containing exactly
 *     "员工 手册", which is why splitting a phrase is the most useful suggestion;
 *   - quotes and operators are matched literally too, they do not group or exclude;
 *   - the query is already case-insensitive, so "try different capitalisation" would
 *     be wrong advice.
 *
 * Everything here is derived from the query string and the type filter, both of which
 * the caller already has. Deliberately no extra request: a "did you mean" that costs
 * a round trip on every empty result is worse than a good static hint. When nothing
 * specific applies the generic text is returned, because a confidently wrong
 * suggestion sends people down the wrong path.
 */

export type SearchType = 'all' | 'knowledgeBase' | 'document' | 'chunk';

export type SearchGuidanceAction =
  /** Re-run the same query with the type filter cleared. */
  | { kind: 'clearType' }
  /** Re-run with a shortened query. `query` is the suggested replacement. */
  | { kind: 'useQuery'; query: string };

export type SearchGuidance = {
  title: string;
  description: string;
  action?: SearchGuidanceAction;
};

/** Long enough that a substring match is unlikely to land, in either script. */
const LONG_QUERY_CHARS = 24;

/**
 * Characters people reach for expecting query syntax. The backend has none, so each
 * of these is one more literal character that has to appear in the text.
 */
const OPERATOR_CHARS = ['"', '“', '”', '\'', '+', '-', '|', '&', '*', '~', '(', ')'];

const TYPE_LABELS: Record<Exclude<SearchType, 'all'>, string> = {
  knowledgeBase: '知识库',
  document: '文档',
  chunk: '内容片段',
};

const GENERIC: SearchGuidance = {
  title: '没有匹配结果',
  description: '搜索按整段文字匹配，试试更短的关键词，或换一个说法。',
};

/**
 * The longest run of non-separator characters, i.e. the most specific single term.
 *
 * No "at least two parts" guard: the caller compares the result against the original
 * query, so a single-word query returns itself and is rejected there. Leaving it out
 * also covers `年假、`, where there is one term but the trailing separator still has
 * to be matched literally.
 */
function longestTerm(query: string): string {
  const parts = query.split(/[\s、，,;；/|]+/u).filter(Boolean);
  return parts.reduce((longest, part) => (part.length > longest.length ? part : longest), '');
}

function stripOperators(query: string): string {
  let stripped = query;
  for (const char of OPERATOR_CHARS) stripped = stripped.split(char).join('');
  return stripped.replace(/\s+/gu, ' ').trim();
}

export function searchGuidance(rawQuery: string, type: SearchType, hasOtherTypes: boolean): SearchGuidance {
  const query = rawQuery.trim();
  if (!query) return GENERIC;

  // Checked first because it is the only case backed by evidence rather than by a
  // guess: the caller has seen results for this query under a different filter, so
  // the filter is provably what is hiding them.
  if (type !== 'all' && hasOtherTypes) {
    return {
      title: `没有匹配的${TYPE_LABELS[type]}`,
      description: `其他类型下有匹配结果，当前只看${TYPE_LABELS[type]}。`,
      action: { kind: 'clearType' },
    };
  }

  const withoutOperators = stripOperators(query);
  if (withoutOperators && withoutOperators !== query) {
    return {
      title: '没有匹配结果',
      description: '引号和 + - | * 这些符号会被当成普通字符一起匹配，去掉它们再试。',
      action: { kind: 'useQuery', query: withoutOperators },
    };
  }

  // A multi-word query is matched as one string including the space, so the space is
  // usually the reason it missed. Suggest the most specific single term.
  const term = longestTerm(query);
  if (term && term !== query) {
    return {
      title: '没有匹配结果',
      description: '多个词会作为一整段文字匹配，试试只搜其中一个词。',
      action: { kind: 'useQuery', query: term },
    };
  }

  if (query.length > LONG_QUERY_CHARS) {
    return {
      title: '没有匹配结果',
      description: '关键词较长，需要原文完整出现才能匹配，试试其中最关键的几个字。',
      action: { kind: 'useQuery', query: query.slice(0, LONG_QUERY_CHARS) },
    };
  }

  if (type !== 'all') {
    return {
      title: `没有匹配的${TYPE_LABELS[type]}`,
      // No claim that other types have results -- the caller could not confirm it.
      description: '可以取消类型筛选，在全部结果里再看一次。',
      action: { kind: 'clearType' },
    };
  }

  return GENERIC;
}
