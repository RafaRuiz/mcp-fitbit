/**
 * Minimal Google Health API client: authorization, retries and error
 * pass-through. Responses are returned as raw JSON, exactly as the API sends
 * them, so tools act as a 1:1 proxy.
 */

import { HEALTH_API_BASE, HTTP_CONFIG } from '../config.js';
import {
  createErrorResponse,
  createSuccessResponse,
  type ToolExtra,
  type ToolResponseStructure,
} from '../utils.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface HealthRequest {
  method?: HttpMethod;
  /** Path below the API base, e.g. /users/me/dataTypes/steps/dataPoints */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Safe to retry on 5xx. Defaults to true for GET requests only. */
  idempotent?: boolean;
}

export type HealthResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: unknown };

/** Returns a Google access token for the user behind this MCP request. */
export type GetToken = (
  extra: ToolExtra,
  options?: { forceRefresh?: boolean }
) => Promise<string>;

export interface HealthApi {
  call<T = unknown>(
    extra: ToolExtra,
    request: HealthRequest
  ): Promise<HealthResult<T>>;
}

export interface HealthApiOptions {
  getToken: GetToken;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([429, 503, 504]);
const MAX_BACKOFF_MS = 8000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildUrl(
  baseUrl: string,
  path: string,
  query: HealthRequest['query'] = {}
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  const base = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  return base / 2 + Math.random() * (base / 2);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHealthApi(options: HealthApiOptions): HealthApi {
  const {
    getToken,
    baseUrl = HEALTH_API_BASE,
    maxRetries = HTTP_CONFIG.MAX_RETRIES,
    timeoutMs = HTTP_CONFIG.TIMEOUT_MS,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = options;

  async function send<T>(
    token: string,
    request: HealthRequest,
    signal: AbortSignal | undefined
  ): Promise<HealthResult<T>> {
    const method = request.method ?? 'GET';
    const idempotent = request.idempotent ?? method === 'GET';
    const url = buildUrl(baseUrl, request.path, request.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': HTTP_CONFIG.USER_AGENT,
    };
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body:
            request.body === undefined
              ? undefined
              : JSON.stringify(request.body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        console.error(`Google Health request failed: ${method} ${url}`, error);
        return {
          ok: false,
          status: 0,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      const retryable =
        response.status === 429 ||
        (idempotent && RETRYABLE_STATUSES.has(response.status));
      if (retryable && attempt < maxRetries) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      const data = await parseBody(response);
      if (!response.ok) {
        console.error(
          `Google Health API error ${response.status}: ${method} ${url}`
        );
        return { ok: false, status: response.status, error: data };
      }
      return { ok: true, status: response.status, data: data as T };
    }
  }

  return {
    async call<T>(
      extra: ToolExtra,
      request: HealthRequest
    ): Promise<HealthResult<T>> {
      let token: string;
      try {
        token = await getToken(extra);
      } catch (error) {
        return {
          ok: false,
          status: 401,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      const result = await send<T>(token, request, extra.signal);
      if (result.status !== 401) {
        return result;
      }

      // Google rejected the access token (revoked or expired early):
      // force a refresh and retry once.
      try {
        token = await getToken(extra, { forceRefresh: true });
      } catch {
        return result;
      }
      return send<T>(token, request, extra.signal);
    },
  };
}

/** Formats a Google error payload ({ error: { code, status, message } }). */
export function formatHealthError(status: number, error: unknown): string {
  const details =
    typeof error === 'string' ? error : JSON.stringify(error, null, 2);
  const googleError = (
    error as { error?: { status?: string; message?: string } } | null
  )?.error;
  if (googleError?.message) {
    const code = googleError.status ? ` ${googleError.status}` : '';
    return `Google Health API error ${status}${code}: ${googleError.message}\n${details}`;
  }
  const message = (error as { message?: string } | null)?.message;
  if (status === 0) {
    return `Google Health API request failed: ${message ?? details}`;
  }
  if (status === 401 && message) {
    return `Not authorized: ${message}`;
  }
  return `Google Health API error ${status}: ${details}`;
}

export function toToolResponse(result: HealthResult): ToolResponseStructure {
  return result.ok
    ? createSuccessResponse(result.data)
    : createErrorResponse(formatHealthError(result.status, result.error));
}
