import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExtra } from '../utils.js';
import {
  buildUrl,
  createHealthApi,
  formatHealthError,
  toToolResponse,
} from './client.js';

const BASE = 'https://health.test/v4';
const extra = { signal: new AbortController().signal } as ToolExtra;

function jsonResponse(status: number, body: unknown, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('buildUrl', () => {
  it('joins the path and skips empty query values', () => {
    expect(
      buildUrl(`${BASE}/`, '/users/me/dataTypes/steps/dataPoints', {
        filter: 'steps.interval.civil_start_time >= "2026-10-01"',
        pageSize: 10,
        pageToken: undefined,
        dataSourceFamily: '',
      })
    ).toBe(
      `${BASE}/users/me/dataTypes/steps/dataPoints?filter=steps.interval.civil_start_time+%3E%3D+%222026-10-01%22&pageSize=10`
    );
  });
});

describe('createHealthApi', () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const sleep = vi.fn(async () => {});
  const getToken = vi.fn(async () => 'token-1');

  beforeEach(() => {
    fetchImpl.mockReset();
    sleep.mockClear();
    getToken.mockReset();
    getToken.mockResolvedValue('token-1');
  });

  const api = () =>
    createHealthApi({ getToken, baseUrl: BASE, fetchImpl, sleep });

  it('sends GET requests with the bearer token and returns raw JSON', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, { dataPoints: [] }));

    const result = await api().call(extra, {
      path: '/users/me/profile',
    });

    expect(result).toEqual({ ok: true, status: 200, data: { dataPoints: [] } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/users/me/profile`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-1'
    );
    expect(getToken).toHaveBeenCalledWith(extra);
  });

  it('serializes JSON bodies and treats empty bodies as {}', async () => {
    fetchImpl.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await api().call(extra, {
      method: 'POST',
      path: '/x',
      body: { a: 1 },
    });

    expect(result).toEqual({ ok: true, status: 200, data: {} });
    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('returns Google errors with their status', async () => {
    const error = {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad filter' },
    };
    fetchImpl.mockResolvedValue(jsonResponse(400, error));

    const result = await api().call(extra, { path: '/x' });

    expect(result).toEqual({ ok: false, status: 400, error });
  });

  it('keeps non-JSON error bodies as text', async () => {
    fetchImpl.mockResolvedValue(new Response('oops', { status: 500 }));

    const result = await api().call(extra, {
      method: 'POST',
      path: '/x',
    });

    expect(result).toEqual({ ok: false, status: 500, error: 'oops' });
  });

  it('retries 429 honouring Retry-After', async () => {
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await api().call(extra, {
      method: 'POST',
      path: '/x',
      body: {},
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries 503 for idempotent requests up to maxRetries', async () => {
    fetchImpl.mockImplementation(async () => jsonResponse(503, {}));

    const result = await api().call(extra, { path: '/x' });

    expect(result).toEqual({ ok: false, status: 503, error: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry 503 for writes', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(503, {}));

    await api().call(extra, { method: 'POST', path: '/x', body: {} });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token and retries once on 401', async () => {
    getToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(401, { error: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await api().call(extra, { path: '/x' });

    expect(result.ok).toBe(true);
    expect(getToken).toHaveBeenLastCalledWith(extra, { forceRefresh: true });
    const secondHeaders = fetchImpl.mock.calls[1][1]!.headers as Record<
      string,
      string
    >;
    expect(secondHeaders.Authorization).toBe('Bearer fresh');
  });

  it('returns the 401 when the forced refresh fails', async () => {
    getToken
      .mockResolvedValueOnce('stale')
      .mockRejectedValueOnce(new Error('revoked'));
    fetchImpl.mockResolvedValue(jsonResponse(401, { error: {} }));

    const result = await api().call(extra, { path: '/x' });

    expect(result).toEqual({ ok: false, status: 401, error: { error: {} } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports token errors without calling the API', async () => {
    getToken.mockRejectedValue(new Error('Reconnect the connector'));

    const result = await api().call(extra, { path: '/x' });

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: { message: 'Reconnect the connector' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports network errors as status 0', async () => {
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));

    const result = await api().call(extra, { path: '/x' });

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: { message: 'ECONNRESET' },
    });
  });
});

describe('formatHealthError / toToolResponse', () => {
  it('formats Google error payloads', () => {
    const text = formatHealthError(403, {
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'nope' },
    });
    expect(text).toMatch(
      /^Google Health API error 403 PERMISSION_DENIED: nope\n/
    );
  });

  it('formats other failures', () => {
    expect(formatHealthError(0, { message: 'timeout' })).toBe(
      'Google Health API request failed: timeout'
    );
    expect(formatHealthError(401, { message: 'Reconnect' })).toBe(
      'Not authorized: Reconnect'
    );
    expect(formatHealthError(500, 'oops')).toBe(
      'Google Health API error 500: oops'
    );
  });

  it('builds MCP tool responses', () => {
    expect(toToolResponse({ ok: true, status: 200, data: { a: 1 } })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }],
    });
    expect(toToolResponse({ ok: false, status: 500, error: 'oops' })).toEqual({
      content: [{ type: 'text', text: 'Google Health API error 500: oops' }],
      isError: true,
    });
  });
});
