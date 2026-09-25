import { useEffect, useState } from 'react';

import { formatRateLimitMessage } from '../../api/client';
import type { ApiError } from '../../api/client';

export type RetryNotice = { expiresAt: number | null; message: string };

export function retryNotice(error: ApiError): RetryNotice {
  return {
    expiresAt: error.retryAfterSeconds === null ? null : Date.now() + error.retryAfterSeconds * 1000,
    message: error.message,
  };
}

/** Isolate the ticking state and keep it out of the enclosing alert's live updates. */
export function RetryCountdown({ notice }: { notice: RetryNotice }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    if (notice.expiresAt === null) return;
    const timer = window.setInterval(() => {
      update();
      if (Date.now() >= notice.expiresAt!) window.clearInterval(timer);
    }, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [notice]);
  const remaining = notice.expiresAt === null ? null : Math.max(0, Math.ceil((notice.expiresAt - now) / 1000));
  return <span aria-live="off">{remaining === 0 ? '等待已结束，可以重试。' : formatRateLimitMessage(remaining)}</span>;
}
