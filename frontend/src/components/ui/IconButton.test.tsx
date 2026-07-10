import { render, screen } from '@testing-library/react';
import { Search } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('uses one accessible label for name and tooltip', () => {
    render(<IconButton label="搜索"><Search aria-hidden="true" /></IconButton>);
    const button = screen.getByRole('button', { name: '搜索' });
    expect(button).toHaveAttribute('title', '搜索');
  });
});
