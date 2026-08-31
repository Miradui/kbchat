import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SearchInput } from './Field';

/**
 * `SearchInput` carries the mobile keyboard hints for every search box in the app, so
 * they are tested here rather than once per call site. None of them is observable in
 * jsdom -- they change what an on-screen keyboard offers -- which is exactly why they
 * are easy to delete by accident and worth pinning.
 */
describe('SearchInput mobile keyboard hints', () => {
  it('asks the on-screen keyboard for a search key, not a newline key', () => {
    render(<SearchInput aria-label="搜索" icon={<span aria-hidden="true" />} />);

    expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveAttribute('enterkeyhint', 'search');
  });

  it('turns off prose assistance and browser autofill', () => {
    render(<SearchInput aria-label="搜索" icon={<span aria-hidden="true" />} />);

    const input = screen.getByRole('searchbox', { name: '搜索' });
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    // Autofill would cover the suggestion list with the browser's own dropdown.
    expect(input).toHaveAttribute('autocomplete', 'off');
  });

  it('lets a caller override a hint', () => {
    render(<SearchInput aria-label="搜索" enterKeyHint="go" icon={<span aria-hidden="true" />} />);

    // The defaults sit before the spread, so a call site is never locked out of one.
    expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveAttribute('enterkeyhint', 'go');
  });

  it('keeps the search type so phones show the search layout at all', () => {
    render(<SearchInput aria-label="搜索" icon={<span aria-hidden="true" />} />);

    expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveAttribute('type', 'search');
  });
});
