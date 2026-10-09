import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { HealthApi } from '../google/client.js';
import type { ToolExtra } from '../utils.js';
import { registerNutritionTools } from './nutrition.js';

const extra = {} as ToolExtra;

describe('nutrition tools', () => {
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
    api.call.mockResolvedValue({
      ok: true,
      status: 200,
      data: { done: true },
    });
    registerNutritionTools(
      server as unknown as McpServer,
      api as unknown as HealthApi
    );
  });

  it('registers log_food and delete_food_logs', () => {
    expect(server.registerTool.mock.calls.map((c) => c[0])).toEqual([
      'log_food',
      'delete_food_logs',
    ]);
    expect(tool('delete_food_logs').config.annotations.destructiveHint).toBe(
      true
    );
  });

  it('log_food builds an anonymous nutrition log in grams', async () => {
    await tool('log_food').handler(
      {
        startTime: '2026-10-09T08:30:00+02:00',
        utcOffset: '7200s',
        mealType: 'BREAKFAST',
        foodDisplayName: 'Huevos revueltos',
        energyKcal: 250,
        energyFromFatKcal: 150,
        totalCarbohydrateGrams: 1.2,
        totalFatGrams: 17,
        nutrients: [
          { nutrient: 'PROTEIN', grams: 19 },
          { nutrient: 'SODIUM', grams: 0.4 },
        ],
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/nutrition-log/dataPoints',
      body: {
        nutritionLog: {
          interval: {
            startTime: '2026-10-09T08:30:00+02:00',
            endTime: '2026-10-09T08:30:00+02:00',
            startUtcOffset: '7200s',
            endUtcOffset: '7200s',
          },
          mealType: 'BREAKFAST',
          food: undefined,
          foodDisplayName: 'Huevos revueltos',
          serving: undefined,
          energy: { kcal: 250 },
          energyFromFat: { kcal: 150 },
          totalCarbohydrate: { grams: 1.2 },
          totalFat: { grams: 17 },
          nutrients: [
            { nutrient: 'PROTEIN', quantity: { grams: 19 } },
            { nutrient: 'SODIUM', quantity: { grams: 0.4 } },
          ],
        },
      },
    });
  });

  it('log_food supports identified food with a serving', async () => {
    await tool('log_food').handler(
      {
        startTime: '2026-10-09T13:00:00Z',
        endTime: '2026-10-09T13:30:00Z',
        utcOffset: '7200s',
        food: 'users/me/dataTypes/food/dataPoints/123',
        foodMeasurementUnit:
          'users/me/dataTypes/food-measurement-unit/dataPoints/147',
        servingAmount: 2,
      },
      extra
    );

    const body = api.call.mock.calls[0][1].body;
    expect(body.nutritionLog.food).toBe(
      'users/me/dataTypes/food/dataPoints/123'
    );
    expect(body.nutritionLog.interval.endTime).toBe('2026-10-09T13:30:00Z');
    expect(body.nutritionLog.serving).toEqual({
      foodMeasurementUnit:
        'users/me/dataTypes/food-measurement-unit/dataPoints/147',
      amount: 2,
    });
    expect(body.nutritionLog.energy).toBeUndefined();
  });

  it('log_food requires exactly one of food and foodDisplayName', async () => {
    const neither = await tool('log_food').handler(
      { startTime: '2026-10-09T13:00:00Z', utcOffset: '0s' },
      extra
    );
    const both = await tool('log_food').handler(
      {
        startTime: '2026-10-09T13:00:00Z',
        utcOffset: '0s',
        food: 'users/me/dataTypes/food/dataPoints/1',
        foodDisplayName: 'x',
      },
      extra
    );

    expect(neither.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(api.call).not.toHaveBeenCalled();
  });

  it('log_food requires a unit for servingAmount', async () => {
    const result = await tool('log_food').handler(
      {
        startTime: '2026-10-09T13:00:00Z',
        utcOffset: '0s',
        foodDisplayName: 'x',
        servingAmount: 1,
      },
      extra
    );
    expect(result.isError).toBe(true);
  });

  it('log_food schema rejects unknown nutrients and bad offsets', () => {
    const schema = z.object(tool('log_food').config.inputSchema);
    const valid = {
      startTime: '2026-10-09T13:00:00Z',
      utcOffset: '7200s',
      foodDisplayName: 'x',
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, utcOffset: '+02:00' }).success).toBe(
      false
    );
    expect(
      schema.safeParse({
        ...valid,
        nutrients: [{ nutrient: 'VITAMIN_Z', grams: 1 }],
      }).success
    ).toBe(false);
  });

  it('delete_food_logs batch deletes by name', async () => {
    await tool('delete_food_logs').handler(
      {
        dataPointIds: [
          'abc',
          'users/me/dataTypes/nutrition-log/dataPoints/def',
        ],
      },
      extra
    );

    expect(api.call).toHaveBeenCalledWith(extra, {
      method: 'POST',
      path: '/users/me/dataTypes/nutrition-log/dataPoints:batchDelete',
      body: {
        names: [
          'users/me/dataTypes/nutrition-log/dataPoints/abc',
          'users/me/dataTypes/nutrition-log/dataPoints/def',
        ],
      },
    });
  });
});
