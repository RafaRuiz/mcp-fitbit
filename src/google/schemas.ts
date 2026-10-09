/**
 * Zod schemas and request-building helpers shared by the Google Health tools
 */

import { z } from 'zod';

const CIVIL_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DURATION_REGEX = /^-?\d+(\.\d{1,9})?s$/;
const DATA_POINT_ID_REGEX =
  /^(users\/[^/]+\/dataTypes\/[a-z0-9-]+\/dataPoints\/)?[A-Za-z0-9._~-]+$/;

export const civilDateSchema = z
  .string()
  .regex(CIVIL_DATE_REGEX, 'Date must be in YYYY-MM-DD format');

export const timestampSchema = z
  .string()
  .regex(
    RFC3339_REGEX,
    'Timestamp must be RFC 3339, e.g. 2026-10-09T08:30:00Z or 2026-10-09T08:30:00+02:00'
  );

export const durationSchema = z
  .string()
  .regex(DURATION_REGEX, 'Duration must be in seconds, e.g. "7200s"');

export const utcOffsetSchema = durationSchema.describe(
  'Offset of the user\'s local time from UTC as a duration in seconds: "7200s" = UTC+2 (e.g. Spain in summer), "3600s" = UTC+1 (Spain in winter), "0s" = UTC'
);

export const dataPointIdSchema = z
  .string()
  .regex(
    DATA_POINT_ID_REGEX,
    'Expected a data point id or a full name like users/me/dataTypes/{type}/dataPoints/{id}'
  )
  .describe(
    'Data point id, or its full resource name (users/me/dataTypes/{type}/dataPoints/{id}) as returned by the API'
  );

export function dataTypePath(dataType: string): string {
  return `/users/me/dataTypes/${dataType}/dataPoints`;
}

/** Full resource name of a data point; accepts a bare id or a full name. */
export function dataPointName(dataType: string, id: string): string {
  return id.startsWith('users/')
    ? id
    : `users/me/dataTypes/${dataType}/dataPoints/${id}`;
}

export function dataSourceFamilyName(
  family: string | undefined
): string | undefined {
  return family ? `users/me/dataSourceFamilies/${family}` : undefined;
}

/** Converts YYYY-MM-DD into a google.type.Date object. */
export function toCivilDate(date: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/** Builds a SessionTimeInterval; endTime defaults to startTime. */
export function sessionInterval(
  startTime: string,
  endTime: string | undefined,
  utcOffset: string
) {
  return {
    startTime,
    endTime: endTime ?? startTime,
    startUtcOffset: utcOffset,
    endUtcOffset: utcOffset,
  };
}
