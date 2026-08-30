import { describe, expect, it } from 'vitest';

import { searchGuidance } from './searchGuidance';

/**
 * The advice has to match `GlobalSearchRepository`, which runs
 * `LOWER(column) LIKE '%query%'`. These tests pin the advice to that behaviour, so
 * that if the backend ever moves to real full-text search they fail rather than
 * silently keeping wrong suggestions on screen.
 */
describe('searchGuidance', () => {
  it('blames the type filter only when other types are known to have results', () => {
    const guidance = searchGuidance('员工手册', 'document', true);

    expect(guidance.title).toBe('没有匹配的文档');
    expect(guidance.description).toContain('其他类型下有匹配结果');
    expect(guidance.action).toEqual({ kind: 'clearType' });
  });

  it('does not claim other types have results when that was not checked', () => {
    const guidance = searchGuidance('员工手册', 'document', false);

    // Still offers to clear the filter, since that is a reasonable next step, but
    // must not assert something the caller could not confirm.
    expect(guidance.action).toEqual({ kind: 'clearType' });
    expect(guidance.description).not.toContain('其他类型');
  });

  it('takes the confirmed filter explanation over a query-shape guess', () => {
    // The query is also multi-word, which would otherwise win. Evidence beats guess.
    const guidance = searchGuidance('员工 手册', 'chunk', true);

    expect(guidance.title).toBe('没有匹配的内容片段');
    expect(guidance.action).toEqual({ kind: 'clearType' });
  });

  it('offers the query without operators, because they are matched literally', () => {
    const guidance = searchGuidance('"员工手册"', 'all', false);

    expect(guidance.description).toContain('符号');
    expect(guidance.action).toEqual({ kind: 'useQuery', query: '员工手册' });
  });

  it('handles full-width quotes the same way', () => {
    expect(searchGuidance('“年假”', 'all', false).action).toEqual({
      kind: 'useQuery',
      query: '年假',
    });
  });

  it('suggests the longest term when the query is several words', () => {
    const guidance = searchGuidance('年假 申请流程', 'all', false);

    expect(guidance.description).toContain('一整段文字');
    expect(guidance.action).toEqual({ kind: 'useQuery', query: '申请流程' });
  });

  it('splits on Chinese punctuation too', () => {
    expect(searchGuidance('年假、调休申请', 'all', false).action).toEqual({
      kind: 'useQuery',
      query: '调休申请',
    });
  });

  it('drops a trailing separator that still has to be matched literally', () => {
    // One term, but the `、` is part of the string being looked for.
    expect(searchGuidance('年假、', 'all', false).action).toEqual({
      kind: 'useQuery',
      query: '年假',
    });
  });

  it('truncates a long single-word query', () => {
    const long = '员'.repeat(30);
    const guidance = searchGuidance(long, 'all', false);

    expect(guidance.description).toContain('关键词较长');
    expect(guidance.action).toEqual({ kind: 'useQuery', query: '员'.repeat(24) });
  });

  it('falls back to generic advice for a short single word', () => {
    const guidance = searchGuidance('年假', 'all', false);

    // Nothing about a two-character query is diagnosable, so no confident claim is
    // made and no action is offered -- a wrong suggestion here would mislead.
    expect(guidance.title).toBe('没有匹配结果');
    expect(guidance.action).toBeUndefined();
  });

  it('never suggests changing capitalisation, since the match is already lowercased', () => {
    for (const query of ['Policy', 'POLICY handbook', '"Policy"']) {
      expect(searchGuidance(query, 'all', false).description).not.toMatch(/大小写/);
    }
  });

  it('never suggests a replacement identical to what was typed', () => {
    const queries = ['年假', '员工手册', '年假 申请', '"年假"', '员'.repeat(30)];
    for (const query of queries) {
      const { action } = searchGuidance(query, 'all', false);
      if (action?.kind === 'useQuery') expect(action.query).not.toBe(query.trim());
    }
  });

  it('treats a blank query as generic rather than throwing', () => {
    expect(searchGuidance('   ', 'all', false).action).toBeUndefined();
    expect(searchGuidance('   ', 'document', true).action).toBeUndefined();
  });

  it('does not offer an empty replacement for a query of only operators', () => {
    // Stripping `+++` leaves nothing, and "search for nothing" is not a next step.
    const { action } = searchGuidance('+++', 'all', false);
    if (action?.kind === 'useQuery') expect(action.query).not.toBe('');
  });
});
