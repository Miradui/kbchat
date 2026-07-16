import { tokenStore } from '../store/tokenStore';
import type { APIError } from '../types/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;
  status: number;

  constructor(status: number, error: APIError) {
    super(error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.details = error.details ?? {};
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  redirectOnUnauthorized?: boolean;
  onUnauthorized?: () => void;
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

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const {
    body: requestBody,
    redirectOnUnauthorized = true,
    onUnauthorized = () => window.location.assign('/login'),
    ...fetchOptions
  } = options;
  const headers = new Headers(fetchOptions.headers);
  const token = tokenStore.getToken();

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

  if (response.status === 401 && redirectOnUnauthorized) {
    tokenStore.clearToken();
    onUnauthorized();
  }

  if (!response.ok) {
    const error = await readError(response);
    throw new ApiError(response.status, error);
  }

  return response;
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
