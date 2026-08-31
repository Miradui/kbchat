import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette';

vi.mock('../api/resources', () => ({ searchSuggest: vi.fn().mockResolvedValue({ items: [] }) }));

/**
 * The palette's input is a bare `<input>` rather than the shared `SearchInput`, because
 * it carries the palette's own layout and combobox wiring. That means it does not
 * inherit the mobile keyboard hints and has to set them itself -- which is precisely
 * the kind of divergence that goes unnoticed, so it is pinned here.
 */
describe('CommandPalette input', () => {
  function renderPalette() {
    render(
      <MemoryRouter>
        <CommandPalette open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    return screen.getByRole('textbox', { name: '搜索知识库、文档和内容' });
  }

  it('asks for a search key and turns off prose assistance', () => {
    const input = renderPalette();

    expect(input).toHaveAttribute('enterkeyhint', 'search');
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });
});
