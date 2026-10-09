import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { HealthApi } from '../google/client.js';
import type { ToolExtra } from '../utils.js';
import { registerProfileTools } from './profile.js';

describe('profile tools', () => {
  it('registers profile, settings and identity tools', async () => {
    const server = { registerTool: vi.fn() };
    const api = {
      call: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    };
    const extra = {} as ToolExtra;
    registerProfileTools(
      server as unknown as McpServer,
      api as unknown as HealthApi
    );

    const calls = server.registerTool.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'get_profile',
      'get_settings',
      'get_identity',
    ]);

    for (const [, config, handler] of calls) {
      expect(config.inputSchema).toEqual({});
      expect(config.annotations.readOnlyHint).toBe(true);
      await handler({}, extra);
    }
    expect(api.call.mock.calls.map((c) => c[1].path)).toEqual([
      '/users/me/profile',
      '/users/me/settings',
      '/users/me/identity',
    ]);
  });
});
