/**
 * Generic read tools mapping 1:1 to the Google Health API dataPoints methods:
 * list, get, reconcile, rollUp and dailyRollUp.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type HealthApi, toToolResponse } from '../google/client.js';
import {
  DATA_SOURCE_FAMILIES,
  GET_DATA_TYPES,
  LIST_DATA_TYPES,
  RECONCILE_DATA_TYPES,
  ROLLUP_DATA_TYPES,
} from '../google/data-types.js';
import {
  civilDateSchema,
  dataPointIdSchema,
  dataPointName,
  dataSourceFamilyName,
  dataTypePath,
  durationSchema,
  timestampSchema,
  toCivilDate,
} from '../google/schemas.js';
import { READ_ONLY_ANNOTATIONS, registerTool } from '../utils.js';

const FILTER_HELP = `Optional AIP-160 filter on time (operators >= and <, combined with AND). Field names are snake_case versions of the data type and depend on its kind:
- Interval types (steps, distance, active-minutes, heart-rate, nutrition-log, hydration-log...): {type}.interval.civil_start_time >= "2026-10-01" AND {type}.interval.civil_start_time < "2026-10-08" (or .interval.start_time with RFC 3339 timestamps)
- Sample types (weight, height, body-fat...): weight.sample_time.civil_time >= "2026-10-01" (or .sample_time.physical_time with RFC 3339)
- Daily summary types (daily-resting-heart-rate, daily-heart-rate-variability...): daily_resting_heart_rate.date >= "2026-10-01"
- Sessions: exercise.interval.civil_start_time >= "2026-10-01"; sleep can ONLY be filtered by end time: sleep.interval.civil_end_time >= "2026-10-01" (or sleep.interval.end_time)
Example: nutrition_log.interval.civil_start_time >= "2026-10-09" AND nutrition_log.interval.civil_start_time < "2026-10-10"`;

const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .optional()
  .describe(
    'Maximum number of data points to return (default 1440, max 10000; exercise and sleep: default and max 25)'
  );

const pageTokenSchema = z
  .string()
  .optional()
  .describe('nextPageToken from a previous response, to fetch the next page');

const dataSourceFamilySchema = z
  .enum(DATA_SOURCE_FAMILIES)
  .optional()
  .describe(
    'Restrict to a data source family (users/me/dataSourceFamilies/{family}). all-sources (default), google-wearables (trackers only, no manual logs), google-sources (first-party Google incl. manual logs), self-sources (only data written by this server). Not supported for sleep, food and food-measurement-unit.'
  );

export function registerDataPointTools(server: McpServer, api: HealthApi) {
  registerTool(server, {
    name: 'list_data_points',
    description:
      'List raw data points of a Google Health data type (GET users/me/dataTypes/{dataType}/dataPoints). Results are ordered by start time, newest first. Returns the raw API response, including nextPageToken when more pages exist.',
    inputSchema: {
      dataType: z.enum(LIST_DATA_TYPES).describe('Data type to list'),
      filter: z.string().optional().describe(FILTER_HELP),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema,
      dataSourceFamily: dataSourceFamilySchema,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (
      { dataType, filter, pageSize, pageToken, dataSourceFamily },
      extra
    ) =>
      toToolResponse(
        await api.call(extra, {
          path: dataTypePath(dataType),
          query: {
            filter,
            pageSize,
            pageToken,
            dataSourceFamily: dataSourceFamilyName(dataSourceFamily),
          },
        })
      ),
  });

  registerTool(server, {
    name: 'get_data_point',
    description:
      'Get a single data point by id (GET users/me/dataTypes/{dataType}/dataPoints/{id}). Use it e.g. to read a food (dataType food) or a measurement unit.',
    inputSchema: {
      dataType: z.enum(GET_DATA_TYPES).describe('Data type of the data point'),
      dataPointId: dataPointIdSchema,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async ({ dataType, dataPointId }, extra) =>
      toToolResponse(
        await api.call(extra, {
          path: `/${dataPointName(dataType, dataPointId)}`,
        })
      ),
  });

  registerTool(server, {
    name: 'reconcile_data_points',
    description:
      'List data points merged across data sources, removing overlaps between devices and manual entries (GET users/me/dataTypes/{dataType}/dataPoints:reconcile). Preferred over list_data_points for sleep. Takes the same filter syntax as list_data_points.',
    inputSchema: {
      dataType: z.enum(RECONCILE_DATA_TYPES).describe('Data type to reconcile'),
      filter: z.string().optional().describe(FILTER_HELP),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema,
      dataSourceFamily: dataSourceFamilySchema,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (
      { dataType, filter, pageSize, pageToken, dataSourceFamily },
      extra
    ) =>
      toToolResponse(
        await api.call(extra, {
          path: `${dataTypePath(dataType)}:reconcile`,
          query: {
            filter,
            pageSize,
            pageToken,
            dataSourceFamily: dataSourceFamilyName(dataSourceFamily),
          },
        })
      ),
  });

  registerTool(server, {
    name: 'daily_rollup',
    description:
      "Aggregate a data type into daily buckets in the user's civil time (POST users/me/dataTypes/{dataType}/dataPoints:dailyRollUp). Use it for daily totals: steps, calories (total-calories), distance, active zone minutes, nutrition-log (energy and nutrients eaten), hydration-log (water drunk), etc. Range is closed-open [startDate, endDate). Maximum range: 14 days for heart-rate, active-minutes, total-calories and calories-in-heart-rate-zone; 90 days for the rest.",
    inputSchema: {
      dataType: z.enum(ROLLUP_DATA_TYPES).describe('Data type to roll up'),
      startDate: civilDateSchema.describe('Inclusive start date (YYYY-MM-DD)'),
      endDate: civilDateSchema.describe(
        'Exclusive end date (YYYY-MM-DD). For a single day D use endDate = D + 1'
      ),
      windowSizeDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Bucket size in days (default 1)'),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema,
      dataSourceFamily: dataSourceFamilySchema,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (
      {
        dataType,
        startDate,
        endDate,
        windowSizeDays,
        pageSize,
        pageToken,
        dataSourceFamily,
      },
      extra
    ) =>
      toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: `${dataTypePath(dataType)}:dailyRollUp`,
          idempotent: true,
          body: {
            range: {
              start: { date: toCivilDate(startDate) },
              end: { date: toCivilDate(endDate) },
            },
            windowSizeDays,
            pageSize,
            pageToken,
            dataSourceFamily: dataSourceFamilyName(dataSourceFamily),
          },
        })
      ),
  });

  registerTool(server, {
    name: 'rollup',
    description:
      'Aggregate a data type into fixed-size windows over a physical time range (POST users/me/dataTypes/{dataType}/dataPoints:rollUp), e.g. hourly steps or heart rate min/avg/max. Range is closed-open [startTime, endTime). Same maximum ranges as daily_rollup.',
    inputSchema: {
      dataType: z.enum(ROLLUP_DATA_TYPES).describe('Data type to roll up'),
      startTime: timestampSchema.describe(
        'Inclusive start (RFC 3339 timestamp)'
      ),
      endTime: timestampSchema.describe('Exclusive end (RFC 3339 timestamp)'),
      windowSize: durationSchema.describe(
        'Window size as a duration in seconds, e.g. "3600s" for hourly buckets'
      ),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema,
      dataSourceFamily: dataSourceFamilySchema,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (
      {
        dataType,
        startTime,
        endTime,
        windowSize,
        pageSize,
        pageToken,
        dataSourceFamily,
      },
      extra
    ) =>
      toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: `${dataTypePath(dataType)}:rollUp`,
          idempotent: true,
          body: {
            range: { startTime, endTime },
            windowSize,
            pageSize,
            pageToken,
            dataSourceFamily: dataSourceFamilyName(dataSourceFamily),
          },
        })
      ),
  });
}
