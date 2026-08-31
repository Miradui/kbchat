import { FileText, Library, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { searchSuggest } from '../../api/resources';
import { SearchInput } from '../../components/ui/Field';
import { useDebouncedValue } from '../../hooks/useMediaQuery';
import type { SearchSuggestItem } from '../../types/api';

const SUGGEST_DEBOUNCE_MS = 220;
const SUGGEST_LIMIT = 8;

type SearchComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no suggestion highlighted: run the full search. */
  onSubmit: () => void;
  /** Enter or click on a highlighted suggestion: go straight to the resource. */
  onPick: (item: SearchSuggestItem) => void;
};

/**
 * The search box, with title-level suggestions from `GET /search/suggest`.
 *
 * The page already debounces the query into the URL and runs a full search, so
 * suggestions are not how you find results here -- they are the shortcut past the
 * results page when you already know which knowledge base or document you want.
 * That is also why they are title-only: chunk content is what the results page is
 * for, and putting it in a dropdown would make the two views compete.
 *
 * Built as an ARIA 1.2 combobox: the listbox is a sibling of the input, the input
 * keeps focus throughout, and the active option is pointed at by
 * `aria-activedescendant` rather than by moving focus. Arrow keys would otherwise
 * take focus out of the field and stop the user from continuing to type.
 */
export function SearchCombobox({ value, onChange, onSubmit, onPick }: SearchComboboxProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const [items, setItems] = useState<SearchSuggestItem[]>([]);
  const [open, setOpen] = useState(false);
  // -1 means "nothing highlighted", which is what makes Enter run the full search
  // instead of picking a suggestion. Opening the list must not preselect a row: the
  // user pressing Enter right after typing means "search for what I typed".
  const [cursor, setCursor] = useState(-1);
  const debounced = useDebouncedValue(value.trim(), SUGGEST_DEBOUNCE_MS);
  // Set while a pick or submit is in flight, so the response that lands afterwards
  // does not reopen the list behind the navigation.
  const dismissedFor = useRef('');

  useEffect(() => {
    if (!debounced || debounced === dismissedFor.current) {
      setItems([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    void searchSuggest(debounced, SUGGEST_LIMIT, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        // Re-check the dismissal here, not only at the top of the effect: a request
        // already in flight when the user picks or submits would otherwise land
        // afterwards and reopen the list over whatever they navigated to.
        if (debounced === dismissedFor.current) return;
        setItems(response.items);
        setOpen(response.items.length > 0);
        setCursor(-1);
      })
      .catch(() => {
        // A failed suggestion is not worth an error message: the full search below
        // is already running and will report anything that actually went wrong.
        if (!controller.signal.aborted) {
          setItems([]);
          setOpen(false);
        }
      });

    return () => controller.abort();
  }, [debounced]);

  const visible = useMemo(() => (open ? items : []), [items, open]);

  function dismiss() {
    dismissedFor.current = value.trim();
    setOpen(false);
    setCursor(-1);
  }

  function pick(item: SearchSuggestItem) {
    dismiss();
    onPick(item);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Never steal Enter or the arrows from an IME candidate window.
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (visible.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((current) => {
        const next = current + step;
        // Past either end returns to "nothing highlighted" rather than wrapping, so
        // there is always a way back to searching the literal text.
        if (next < 0 || next >= visible.length) return -1;
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      // Both branches are handled here rather than letting the no-highlight case
      // bubble to the page's form: one owner for Enter means the behaviour is the
      // same whether or not a form happens to be wrapping this.
      event.preventDefault();
      const highlighted = cursor >= 0 ? visible[cursor] : undefined;
      if (highlighted) {
        pick(highlighted);
        return;
      }
      dismiss();
      onSubmit();
      return;
    }

    if (event.key === 'Escape' && open) {
      // Only swallow Escape while the list is open, so it stays available for
      // whatever else might want it once the list is closed.
      event.preventDefault();
      dismiss();
    }
  }

  const activeId = cursor >= 0 && visible[cursor] ? `${optionIdPrefix}-${cursor}` : undefined;

  return (
    <div className="search-combobox">
      <SearchInput
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-controls={visible.length > 0 ? listboxId : undefined}
        aria-expanded={visible.length > 0}
        aria-label="搜索关键词"
        autoFocus
        icon={<Search aria-hidden="true" />}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          dismissedFor.current = '';
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder="搜索知识库、文件名或内容"
        role="combobox"
        spellCheck={false}
        value={value}
      />

      {visible.length > 0 && (
        <ul className="search-combobox__list" id={listboxId} role="listbox" aria-label="搜索建议">
          {visible.map((item, index) => {
            const Icon = item.type === 'knowledgeBase' ? Library : FileText;
            return (
              <li
                aria-selected={index === cursor}
                className={index === cursor ? 'search-combobox__option is-active' : 'search-combobox__option'}
                id={`${optionIdPrefix}-${index}`}
                key={`${item.type}-${item.id}`}
                // mousedown, not click: the input's blur closes the list first and a
                // click on a removed node never fires.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setCursor(index)}
                role="option"
              >
                <Icon aria-hidden="true" />
                <span className="search-combobox__text">
                  <strong>{item.title}</strong>
                  <small>
                    {item.type === 'knowledgeBase' ? '知识库' : item.knowledgeBaseName || '文档'}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Deliberately no live region for the suggestion count. The combobox pattern
        already announces the state change when `aria-expanded` flips and reads the
        active option out of `aria-activedescendant` as the cursor moves, so a count
        region would add a second polite announcement racing the results count below
        -- the user would hear "8 suggestions" stepping on "found 24 results". The
        page keeps exactly one status region.
      */}
    </div>
  );
}

/** Where a suggestion goes. Mirrors the command palette so both jump alike. */
export function suggestionHref(item: SearchSuggestItem): string {
  if (item.type === 'knowledgeBase') return `/knowledge-bases/${item.knowledgeBaseId}`;

  const documentId = item.documentId ?? item.id;
  const base = `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  return documentId ? `${base}?documentId=${encodeURIComponent(documentId)}` : base;
}
