import { tokenStore } from '../store/tokenStore';
import type { APIError } from '../types/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;
  retryAfterSeconds: number | null;
  status: number;

  constructor(status: number, error: APIError, retryAfter?: string | number | null) {
    const retryAfterSeconds = parseRetryAfter(retryAfter)
      ?? parseRetryAfter(readRetryAfterDetail(error.details));
    super(isRateLimited(status, error.code)
      ? formatRateLimitMessage(retryAfterSeconds)
      : error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.details = error.details ?? {};
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isRateLimitError(error: unknown): error is ApiError {
  return error instanceof ApiError && isRateLimited(error.status, error.code);
}

export function formatRateLimitMessage(retryAfterSeconds: number | null = null): string {
  return retryAfterSeconds === null
    ? '请求过于频繁，请稍后再试'
    : `请求过于频繁，请 ${retryAfterSeconds} 秒后再试`;
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  redirectOnUnauthorized?: boolean;
  onUnauthorized?: () => void;
};

type UploadRequestOptions = {
  headers?: HeadersInit;
  method?: string;
  onProgress?: (progress: number) => void;
  redirectOnUnauthorized?: boolean;
  onUnauthorized?: () => void;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, options);

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function apiBlobRequest(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await request(path, options);
  return response.blob();
}

/** Uses XHR only for multipart uploads because fetch does not expose upload progress. */
export function apiUploadRequest<T>(
  path: string,
  body: FormData,
  options: UploadRequestOptions = {},
): Promise<T> {
  const {
    headers: headerInit,
    method = 'POST',
    onProgress,
    redirectOnUnauthorized = true,
    onUnauthorized = () => window.location.assign('/login'),
    signal,
  } = options;
  const headers = new Headers(headerInit);
  const token = tokenStore.getToken();
  const authRevision = tokenStore.getRevision();

  if (token) {
    headers.delete('Authorization');
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => signal?.removeEventListener('abort', abortFromSignal);
    const rejectOnce = (error: ApiError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abortFromSignal = () => xhr.abort();

    xhr.open(method, `${API_BASE_URL}${path}`);
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.(clampProgress((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => rejectOnce(new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络后重试。',
    }));
    xhr.onabort = () => rejectOnce(new ApiError(0, {
      code: 'REQUEST_ABORTED',
      message: '请求已取消。',
    }));
    xhr.onload = () => {
      handleUnauthorized(xhr.status, redirectOnUnauthorized, authRevision, onUnauthorized);

      if (xhr.status < 200 || xhr.status >= 300) {
        rejectOnce(new ApiError(
          xhr.status,
          readXHRError(xhr),
          xhr.getResponseHeader('Retry-After'),
        ));
        return;
      }

      onProgress?.(100);
      if (xhr.status === 204) {
        resolveOnce(undefined as T);
        return;
      }
      resolveOnce(readXHRResponse<T>(xhr));
    };

    if (signal?.aborted) {
      rejectOnce(new ApiError(0, { code: 'REQUEST_ABORTED', message: '请求已取消。' }));
      return;
    }
    signal?.addEventListener('abort', abortFromSignal, { once: true });
    xhr.send(body);
  });
}

export type ServerSentEvent = { event: string; data: string };

/**
 * Opens a request and yields its Server-Sent Events.
 *
 * It goes through the same `request()` as everything else on purpose: a failure
 * that happens *before* the stream is committed — 401, 404, a 409
 * `IDEMPOTENCY_KEY_REUSED` — arrives as a normal JSON body and is thrown as an
 * `ApiError`, so callers keep their existing error handling. Only once the
 * server has emitted its first event is the response locked to 200, and from
 * there failures arrive as an `error` event instead.
 */
export async function* apiEventStream(
  path: string,
  options: RequestOptions = {},
): AsyncGenerator<ServerSentEvent> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'text/event-stream');
  const response = await request(path, { ...options, headers });

  const body = response.body;
  if (!body) {
    throw new ApiError(response.status, {
      code: 'STREAM_UNSUPPORTED',
      message: '当前环境不支持流式响应',
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Holds a trailing CR whose LF may land in the next chunk.
  let carry = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // SSE permits CR, LF or CRLF as line terminators, and a proxy may rewrite
      // them. Normalising here keeps one boundary check correct for all three.
      let text = carry + decoder.decode(value, { stream: true });
      carry = '';
      if (text.endsWith('\r')) {
        carry = '\r';
        text = text.slice(0, -1);
      }
      buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // Frames are separated by a blank line. A partial frame stays in the
      // buffer until the rest of it arrives.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEventFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Abandoning the generator early (an abort, or a `break` in the consumer)
    // must release the connection so the server sees the disconnect.
    await reader.cancel().catch(() => undefined);
  }
}

function parseEventFrame(frame: string): ServerSentEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':') || line === '') continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const {
    body: requestBody,
    redirectOnUnauthorized = true,
    onUnauthorized = () => window.location.assign('/login'),
    ...fetchOptions
  } = options;
  const headers = new Headers(fetchOptions.headers);
  const token = tokenStore.getToken();
  const authRevision = tokenStore.getRevision();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let body: BodyInit | undefined;
  if (requestBody instanceof FormData) {
    body = requestBody;
  } else if (requestBody !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(requestBody);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
    body,
  });

  handleUnauthorized(response.status, redirectOnUnauthorized, authRevision, onUnauthorized);

  if (!response.ok) {
    const error = await readError(response);
    throw new ApiError(response.status, error, response.headers.get('Retry-After'));
  }

  return response;
}

function handleUnauthorized(
  status: number,
  redirectOnUnauthorized: boolean,
  authRevision: number,
  onUnauthorized: () => void,
) {
  if (status !== 401 || !redirectOnUnauthorized || tokenStore.getRevision() !== authRevision) {
    return;
  }
  tokenStore.clearToken();
  onUnauthorized();
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function readXHRResponse<T>(xhr: XMLHttpRequest): T {
  if (xhr.response !== null && xhr.response !== undefined) {
    return xhr.response as T;
  }
  const parsed = parseXHRText(xhr);
  return parsed as T;
}

function readXHRError(xhr: XMLHttpRequest): APIError {
  if (isAPIError(xhr.response)) {
    return xhr.response;
  }
  const parsed = parseXHRText(xhr);
  if (isAPIError(parsed)) {
    return parsed;
  }
  return {
    code: 'INTERNAL_ERROR',
    message: '请求失败',
    details: {},
  };
}

function parseXHRText(xhr: XMLHttpRequest): unknown {
  try {
    return xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
  } catch {
    return undefined;
  }
}

function isAPIError(value: unknown): value is APIError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<APIError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

async function readError(response: Response): Promise<APIError> {
  try {
    return (await response.json()) as APIError;
  } catch {
    return {
      code: 'INTERNAL_ERROR',
      message: '请求失败',
      details: {},
    };
  }
}

function isRateLimited(status: number, code: string): boolean {
  return status === 429 || code === 'RATE_LIMITED';
}

function readRetryAfterDetail(details: Record<string, unknown> | undefined): unknown {
  return details?.retryAfter;
}

function parseRetryAfter(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.max(1, Math.ceil(value)) : null;
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return Math.max(1, Math.ceil(Number(normalized)));
  }

  const retryAt = Date.parse(normalized);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
}
