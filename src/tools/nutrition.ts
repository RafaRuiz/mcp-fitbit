/**
 * Nutrition write tools (nutrition-log create and batchDelete).
 *
 * Reading food logs uses the generic tools: list_data_points / daily_rollup
 * with dataType nutrition-log, and get_data_point for foods.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type HealthApi, toToolResponse } from '../google/client.js';
import { MEAL_TYPES, NUTRIENTS } from '../google/data-types.js';
import {
  dataPointIdSchema,
  dataPointName,
  dataTypePath,
  sessionInterval,
  timestampSchema,
  utcOffsetSchema,
} from '../google/schemas.js';
import {
  createErrorResponse,
  DELETE_ANNOTATIONS,
  registerTool,
  WRITE_ANNOTATIONS,
} from '../utils.js';

const NUTRITION_LOG = 'nutrition-log';

const quantitySchema = z.number().min(0).max(100000);

export function registerNutritionTools(server: McpServer, api: HealthApi) {
  registerTool(server, {
    name: 'log_food',
    description: `Log food eaten (POST users/me/dataTypes/nutrition-log/dataPoints). Two modes:
1. Anonymous food (usual case): set foodDisplayName and the nutrition values yourself.
2. Identified food: set food to a Food resource name; the API fills in name and nutrients.
ALL nutrient quantities are in GRAMS: convert milligrams (sodium, potassium, cholesterol, calcium, iron...) and micrograms (vitamin D, B12, folate...) to grams. Anonymous food logs cannot be edited later: to correct one, delete it with delete_food_logs and log it again. Returns the raw Operation; the created data point is in response.name.`,
    inputSchema: {
      startTime: timestampSchema.describe(
        'When the food was eaten (RFC 3339), e.g. 2026-10-09T08:30:00+02:00'
      ),
      endTime: timestampSchema
        .optional()
        .describe(
          'End of the meal (RFC 3339), strictly after startTime. Defaults to startTime + 1 minute'
        ),
      utcOffset: utcOffsetSchema,
      mealType: z.enum(MEAL_TYPES).optional().describe('Meal category'),
      foodDisplayName: z
        .string()
        .min(1)
        .optional()
        .describe('Name of the food (anonymous food logs)'),
      food: z
        .string()
        .optional()
        .describe(
          'Food resource name, users/me/dataTypes/food/dataPoints/{id} (identified food logs)'
        ),
      foodMeasurementUnit: z
        .string()
        .optional()
        .describe(
          'Serving unit resource name (users/me/dataTypes/food-measurement-unit/dataPoints/{id}); required to send a serving'
        ),
      servingAmount: z
        .number()
        .min(0)
        .optional()
        .describe('Number of servings of foodMeasurementUnit'),
      energyKcal: quantitySchema
        .optional()
        .describe('Total energy in kilocalories'),
      energyFromFatKcal: quantitySchema
        .optional()
        .describe('Energy from fat in kilocalories'),
      totalCarbohydrateGrams: quantitySchema
        .optional()
        .describe('Total carbohydrate in grams'),
      totalFatGrams: quantitySchema.optional().describe('Total fat in grams'),
      nutrients: z
        .array(
          z.object({
            nutrient: z.enum(NUTRIENTS),
            grams: quantitySchema.describe('Quantity in grams'),
          })
        )
        .optional()
        .describe(
          'Individual nutrients in grams, e.g. [{"nutrient":"PROTEIN","grams":25},{"nutrient":"SODIUM","grams":0.4}]'
        ),
    },
    annotations: WRITE_ANNOTATIONS,
    handler: async (params, extra) => {
      if (Boolean(params.food) === Boolean(params.foodDisplayName)) {
        return createErrorResponse(
          'Provide exactly one of food (identified food) or foodDisplayName (anonymous food).'
        );
      }
      if (params.servingAmount !== undefined && !params.foodMeasurementUnit) {
        return createErrorResponse(
          'servingAmount requires foodMeasurementUnit.'
        );
      }

      const nutritionLog = {
        interval: sessionInterval(
          params.startTime,
          params.endTime,
          params.utcOffset
        ),
        mealType: params.mealType,
        food: params.food,
        foodDisplayName: params.foodDisplayName,
        serving: params.foodMeasurementUnit
          ? {
              foodMeasurementUnit: params.foodMeasurementUnit,
              amount: params.servingAmount,
            }
          : undefined,
        energy:
          params.energyKcal === undefined
            ? undefined
            : { kcal: params.energyKcal },
        energyFromFat:
          params.energyFromFatKcal === undefined
            ? undefined
            : { kcal: params.energyFromFatKcal },
        totalCarbohydrate:
          params.totalCarbohydrateGrams === undefined
            ? undefined
            : { grams: params.totalCarbohydrateGrams },
        totalFat:
          params.totalFatGrams === undefined
            ? undefined
            : { grams: params.totalFatGrams },
        nutrients: params.nutrients?.map(({ nutrient, grams }) => ({
          nutrient,
          quantity: { grams },
        })),
      };

      return toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: dataTypePath(NUTRITION_LOG),
          body: { nutritionLog },
        })
      );
    },
  });

  registerTool(server, {
    name: 'delete_food_logs',
    description:
      'Delete food log entries (POST users/me/dataTypes/nutrition-log/dataPoints:batchDelete). Entries created by other apps may not be deletable.',
    inputSchema: {
      dataPointIds: z
        .array(dataPointIdSchema)
        .min(1)
        .max(10000)
        .describe('Ids or full names of the nutrition-log data points'),
    },
    annotations: DELETE_ANNOTATIONS,
    handler: async ({ dataPointIds }, extra) =>
      toToolResponse(
        await api.call(extra, {
          method: 'POST',
          path: `${dataTypePath(NUTRITION_LOG)}:batchDelete`,
          body: {
            names: dataPointIds.map((id) => dataPointName(NUTRITION_LOG, id)),
          },
        })
      ),
  });
}
