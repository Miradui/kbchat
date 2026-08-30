import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchSuggest } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { SearchSuggestItem } from '../../types/api';
import { SearchCombobox, suggestionHref } from './SearchCombobox';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin' }),
  logout: vi.fn(),
  searchSuggest: vi.fn(),
}));

const mockedSuggest = vi.mocked(searchSuggest);

const knowledgeBase: SearchSuggestItem = {
  type: 'knowledgeBase',
  id: 'kb1',
  knowledgeBaseId: 'kb1',
  knowledgeBaseName: '员工知识库',
  title: '员工知识库',
};

const document1: SearchSuggestItem = {
  type: 'document',
  id: 'd1',
  documentId: 'd1',
  knowledgeBaseId: 'kb1',
  knowledgeBaseName: '员工知识库',
  title: '员工手册.pdf',
};

/**
 * A controlled wrapper, because the component takes its value from the page. The
 * spies record what the page would have been asked to do.
 */
function Harness({
  onSubmit = vi.fn(),
  onPick = vi.fn(),
  initial = '',
}: {
  onSubmit?: () => void;
  onPick?: (item: SearchSuggestItem) => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return <SearchCombobox onChange={setValue} onPick={onPick} onSubmit={onSubmit} value={value} />;
}

beforeEach(() => {
  mockedSuggest.mockReset().mockResolvedValue({ items: [knowledgeBase, document1] });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function typeAndWaitForList(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), text);
  await vi.advanceTimersByTimeAsync(300);
  return waitFor(() => screen.getByRole('listbox', { name: '搜索建议' }));
}

describe('SearchCombobox', () => {
  it('opens a listbox of suggestions after the debounce, not on every keystroke', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Harness />, ['/search']);

    await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), '员工');
    expect(mockedSuggest).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(mockedSuggest).toHaveBeenCalledTimes(1));
    const list = await screen.findByRole('listbox', { name: '搜索建议' });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(list).toBeInTheDocument();
  });

  it('leaves nothing highlighted so Enter runs the full search', async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} onSubmit={onSubmit} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    // The list closes, because a submitted query should not leave suggestions over
    // the results it just produced.
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('picks the highlighted suggestion with the arrow keys and Enter', async () => {
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} onSubmit={onSubmit} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    await user.keyboard('{ArrowDown}');

    const input = screen.getByRole('combobox', { name: '搜索关键词' });
    const first = screen.getAllByRole('option')[0];
    // Focus stays in the field; the active option is pointed at, not focused.
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith(document1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('returns to nothing highlighted past the end of the list', async () => {
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} onSubmit={onSubmit} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    const input = screen.getByRole('combobox', { name: '搜索关键词' });

    // Two options, so the third ArrowDown must fall off rather than wrap: there has
    // to be a way back to searching the literal text.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('walks back up the list with ArrowUp', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    const input = screen.getByRole('combobox', { name: '搜索关键词' });
    const options = screen.getAllByRole('option');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    // Off the top is the same "nothing highlighted" as off the bottom.
    await user.keyboard('{ArrowUp}');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('closes on Escape without picking anything', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onPick).not.toHaveBeenCalled();
    // Escape is a dismissal, not a reset: the text the user typed survives.
    expect(screen.getByRole('combobox', { name: '搜索关键词' })).toHaveValue('员工');
  });

  it('stays closed after Escape until the query changes again', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Harness />, ['/search']);

    await typeAndWaitForList(user, '员工');
    await user.keyboard('{Escape}');
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), '手册');
    await vi.advanceTimersByTimeAsync(300);
    expect(await screen.findByRole('listbox', { name: '搜索建议' })).toBeInTheDocument();
  });

  it('picks a suggestion on mouse down, before blur can remove the row', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    await user.click(screen.getAllByRole('option')[0]);

    expect(onPick).toHaveBeenCalledWith(knowledgeBase);
  });

  it('does not reopen the list behind a pick when a slow response lands after it', async () => {
    let release: (value: { items: SearchSuggestItem[] }) => void = () => {};
    const pending = new Promise<{ items: SearchSuggestItem[] }>((resolve) => {
      release = resolve;
    });
    // Keyed on the query, not on call order: how many times the debounce fires while
    // `userEvent` types is not something this test should depend on.
    mockedSuggest.mockImplementation((query: string) =>
      query === '员工手' ? pending : Promise.resolve({ items: [knowledgeBase, document1] }),
    );

    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<Harness onPick={onPick} />, ['/search']);

    await typeAndWaitForList(user, '员工');
    // This keystroke starts a request that will not answer until after the pick.
    await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), '手');
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(mockedSuggest).toHaveBeenCalledWith('员工手', 8, expect.anything()));

    // The list still shows the results for `员工`, which is what the user picks from.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    // act, not advanceTimersByTimeAsync: the late response's setState goes through
    // React's scheduler, which the fake clock does not drain, so without this the
    // assertion below runs before the re-render and passes for the wrong reason.
    await act(async () => {
      release({ items: [knowledgeBase, document1] });
    });

    // The user is already navigating away; a dropdown must not pop back over the
    // page they just landed on.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('swallows a failed suggestion request instead of showing an error', async () => {
    mockedSuggest.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderWithRouter(<Harness />, ['/search']);

    await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), '员工');
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(mockedSuggest).toHaveBeenCalled());

    // The full search on the page reports real failures; a dead suggestion request
    // must not put a second error in front of the user.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never opens an empty listbox', async () => {
    mockedSuggest.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderWithRouter(<Harness />, ['/search']);

    await user.type(screen.getByRole('combobox', { name: '搜索关键词' }), '员工');
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(mockedSuggest).toHaveBeenCalled());

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '搜索关键词' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves Escape alone when there is no list to dismiss', async () => {
    mockedSuggest.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderWithRouter(<Harness />, ['/search']);

    const input = screen.getByRole('combobox', { name: '搜索关键词' });
    await user.type(input, '员工');
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(mockedSuggest).toHaveBeenCalled());

    // fireEvent returns false when a handler called preventDefault. Escape must stay
    // unclaimed here so a surrounding dialog or drawer can still close on it -- a
    // request that came back empty is not an open list.
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
  });

  it('carries the mobile keyboard hints the soft keyboard reads', async () => {
    renderWithRouter(<Harness />, ['/search']);

    const input = screen.getByRole('combobox', { name: '搜索关键词' });
    // enterKeyHint turns the soft keyboard's return key into a search key; without
    // it the key inserts a newline the single-line field then discards.
    expect(input).toHaveAttribute('enterkeyhint', 'search');
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });
});

describe('suggestionHref', () => {
  it('sends a knowledge base to its detail page', () => {
    expect(suggestionHref(knowledgeBase)).toBe('/knowledge-bases/kb1');
  });

  it('sends a document to its knowledge base with the drawer deep link', () => {
    expect(suggestionHref(document1)).toBe('/knowledge-bases/kb1/documents?documentId=d1');
  });

  it('falls back to the row id when documentId is absent', () => {
    expect(suggestionHref({ ...document1, documentId: undefined })).toBe(
      '/knowledge-bases/kb1/documents?documentId=d1',
    );
  });
});
