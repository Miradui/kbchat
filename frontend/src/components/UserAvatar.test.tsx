import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiBlobRequest } from '../api/client';
import { tokenStore } from '../store/tokenStore';
import { UserAvatar } from './UserAvatar';

vi.mock('../api/client', () => ({ apiBlobRequest: vi.fn() }));
const url = '/api/v1/users/11111111-1111-4111-8111-111111111111/avatar?v=22222222-2222-4222-8222-222222222222';
const createURL = vi.fn();
const revokeURL = vi.fn();

beforeEach(() => {
  vi.mocked(apiBlobRequest).mockReset();
  createURL.mockReset().mockReturnValue('blob:avatar');
  revokeURL.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeURL });
});

describe('UserAvatar', () => {
  it('fetches managed thumbnails through the authenticated API and releases object URLs', async () => {
    vi.mocked(apiBlobRequest).mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const view = render(<UserAvatar url={url} name="Owner" label="头像" />);
    await waitFor(() => expect(screen.getByRole('img').querySelector('img')).toHaveAttribute('src', 'blob:avatar'));
    expect(apiBlobRequest).toHaveBeenCalledWith(url.replace('/api/v1', ''), { signal: expect.any(AbortSignal) });
    view.unmount();
    expect(revokeURL).toHaveBeenCalledWith('blob:avatar');
    expect(vi.mocked(apiBlobRequest).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not send external URLs through the authenticated API and falls back on image error', () => {
    render(<UserAvatar url="https://example.com/a.png" name="用户" label="头像" />);
    const img = screen.getByRole('img').querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://example.com/a.png');
    expect(apiBlobRequest).not.toHaveBeenCalled();
    fireEvent.error(img);
    expect(screen.getByRole('img')).toHaveTextContent('用');
    expect(screen.getByRole('img').querySelector('img')).toBeNull();
  });

  it('discards obsolete reads after URL or account changes', async () => {
    let resolve!: (blob: Blob) => void;
    vi.mocked(apiBlobRequest).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue(new Blob(['new'], { type: 'image/png' }));
    const view = render(<UserAvatar url={url} name="Owner" label="头像" />);
    view.rerender(<UserAvatar name="New name" label="头像" />);
    await act(async () => resolve(new Blob(['old'], { type: 'image/png' })));
    expect(createURL).not.toHaveBeenCalled();
    view.rerender(<UserAvatar url={url} name="Owner" label="头像" />);
    await waitFor(() => expect(createURL).toHaveBeenCalledOnce());
    act(() => tokenStore.setToken('different-account'));
    expect(revokeURL).toHaveBeenCalledWith('blob:avatar');
    await waitFor(() => expect(apiBlobRequest).toHaveBeenCalledTimes(3));
  });
});
