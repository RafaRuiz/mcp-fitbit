import { describe, expect, it } from 'vitest';
import {
  civilDateSchema,
  dataPointIdSchema,
  dataPointName,
  dataSourceFamilyName,
  durationSchema,
  sessionInterval,
  timestampSchema,
  toCivilDate,
} from './schemas.js';

describe('schemas', () => {
  it('validates civil dates', () => {
    expect(civilDateSchema.safeParse('2026-10-09').success).toBe(true);
    expect(civilDateSchema.safeParse('09/10/2026').success).toBe(false);
  });

  it('validates RFC 3339 timestamps', () => {
    expect(timestampSchema.safeParse('2026-10-09T08:30:00Z').success).toBe(
      true
    );
    expect(
      timestampSchema.safeParse('2026-10-09T08:30:00.123+02:00').success
    ).toBe(true);
    expect(timestampSchema.safeParse('2026-10-09T08:30:00').success).toBe(
      false
    );
  });

  it('validates durations', () => {
    expect(durationSchema.safeParse('7200s').success).toBe(true);
    expect(durationSchema.safeParse('-3600s').success).toBe(true);
    expect(durationSchema.safeParse('+02:00').success).toBe(false);
  });

  it('validates data point ids and names', () => {
    expect(dataPointIdSchema.safeParse('abc-123').success).toBe(true);
    expect(
      dataPointIdSchema.safeParse(
        'users/me/dataTypes/nutrition-log/dataPoints/abc-123'
      ).success
    ).toBe(true);
    expect(dataPointIdSchema.safeParse('../profile').success).toBe(false);
    expect(dataPointIdSchema.safeParse('a/b').success).toBe(false);
  });
});

describe('helpers', () => {
  it('builds data point names from ids', () => {
    expect(dataPointName('hydration-log', 'abc')).toBe(
      'users/me/dataTypes/hydration-log/dataPoints/abc'
    );
    expect(
      dataPointName(
        'hydration-log',
        'users/123/dataTypes/hydration-log/dataPoints/abc'
      )
    ).toBe('users/123/dataTypes/hydration-log/dataPoints/abc');
  });

  it('builds data source family names', () => {
    expect(dataSourceFamilyName('self-sources')).toBe(
      'users/me/dataSourceFamilies/self-sources'
    );
    expect(dataSourceFamilyName(undefined)).toBeUndefined();
  });

  it('converts civil dates', () => {
    expect(toCivilDate('2026-10-09')).toEqual({
      year: 2026,
      month: 10,
      day: 9,
    });
  });

  it('builds session intervals ending one minute later by default', () => {
    expect(
      sessionInterval('2026-10-09T08:00:00+02:00', undefined, '7200s')
    ).toEqual({
      startTime: '2026-10-09T08:00:00+02:00',
      endTime: '2026-10-09T06:01:00.000Z',
      startUtcOffset: '7200s',
      endUtcOffset: '7200s',
    });
  });

  it('keeps an explicit end time', () => {
    expect(
      sessionInterval('2026-10-09T08:00:00Z', '2026-10-09T08:30:00Z', '0s')
        .endTime
    ).toBe('2026-10-09T08:30:00Z');
  });
});
