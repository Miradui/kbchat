const dateTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const shortDateTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

const numbers = new Intl.NumberFormat('zh-CN');

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? dateTime.format(date) : '—';
}

export function formatShortDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? shortDateTime.format(date) : '—';
}

/** "刚刚 / 12 分钟前 / 3 小时前 / 昨天 14:20 / 08-05 14:20". */
export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';

  const diffMs = now - date.getTime();
  if (diffMs < 0) return shortDateTime.format(date);

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday.getTime() - 86_400_000;
  if (date.getTime() >= startOfYesterday) return `昨天 ${timeOnly.format(date)}`;

  return shortDateTime.format(date);
}

/** Buckets used by the chat session rail. */
export function relativeDayBucket(value: string | null | undefined, now = Date.now()): string {
  const date = toDate(value);
  if (!date) return '更早';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (date.getTime() >= startOfToday.getTime()) return '今天';
  if (date.getTime() >= startOfToday.getTime() - 86_400_000) return '昨天';
  if (date.getTime() >= startOfToday.getTime() - 7 * 86_400_000) return '最近 7 天';
  return '更早';
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatNumber(value: number): string {
  return numbers.format(value);
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' ? numbers.format(value) : '—';
}

export function formatScore(value: number): string {
  return value.toFixed(2);
}

export function formatNullableScore(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : '无精排分';
}
