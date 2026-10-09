import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthApi } from '../google/client.js';
import type { ToolExtra } from '../utils.js';
import { registerHydrationTools } from './hydration.js';

const extra = {} as ToolExtra;

const expectedLog = {
  interval: {
    startTime: '2026-10-09T11:00:00+02:00',
    endTime: '2026-10-09T11:00:00+02:00',
    startUtcOffset: '7200s',
    endUtcOffset: '7200s',
  },
  amountConsumed: { milliliters: 250, userProvidedUnit: 'MILLILITER' },
};

describe('hydration tools', () => {
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
    api.call.mockResolvedValue({ ok: true, status: 200, data: {} });
    registerHydrationTools(
      server as unknown as McpServer,
      api as unknown as HealthApi
    );
  });

  it('registers the water tools', () => {
    expect(server.registerTool.mock.calls.map((c) => c[0])).toEqual([
      'log_water',
      'update_water_log',
      'delete_water_logs',
    ]);
  });

  it('log_water creates a hydration log', async () => {
    await tool('log_water').handler(
      {
        startTime: '2026-10-09T11:00:00+02:00',
        utcOffset: '7200s',
        milliliters: 250,
        userProvidedUnit: 'MILLILITER',
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/hydration-log/dataPoints',
      body: { hydrationLog: expectedLog },
    });
  });

  it('update_water_log patches the full data point', async () => {
    await tool('update_water_log').handler(
      {
        dataPointId: 'abc',
        startTime: '2026-10-09T11:00:00+02:00',
        utcOffset: '7200s',
        milliliters: 250,
        userProvidedUnit: 'MILLILITER',
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'PATCH',
      path: '/users/me/dataTypes/hydration-log/dataPoints/abc',
      body: {
        name: 'users/me/dataTypes/hydration-log/dataPoints/abc',
        hydrationLog: expectedLog,
      },
    });
  });

  it('delete_water_logs batch deletes by name', async () => {
    await tool('delete_water_logs').handler(
      { dataPointIds: ['a', 'b'] },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/hydration-log/dataPoints:batchDelete',
      body: {
        names: [
          'users/me/dataTypes/hydration-log/dataPoints/a',
          'users/me/dataTypes/hydration-log/dataPoints/b',
        ],
      },
    });
  });
});
