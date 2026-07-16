import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('applies its semantic variant and handles clicks', async () => {
    const onClick = vi.fn();
    render(<Button variant="secondary" onClick={onClick}>保存</Button>);

    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toHaveClass('ui-button--secondary');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('announces loading and prevents repeated clicks', async () => {
    const onClick = vi.fn();
    render(<Button loading loadingLabel="保存中" onClick={onClick}>保存</Button>);

    const button = screen.getByRole('button', { name: '保存中' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
