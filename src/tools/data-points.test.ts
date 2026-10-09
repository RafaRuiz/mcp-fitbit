import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { HealthApi } from '../google/client.js';
import type { ToolExtra } from '../utils.js';
import { registerDataPointTools } from './data-points.js';

const extra = {} as ToolExtra;

describe('data point tools', () => {
  const server = { registerTool: vi.fn() };
  const api = { call: vi.fn() };

  const tool = (name: string) => {
    const call = server.registerTool.mock.calls.find((c) => c[0] === name);
    if (!call) throw new Error(`Tool ${name} not registered`);
    return { config: call[1], handler: call[2] };
  };

  beforeEach(() => {
    server.registerTool.mockReset();
    api.call.mockReset();
    api.call.mockResolvedValue({ ok: true, status: 200, data: { ok: 1 } });
    registerDataPointTools(
      server as unknown as McpServer,
      api as unknown as HealthApi
    );
  });

  it('registers the read tools as read-only', () => {
    expect(server.registerTool.mock.calls.map((c) => c[0])).toEqual([
      'list_data_points',
      'get_data_point',
      'reconcile_data_points',
      'daily_rollup',
      'rollup',
    ]);
    for (const call of server.registerTool.mock.calls) {
      expect(call[1].annotations.readOnlyHint).toBe(true);
    }
  });

  it('list_data_points sends the query parameters', async () => {
    const result = await tool('list_data_points').handler(
      {
        dataType: 'weight',
        filter: 'weight.sample_time.civil_time >= "2026-10-01"',
        pageSize: 50,
        pageToken: 'next',
        dataSourceFamily: 'google-wearables',
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      path: '/users/me/dataTypes/weight/dataPoints',
      query: {
        filter: 'weight.sample_time.civil_time >= "2026-10-01"',
        pageSize: 50,
        pageToken: 'next',
        dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
      },
    });
    expect(result.content[0].text).toBe(JSON.stringify({ ok: 1 }, null, 2));
  });

  it('list_data_points validates the data type', () => {
    const schema = z.object(tool('list_data_points').config.inputSchema);
    expect(schema.safeParse({ dataType: 'steps' }).success).toBe(true);
    expect(schema.safeParse({ dataType: 'total-calories' }).success).toBe(
      false
    );
  });

  it('get_data_point accepts bare ids and full names', async () => {
    await tool('get_data_point').handler(
      { dataType: 'food', dataPointId: 'abc' },
      extra
    );
    await tool('get_data_point').handler(
      {
        dataType: 'food',
        dataPointId: 'users/me/dataTypes/food/dataPoints/xyz',
      },
      extra
    );

    expect(api.call.mock.calls[0][1]).toEqual({
      path: '/users/me/dataTypes/food/dataPoints/abc',
    });
    expect(api.call.mock.calls[1][1]).toEqual({
      path: '/users/me/dataTypes/food/dataPoints/xyz',
    });
  });

  it('reconcile_data_points calls :reconcile', async () => {
    await tool('reconcile_data_points').handler(
      {
        dataType: 'sleep',
        filter: 'sleep.interval.civil_end_time >= "2026-10-01"',
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      path: '/users/me/dataTypes/sleep/dataPoints:reconcile',
      query: {
        filter: 'sleep.interval.civil_end_time >= "2026-10-01"',
        pageSize: undefined,
        pageToken: undefined,
        dataSourceFamily: undefined,
      },
    });
  });

  it('daily_rollup posts civil date ranges', async () => {
    await tool('daily_rollup').handler(
      {
        dataType: 'nutrition-log',
        startDate: '2026-10-01',
        endDate: '2026-10-08',
        windowSizeDays: 7,
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/nutrition-log/dataPoints:dailyRollUp',
      idempotent: true,
      body: {
        range: {
          start: { date: { year: 2026, month: 10, day: 1 } },
          end: { date: { year: 2026, month: 10, day: 8 } },
        },
        windowSizeDays: 7,
        pageSize: undefined,
        pageToken: undefined,
        dataSourceFamily: undefined,
      },
    });
  });

  it('rollup posts physical time ranges', async () => {
    await tool('rollup').handler(
      {
        dataType: 'heart-rate',
        startTime: '2026-10-09T00:00:00Z',
        endTime: '2026-10-10T00:00:00Z',
        windowSize: '3600s',
        dataSourceFamily: 'all-sources',
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/heart-rate/dataPoints:rollUp',
      idempotent: true,
      body: {
        range: {
          startTime: '2026-10-09T00:00:00Z',
          endTime: '2026-10-10T00:00:00Z',
        },
        windowSize: '3600s',
        pageSize: undefined,
        pageToken: undefined,
        dataSourceFamily: 'users/me/dataSourceFamilies/all-sources',
      },
    });
  });

  it('returns API errors as tool errors', async () => {
    api.call.mockResolvedValue({
      ok: false,
      status: 400,
      error: { error: { status: 'INVALID_ARGUMENT', message: 'bad filter' } },
    });

    const result = await tool('list_data_points').handler(
      { dataType: 'steps', filter: 'nonsense' },
      extra
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Google Health API error 400 INVALID_ARGUMENT: bad filter'
    );
  });
});
