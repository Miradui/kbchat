import { FileText, Library, Search, TextQuote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { searchSuggest } from '../api/resources';
import { useDebouncedValue } from '../hooks/useMediaQuery';
import type { SearchSuggestItem } from '../types/api';
import { getErrorMessage } from '../utils/errors';
import { useModalFocus } from './ui/useModalFocus';

type PaletteRow = {
  key: string;
  icon: typeof Library;
  title: string;
  subtitle: string;
  to: string;
};

type PaletteGroup = { label: string; rows: PaletteRow[] };

const PER_GROUP = 5;

const navigationRows: PaletteRow[] = [
  { key: 'nav-new-chat', icon: TextQuote, title: '新建对话', subtitle: '前往 AI 问答', to: '/chat' },
  { key: 'nav-kb', icon: Library, title: '知识库', subtitle: '管理知识资产', to: '/knowledge-bases' },
  { key: 'nav-kb-create', icon: Library, title: '新建知识库', subtitle: '创建一个新的知识空间', to: '/knowledge-bases?intent=create' },
  { key: 'nav-docs', icon: FileText, title: '文档', subtitle: '跨知识库查看全部文档', to: '/documents' },
];

function suggestionHref(item: SearchSuggestItem): string {
  if (item.type === 'knowledgeBase') return `/knowledge-bases/${item.knowledgeBaseId}`;

  const documentId = item.documentId ?? item.id;
  const base = `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  return documentId ? `${base}?documentId=${encodeURIComponent(documentId)}` : base;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const panelRef = useModalFocus<HTMLDivElement>(open, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchSuggestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);
  const debouncedQuery = useDebouncedValue(query.trim(), 260);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError('');
      setCursor(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !debouncedQuery) {
      setResults([]);
      setLoading(false);
      setError('');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');
    // Suggest is title-level only, so a keystroke pause no longer pays for a
    // full results page. Chunk content lives behind "查看全部结果".
    // See docs/14-frontend-api-gaps.md G10.
    void searchSuggest(debouncedQuery, PER_GROUP * 2, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setResults(response.items);
      })
      .catch((caught: unknown) => {
        const aborted = controller.signal.aborted
          || (caught instanceof DOMException && caught.name === 'AbortError');
        if (!aborted) setError(getErrorMessage(caught, '搜索失败'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [debouncedQuery, open]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const keyword = query.trim();
    if (!keyword) {
      return [{ label: '快捷操作', rows: navigationRows }];
    }

    const matchedNavigation = navigationRows.filter(
      (row) => row.title.includes(keyword) || row.subtitle.includes(keyword),
    );

    const byType: Array<[SearchSuggestItem['type'], string, typeof Library]> = [
      ['knowledgeBase', '知识库', Library],
      ['document', '文档', FileText],
    ];

    const searchGroups = byType.flatMap<PaletteGroup>(([type, label, icon]) => {
      const rows = results
        .filter((item) => item.type === type)
        .slice(0, PER_GROUP)
        .map<PaletteRow>((item) => ({
          key: `${item.type}-${item.id}`,
          icon,
          title: item.title,
          subtitle: type === 'document' ? item.knowledgeBaseName : '',
          to: suggestionHref(item),
        }));
      return rows.length > 0 ? [{ label, rows }] : [];
    });

    // Suggest never searches chunk content, so the full search page is always
    // offered rather than only when there were title matches.
    const tail: PaletteGroup[] = [{
      label: '更多',
      rows: [{
        key: 'see-all',
        icon: Search,
        title: '查看全部结果',
        subtitle: `在搜索页打开“${keyword}”，包含内容片段`,
        to: `/search?q=${encodeURIComponent(keyword)}`,
      }],
    }];

    return [
      ...(matchedNavigation.length > 0 ? [{ label: '快捷操作', rows: matchedNavigation }] : []),
      ...searchGroups,
      ...tail,
    ];
  }, [query, results]);

  const flatRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  useEffect(() => {
    setCursor((current) => (current < flatRows.length ? current : 0));
  }, [flatRows.length]);

  function go(row: PaletteRow | undefined) {
    if (!row) return;
    onClose();
    navigate(row.to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => (flatRows.length === 0 ? 0 : (current + 1) % flatRows.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => (flatRows.length === 0 ? 0 : (current - 1 + flatRows.length) % flatRows.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(flatRows[cursor]);
    }
  }

  if (!open) return null;

  let rowIndex = -1;

  return createPortal(
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label="命令面板"
        aria-modal="true"
        className="palette"
        onKeyDown={onKeyDown}
        ref={panelRef}
        role="dialog"
      >
        <div className="palette__input-row">
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor="palette-input">搜索知识库、文档和内容</label>
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="palette__input"
            data-autofocus
            enterKeyHint="search"
            id="palette-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            placeholder="搜索知识库、文档和内容…"
            ref={inputRef}
            value={query}
          />
        </div>

        <div className="palette__results">
          <p aria-live="polite" className="sr-only" role="status">
            {loading ? '正在搜索' : error ? error : `${flatRows.length} 条结果`}
          </p>
          {error ? (
            <p className="palette__state">{error}</p>
          ) : flatRows.length === 0 ? (
            <p className="palette__state">{loading ? '正在搜索…' : query.trim() ? '没有匹配结果' : '输入关键词开始搜索'}</p>
          ) : (
            groups.map((group) => (
              <div className="palette__group" key={group.label}>
                <p className="palette__group-label">{group.label}</p>
                {group.rows.map((row) => {
                  rowIndex += 1;
                  const index = rowIndex;
                  const Icon = row.icon;
                  return (
                    <button
                      className={index === cursor ? 'palette__item is-active' : 'palette__item'}
                      key={row.key}
                      onClick={() => go(row)}
                      onMouseEnter={() => setCursor(index)}
                      type="button"
                    >
                      <Icon aria-hidden="true" />
                      <span className="palette__item-text">
                        <strong>{row.title}</strong>
                        {row.subtitle && <small>{row.subtitle}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette__foot">
          <span><kbd className="ui-kbd">↑↓</kbd> 选择</span>
          <span><kbd className="ui-kbd">↵</kbd> 打开</span>
          <span><kbd className="ui-kbd">Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
