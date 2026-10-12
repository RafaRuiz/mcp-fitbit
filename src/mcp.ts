/**
 * Builds the MCP server and registers every tool. A fresh server is created
 * per HTTP request (stateless Streamable HTTP).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HealthApi } from './google/client.js';
import { registerDataPointTools } from './tools/data-points.js';
import { registerHydrationTools } from './tools/hydration.js';
import { registerNutritionTools } from './tools/nutrition.js';
import { registerProfileTools } from './tools/profile.js';

export const SERVER_INFO = { name: 'google-health', version: '2.0.0' };

export function createMcpServer(api: HealthApi): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      'Tools for the user\'s Google Health (Fitbit) data. Read with list_data_points, reconcile_data_points, daily_rollup and rollup; log food and water with log_food and log_water. Only entries created through this connector can be deleted or edited; anything else must be changed in the Fitbit or Google Health app. Nutrient quantities are always in grams and UTC offsets are durations such as "7200s".',
  });
  registerDataPointTools(server, api);
  registerProfileTools(server, api);
  registerNutritionTools(server, api);
  registerHydrationTools(server, api);
  return server;
}
