/**
 * Hydration write tools (hydration-log create, patch and batchDelete).
 *
 * Reading water logs uses the generic tools: list_data_points / daily_rollup
 * with dataType hydration-log.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type HealthApi, toToolResponse } from '../google/client.js';
import { VOLUME_UNITS } from '../google/data-types.js';
import {
  dataPointIdSchema,
  dataPointName,
  dataTypePath,
  sessionInterval,
  timestampSchema,
  utcOffsetSchema,
} from '../google/schemas.js';
import {
  DELETE_ANNOTATIONS,
  registerTool,
  WRITE_ANNOTATIONS,
} from '../utils.js';

const HYDRATION_LOG = 'hydration-log';

const hydrationLogShape = {
  startTime: timestampSchema.describe(
    'When the liquid was drunk (RFC 3339), e.g. 2026-10-09T11:00:00+02:00'
  ),
  endTime: timestampSchema
    .optional()
    .describe(
      'End of the interval (RFC 3339), strictly after startTime. Defaults to startTime + 1 minute'
    ),
  utcOffset: utcOffsetSchema,
  milliliters: z
    .number()
    .gt(0)
    .max(100000)
    .describe('Amount consumed in milliliters'),
  userProvidedUnit: z
    .enum(VOLUME_UNITS)
    .optional()
    .describe('Unit the user expressed the amount in (display only)'),
};

type HydrationLogParams = z.objectOutputType<
  typeof hydrationLogShape,
  z.ZodTypeAny
>;

function buildHydrationLog(params: HydrationLogParams) {
  return {
    interval: sessionInterval(
      params.startTime,
      params.endTime,
      params.utcOffset
    ),
    amountConsumed: {
      milliliters: params.milliliters,
      userProvidedUnit: params.userProvidedUnit,
    },
  };
}

export function registerHydrationTools(server: McpServer, api: HealthApi) {
  registerTool(server, {
    name: 'log_water',
    description:
      'Log water or other liquid drunk (POST users/me/dataTypes/hydration-log/dataPoints). Returns the raw Operation; the created data point is in response.name.',
    inputSchema: hydrationLogShape,
    annotations: WRITE_ANNOTATIONS,
    handler: async (params, extra) =>
      toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: dataTypePath(HYDRATION_LOG),
          body: { hydrationLog: buildHydrationLog(params) },
        })
      ),
  });

  registerTool(server, {
    name: 'update_water_log',
    description:
      'Replace an existing water log entry (PATCH users/me/dataTypes/hydration-log/dataPoints/{id}). Send the full entry, not only the changed fields.',
    inputSchema: { dataPointId: dataPointIdSchema, ...hydrationLogShape },
    annotations: WRITE_ANNOTATIONS,
    handler: async ({ dataPointId, ...params }, extra) => {
      const name = dataPointName(HYDRATION_LOG, dataPointId);
      return toToolResponse(
        await api.call(extra, {
          method: 'PATCH',
          path: `/${name}`,
          body: { name, hydrationLog: buildHydrationLog(params) },
        })
      );
    },
  });

  registerTool(server, {
    name: 'delete_water_logs',
    description:
      'Delete water log entries (POST users/me/dataTypes/hydration-log/dataPoints:batchDelete). Entries created by other apps may not be deletable.',
    inputSchema: {
      dataPointIds: z
        .array(dataPointIdSchema)
        .min(1)
        .max(10000)
        .describe('Ids or full names of the hydration-log data points'),
    },
    annotations: DELETE_ANNOTATIONS,
    handler: async ({ dataPointIds }, extra) =>
      toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: `${dataTypePath(HYDRATION_LOG)}:batchDelete`,
          body: {
            names: dataPointIds.map((id) => dataPointName(HYDRATION_LOG, id)),
          },
        })
      ),
  });
}
