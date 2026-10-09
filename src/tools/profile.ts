/**
 * User-level tools: profile, settings and identity
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type HealthApi, toToolResponse } from '../google/client.js';
import { READ_ONLY_ANNOTATIONS, registerTool } from '../utils.js';

const USER_ENDPOINTS = [
  {
    name: 'get_profile',
    path: '/users/me/profile',
    description:
      "Get the user's Google Health profile (GET users/me/profile): age, membership start date and stride lengths.",
  },
  {
    name: 'get_settings',
    path: '/users/me/settings',
    description:
      "Get the user's Google Health settings (GET users/me/settings): units, time zone, UTC offset, language and food locale. Use utcOffset from here when logging food or water.",
  },
  {
    name: 'get_identity',
    path: '/users/me/identity',
    description:
      "Get the user's identity (GET users/me/identity): Google Health user id and legacy Fitbit user id.",
  },
] as const;

export function registerProfileTools(server: McpServer, api: HealthApi) {
  for (const endpoint of USER_ENDPOINTS) {
    registerTool(server, {
      name: endpoint.name,
      description: endpoint.description,
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (_params, extra) =>
        toToolResponse(await api.call(extra, { path: endpoint.path })),
    });
  }
}
