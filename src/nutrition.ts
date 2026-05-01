import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  makeFitbitRequest,
  type FitbitRequestOptions,
  type ToolResponseStructure,
  createErrorResponse,
  createSuccessResponse,
} from './utils.js';

const FITBIT_API_BASE = 'https://api.fitbit.com/1';

// === Fitbit Response Interfaces (used for typing only) =====================

// Time series entry shared by /foods/log/{resource}/date/...
interface NutritionTimeSeriesEntry {
  dateTime: string;
  value: string;
}

interface NutritionTimeSeriesResponse {
  [key: string]: NutritionTimeSeriesEntry[];
}

interface FoodLogEntry {
  loggedFood: {
    accessLevel: string;
    amount: number;
    brand: string;
    calories: number;
    foodId: number;
    logDate: string;
    logId: number;
    name: string;
    unit: { id: number; name: string; plural: string };
    nutritionalValues?: {
      calories: number;
      carbs: number;
      fat: number;
      fiber: number;
      protein: number;
      sodium: number;
    };
  };
}

interface FoodLogResponse {
  foods: FoodLogEntry[];
  goals: { calories: number };
  summary: {
    calories: number;
    carbs: number;
    fat: number;
    fiber: number;
    protein: number;
    sodium: number;
    water: number;
  };
}

// === Validation primitives =================================================

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.');

const dateOrTodaySchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$|^today$/,
    "Date must be in YYYY-MM-DD format or 'today'."
  );

const mealTypeIdSchema = z
  .number()
  .int()
  .refine(v => [1, 2, 3, 4, 5, 7].includes(v), {
    message:
      'mealTypeId must be 1 (Breakfast), 2 (Morning Snack), 3 (Lunch), 4 (Afternoon Snack), 5 (Dinner), or 7 (Anytime).',
  });

const waterUnitSchema = z.enum(['ml', 'fl oz', 'cup']);

// All optional nutritional fields accepted by Create Food and the foodName
// branch of Create Food Log. Names match the Fitbit API exactly.
const nutritionFieldShape = {
  caloriesFromFat: z.number().optional().describe('Calories from fat.'),
  totalFat: z.number().optional().describe('Total fat in grams.'),
  transFat: z.number().optional().describe('Trans fat in grams.'),
  saturatedFat: z.number().optional().describe('Saturated fat in grams.'),
  cholesterol: z.number().optional().describe('Cholesterol in milligrams.'),
  sodium: z.number().optional().describe('Sodium in milligrams.'),
  potassium: z.number().optional().describe('Potassium in milligrams.'),
  totalCarbohydrate: z
    .number()
    .optional()
    .describe('Total carbohydrate in grams.'),
  dietaryFiber: z.number().optional().describe('Dietary fiber in grams.'),
  sugars: z.number().optional().describe('Sugars in grams.'),
  protein: z.number().optional().describe('Protein in grams.'),
  vitaminA: z.number().optional().describe('Vitamin A in IU.'),
  vitaminB6: z.number().optional().describe('Vitamin B6 in milligrams.'),
  vitaminB12: z.number().optional().describe('Vitamin B12 in micrograms.'),
  vitaminC: z.number().optional().describe('Vitamin C in milligrams.'),
  vitaminD: z.number().optional().describe('Vitamin D in IU.'),
  vitaminE: z.number().optional().describe('Vitamin E in IU.'),
  biotin: z.number().optional().describe('Biotin in milligrams.'),
  folicAcid: z.number().optional().describe('Folic acid in milligrams.'),
  niacin: z.number().optional().describe('Niacin in milligrams.'),
  pantothenicAcid: z
    .number()
    .optional()
    .describe('Pantothenic acid in milligrams.'),
  riboflavin: z.number().optional().describe('Riboflavin in milligrams.'),
  thiamin: z.number().optional().describe('Thiamin in milligrams.'),
  calcium: z.number().optional().describe('Calcium in grams.'),
  copper: z.number().optional().describe('Copper in grams.'),
  iron: z.number().optional().describe('Iron in milligrams.'),
  magnesium: z.number().optional().describe('Magnesium in milligrams.'),
  phosphorus: z.number().optional().describe('Phosphorus in grams.'),
  iodine: z.number().optional().describe('Iodine in micrograms.'),
  zinc: z.number().optional().describe('Zinc in milligrams.'),
} as const;

type NutritionFields = {
  [K in keyof typeof nutritionFieldShape]?: number;
};

const NUTRITION_FIELD_KEYS = Object.keys(
  nutritionFieldShape
) as (keyof typeof nutritionFieldShape)[];

// === Internal helpers ======================================================

type QueryValue = string | number | boolean | undefined | null;

/**
 * URL-encodes a flat record into a `?key=val&...` string. Skips undefined and
 * null values so callers can spread optional params without filtering.
 */
function buildQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/**
 * Calls a Fitbit write endpoint and returns a tool response containing the
 * parsed JSON on success or a descriptive error on failure.
 */
async function runFitbitMutation<T>(
  endpoint: string,
  getAccessTokenFn: () => Promise<string | null>,
  options: FitbitRequestOptions,
  errorContext: string
): Promise<ToolResponseStructure> {
  const result = await makeFitbitRequest<T>(
    endpoint,
    getAccessTokenFn,
    FITBIT_API_BASE,
    options
  );
  if (!result) {
    const verb = options.method?.toLowerCase() ?? 'request';
    return createErrorResponse(
      `Failed to ${verb} ${errorContext}. Check token, scopes (nutrition), and parameters.`
    );
  }
  return createSuccessResponse(result);
}

/**
 * Calls a Fitbit read endpoint and returns a tool response containing the
 * parsed JSON on success or an error on failure.
 */
async function runFitbitRead<T>(
  endpoint: string,
  getAccessTokenFn: () => Promise<string | null>,
  errorContext: string,
  options: FitbitRequestOptions = {}
): Promise<ToolResponseStructure> {
  const result = await makeFitbitRequest<T>(
    endpoint,
    getAccessTokenFn,
    FITBIT_API_BASE,
    options
  );
  if (!result) {
    return createErrorResponse(
      `Failed to retrieve ${errorContext} from Fitbit API. Check token and permissions.`
    );
  }
  return createSuccessResponse(result);
}

// === Tool Registration =====================================================

/**
 * Registers all Fitbit nutrition tools (read + write) with the MCP server.
 */
export function registerNutritionTools(
  server: McpServer,
  getAccessTokenFn: () => Promise<string | null>
): void {
  // -------------------------------------------------------------------------
  // Existing read tools (kept for backwards compatibility)
  // -------------------------------------------------------------------------

  server.tool(
    'get_food_log',
    'Get comprehensive nutrition data (calories, protein, carbs, fat, fiber, sodium) from Fitbit food log for a specific date. Returns daily summary totals and individual food entries with nutritional values.',
    {
      date: dateOrTodaySchema
        .optional()
        .describe(
          "The date for which to retrieve food log data (YYYY-MM-DD or 'today'). Defaults to 'today'."
        ),
    },
    async ({ date = 'today' }: { date?: string }) => {
      const endpoint = `foods/log/date/${date}.json`;
      const data = await makeFitbitRequest<FoodLogResponse>(
        endpoint,
        getAccessTokenFn,
        FITBIT_API_BASE
      );
      if (!data) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve food log data from Fitbit API for date '${date}'. Check token and permissions.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    'get_nutrition',
    "Get the raw JSON response for nutrition data from Fitbit for a specified resource and period ending today or on a specific date. Requires 'resource' parameter (caloriesIn, water) and 'period' parameter such as '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y' and optionally accepts 'date' parameter.",
    {
      resource: z
        .enum([
          'caloriesIn',
          'water',
          'protein',
          'carbs',
          'fat',
          'fiber',
          'sodium',
        ])
        .describe('The nutrition resource to retrieve data for.'),
      period: z
        .enum(['1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y'])
        .describe('The time period for which to retrieve nutrition data.'),
      date: dateOrTodaySchema
        .optional()
        .describe(
          "The date for which to retrieve nutrition data (YYYY-MM-DD or 'today'). Defaults to 'today'."
        ),
    },
    async ({
      resource,
      period,
      date = 'today',
    }: {
      resource: string;
      period: string;
      date?: string;
    }) => {
      const endpoint = `foods/log/${resource}/date/${date}/${period}.json`;
      const data = await makeFitbitRequest<NutritionTimeSeriesResponse>(
        endpoint,
        getAccessTokenFn,
        FITBIT_API_BASE
      );
      if (!data) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve nutrition data from Fitbit API for resource '${resource}', date '${date}' and period '${period}'. Check token and permissions.`,
            },
          ],
          isError: true,
        };
      }
      const entries = data[`foods-log-${resource}`] ?? [];
      if (entries.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No nutrition data found for resource '${resource}', date '${date}' and period '${period}'.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    'get_nutrition_by_date_range',
    "Get the raw JSON response for nutrition data from Fitbit for a specific resource and date range. Requires 'resource' parameter (caloriesIn, water), 'startDate' and 'endDate' parameters in 'YYYY-MM-DD' format. Note: The API enforces a maximum range of 1,095 days.",
    {
      resource: z
        .enum([
          'caloriesIn',
          'water',
          'protein',
          'carbs',
          'fat',
          'fiber',
          'sodium',
        ])
        .describe('The nutrition resource to retrieve data for.'),
      startDate: dateSchema.describe(
        'The start date for which to retrieve nutrition data (YYYY-MM-DD).'
      ),
      endDate: dateSchema.describe(
        'The end date for which to retrieve nutrition data (YYYY-MM-DD).'
      ),
    },
    async ({
      resource,
      startDate,
      endDate,
    }: {
      resource: string;
      startDate: string;
      endDate: string;
    }) => {
      const endpoint = `foods/log/${resource}/date/${startDate}/${endDate}.json`;
      const data = await makeFitbitRequest<NutritionTimeSeriesResponse>(
        endpoint,
        getAccessTokenFn,
        FITBIT_API_BASE
      );
      if (!data) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve nutrition data from Fitbit API for resource '${resource}' and the date range '${startDate}' to '${endDate}'. Check token, permissions, date format, and ensure the range is 1,095 days or less.`,
            },
          ],
          isError: true,
        };
      }
      const entries = data[`foods-log-${resource}`] ?? [];
      if (entries.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No nutrition data found for resource '${resource}' and the date range '${startDate}' to '${endDate}'.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Food database lookup
  // -------------------------------------------------------------------------

  server.tool(
    'search_foods',
    "Search the Fitbit public food database (and your private foods) by free-text query. Returns matching foods with their foodId, default unit, available units, and basic nutrition. Use the returned foodId and unitId with log_food.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text search term, e.g. 'banana', 'big mac', 'greek yogurt'."
        ),
    },
    async ({ query }: { query: string }) => {
      const endpoint = `foods/search.json${buildQueryString({ query })}`;
      return runFitbitRead(
        endpoint,
        getAccessTokenFn,
        `food search results for '${query}'`,
        { skipUserPrefix: true }
      );
    }
  );

  server.tool(
    'get_food',
    'Get full details for a specific food (public or your private foods) by its Fitbit foodId, including default unit, available units, and per-serving nutrition.',
    {
      foodId: z
        .number()
        .int()
        .describe('The Fitbit foodId, typically obtained from search_foods.'),
    },
    async ({ foodId }: { foodId: number }) => {
      const endpoint = `foods/${foodId}.json`;
      return runFitbitRead(
        endpoint,
        getAccessTokenFn,
        `food with id '${foodId}'`,
        { skipUserPrefix: true }
      );
    }
  );

  server.tool(
    'get_food_units',
    "Get the full list of valid Fitbit food units (id, name, plural). Use the returned ids as 'unitId' when calling log_food, create_food, or create_meal.",
    {},
    async () =>
      runFitbitRead('foods/units.json', getAccessTokenFn, 'food units', {
        skipUserPrefix: true,
      })
  );

  server.tool(
    'get_food_locales',
    'Get the list of locales (e.g. en_US) supported by the Fitbit foods database. Useful when creating private foods for non-default locales.',
    {},
    async () =>
      runFitbitRead('foods/locales.json', getAccessTokenFn, 'food locales', {
        skipUserPrefix: true,
      })
  );

  // -------------------------------------------------------------------------
  // Food log: create / update / delete
  // -------------------------------------------------------------------------

  server.tool(
    'log_food',
    "Log a food entry to the user's Fitbit food diary. Provide EITHER 'foodId' (from search_foods) for a known food OR 'foodName' plus nutritional values for a one-off custom entry. mealTypeId values: 1=Breakfast, 2=Morning Snack, 3=Lunch, 4=Afternoon Snack, 5=Dinner, 7=Anytime. Detailed macros/micros (totalFat, saturatedFat, transFat, cholesterol, sodium, potassium, totalCarbohydrate, dietaryFiber, sugars, protein, vitamins A/B6/B12/C/D/E, biotin, folicAcid, niacin, pantothenicAcid, riboflavin, thiamin, calcium, copper, iron, magnesium, phosphorus, iodine, zinc) are honoured only when 'foodName' is used.",
    {
      date: dateSchema.describe(
        'Date the food was consumed (YYYY-MM-DD). Required.'
      ),
      mealTypeId: mealTypeIdSchema.describe(
        'Meal slot: 1=Breakfast, 2=Morning Snack, 3=Lunch, 4=Afternoon Snack, 5=Dinner, 7=Anytime.'
      ),
      unitId: z
        .number()
        .int()
        .describe(
          'Unit id from search_foods (food.defaultUnit.id) or get_food_units.'
        ),
      amount: z
        .number()
        .positive()
        .describe('Quantity in the chosen unit (decimal, e.g. 1.5).'),
      foodId: z
        .number()
        .int()
        .optional()
        .describe(
          "Fitbit food id from search_foods. Provide this OR 'foodName'."
        ),
      favorite: z
        .boolean()
        .optional()
        .describe(
          "When using 'foodId', set true to also add the food to favorites."
        ),
      foodName: z
        .string()
        .optional()
        .describe(
          "Name for a one-off custom food entry. Provide this OR 'foodId'."
        ),
      brandName: z
        .string()
        .optional()
        .describe("Brand name. Only honoured with 'foodName'."),
      calories: z
        .number()
        .optional()
        .describe(
          "Calorie count for a custom entry. Only honoured with 'foodName'; defaults to 0."
        ),
      ...nutritionFieldShape,
    },
    async (params: {
      date: string;
      mealTypeId: number;
      unitId: number;
      amount: number;
      foodId?: number;
      favorite?: boolean;
      foodName?: string;
      brandName?: string;
      calories?: number;
    } & NutritionFields) => {
      if (params.foodId === undefined && !params.foodName) {
        return createErrorResponse(
          "log_food requires either 'foodId' or 'foodName'."
        );
      }
      if (params.foodId !== undefined && params.foodName) {
        return createErrorResponse(
          "log_food accepts either 'foodId' or 'foodName', not both."
        );
      }

      const query: Record<string, QueryValue> = {
        date: params.date,
        mealTypeId: params.mealTypeId,
        unitId: params.unitId,
        amount: params.amount,
      };

      if (params.foodId !== undefined) {
        query.foodId = params.foodId;
        if (params.favorite !== undefined) query.favorite = params.favorite;
      } else {
        query.foodName = params.foodName;
        if (params.brandName !== undefined) query.brandName = params.brandName;
        if (params.calories !== undefined) query.calories = params.calories;
        for (const key of NUTRITION_FIELD_KEYS) {
          const value = params[key];
          if (value !== undefined) query[key] = value;
        }
      }

      const endpoint = `foods/log.json${buildQueryString(query)}`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'POST' },
        `food log entry for '${params.foodName ?? `foodId ${params.foodId}`}' on ${params.date}`
      );
    }
  );

  server.tool(
    'update_food_log',
    "Update the quantity, unit, or calories of an existing food log entry. Use the foodLogId returned by log_food / get_food_log. Note: the Fitbit API only supports updating quantity-related fields; to change the food itself, delete and re-log.",
    {
      foodLogId: z
        .number()
        .int()
        .describe('The logId of the food log entry to update.'),
      mealTypeId: mealTypeIdSchema
        .optional()
        .describe('New meal slot (1=Breakfast..7=Anytime).'),
      unitId: z.number().int().optional().describe('New unit id.'),
      amount: z.number().positive().optional().describe('New amount.'),
      calories: z
        .number()
        .optional()
        .describe('New calories (custom-food entries only).'),
    },
    async (params: {
      foodLogId: number;
      mealTypeId?: number;
      unitId?: number;
      amount?: number;
      calories?: number;
    }) => {
      const { foodLogId, ...rest } = params;
      const endpoint = `foods/log/${foodLogId}.json${buildQueryString(rest)}`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'POST' },
        `food log entry ${foodLogId}`
      );
    }
  );

  server.tool(
    'delete_food_log',
    "Delete a single food log entry by its foodLogId. Use this to undo a logged food. Returns 204 No Content on success.",
    {
      foodLogId: z
        .number()
        .int()
        .describe('The logId of the food log entry to delete.'),
    },
    async ({ foodLogId }: { foodLogId: number }) => {
      const endpoint = `foods/log/${foodLogId}.json`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'DELETE' },
        `food log entry ${foodLogId}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Custom (private) foods
  // -------------------------------------------------------------------------

  server.tool(
    'create_food',
    "Create a private (custom) food in the user's Fitbit foods database. Reusable in subsequent log_food calls via its returned foodId. Supports the full set of macro/micro nutrition fields.",
    {
      name: z.string().describe('Name of the food.'),
      defaultFoodMeasurementUnitId: z
        .number()
        .int()
        .describe(
          'Default unit id (from get_food_units) used when logging this food.'
        ),
      defaultServingSize: z
        .number()
        .positive()
        .describe('Default serving size in the chosen unit.'),
      calories: z
        .number()
        .describe('Calories per default serving size.'),
      formType: z
        .enum(['LIQUID', 'DRY'])
        .optional()
        .describe("'LIQUID' or 'DRY'."),
      description: z.string().optional().describe('Free-text description.'),
      ...nutritionFieldShape,
    },
    async (params: {
      name: string;
      defaultFoodMeasurementUnitId: number;
      defaultServingSize: number;
      calories: number;
      formType?: 'LIQUID' | 'DRY';
      description?: string;
    } & NutritionFields) => {
      const query: Record<string, QueryValue> = {
        name: params.name,
        defaultFoodMeasurementUnitId: params.defaultFoodMeasurementUnitId,
        defaultServingSize: params.defaultServingSize,
        calories: params.calories,
        formType: params.formType,
        description: params.description,
      };
      for (const key of NUTRITION_FIELD_KEYS) {
        const value = params[key];
        if (value !== undefined) query[key] = value;
      }
      const endpoint = `foods.json${buildQueryString(query)}`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'POST', skipUserPrefix: true },
        `custom food '${params.name}'`
      );
    }
  );

  server.tool(
    'delete_custom_food',
    'Delete a private (custom) food previously created with create_food. Cannot delete public Fitbit-database foods.',
    {
      foodId: z.number().int().describe('foodId of the custom food to delete.'),
    },
    async ({ foodId }: { foodId: number }) => {
      const endpoint = `foods/${foodId}.json`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'DELETE', skipUserPrefix: true },
        `custom food ${foodId}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Water logging
  // -------------------------------------------------------------------------

  server.tool(
    'get_water_log',
    "Get all water log entries and the daily total for a specific date.",
    {
      date: dateSchema.describe('Date (YYYY-MM-DD).'),
    },
    async ({ date }: { date: string }) => {
      const endpoint = `foods/log/water/date/${date}.json`;
      return runFitbitRead(
        endpoint,
        getAccessTokenFn,
        `water log for ${date}`
      );
    }
  );

  server.tool(
    'log_water',
    "Log a water entry. amount is interpreted in 'unit' (defaults to the user's locale unit). Returns the new waterLog.logId on success.",
    {
      date: dateSchema.describe('Date the water was consumed (YYYY-MM-DD).'),
      amount: z.number().positive().describe('Amount of water (decimal).'),
      unit: waterUnitSchema
        .optional()
        .describe(
          "Unit: 'ml', 'fl oz', or 'cup'. Defaults to the user's locale unit."
        ),
    },
    async (params: { date: string; amount: number; unit?: string }) => {
      const endpoint = `foods/log/water.json${buildQueryString(params)}`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'POST' },
        `water entry for ${params.date}`
      );
    }
  );

  server.tool(
    'update_water_log',
    'Update the amount on an existing water log entry.',
    {
      waterLogId: z
        .number()
        .int()
        .describe('The logId of the water log entry to update.'),
      amount: z.number().positive().describe('New water amount.'),
      unit: waterUnitSchema
        .optional()
        .describe("Unit: 'ml', 'fl oz', or 'cup'."),
    },
    async (params: {
      waterLogId: number;
      amount: number;
      unit?: string;
    }) => {
      const { waterLogId, ...rest } = params;
      const endpoint = `foods/log/water/${waterLogId}.json${buildQueryString(rest)}`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'POST' },
        `water log entry ${waterLogId}`
      );
    }
  );

  server.tool(
    'delete_water_log',
    'Delete a water log entry by its logId.',
    {
      waterLogId: z
        .number()
        .int()
        .describe('The logId of the water log entry to delete.'),
    },
    async ({ waterLogId }: { waterLogId: number }) => {
      const endpoint = `foods/log/water/${waterLogId}.json`;
      return runFitbitMutation(
        endpoint,
        getAccessTokenFn,
        { method: 'DELETE' },
        `water log entry ${waterLogId}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Saved meals (collections of foods that can be logged in one shot)
  // -------------------------------------------------------------------------

  server.tool(
    'get_meals',
    "List all meals the user has saved. Each meal contains an array of foods (foodId, amount, unitId).",
    {},
    async () => runFitbitRead('meals.json', getAccessTokenFn, 'saved meals')
  );

  server.tool(
    'get_meal',
    'Get a single saved meal by its mealId.',
    {
      mealId: z.number().int().describe('The mealId to retrieve.'),
    },
    async ({ mealId }: { mealId: number }) => {
      return runFitbitRead(
        `meals/${mealId}.json`,
        getAccessTokenFn,
        `meal ${mealId}`
      );
    }
  );

  const mealFoodSchema = z.object({
    foodId: z.number().int().describe('foodId of a food in this meal.'),
    amount: z.number().positive().describe('Quantity in the chosen unit.'),
    unitId: z.number().int().describe('Unit id for the amount.'),
  });

  server.tool(
    'create_meal',
    'Create a new saved meal containing one or more foods. The meal can later be logged or referenced by mealId.',
    {
      name: z.string().describe('Name of the meal.'),
      description: z.string().describe('Short description of the meal.'),
      mealFoods: z
        .array(mealFoodSchema)
        .min(1)
        .describe(
          'Array of foods. Each entry: { foodId, amount, unitId }. Use search_foods to find foodIds and unitIds.'
        ),
    },
    async (params: {
      name: string;
      description: string;
      mealFoods: { foodId: number; amount: number; unitId: number }[];
    }) => {
      return runFitbitMutation(
        'meals.json',
        getAccessTokenFn,
        {
          method: 'POST',
          body: JSON.stringify(params),
          contentType: 'application/json',
        },
        `meal '${params.name}'`
      );
    }
  );

  server.tool(
    'update_meal',
    'Replace the contents of an existing saved meal.',
    {
      mealId: z.number().int().describe('The mealId to update.'),
      name: z.string().describe('New name.'),
      description: z.string().describe('New description.'),
      mealFoods: z
        .array(mealFoodSchema)
        .min(1)
        .describe('New array of meal foods (full replacement).'),
    },
    async (params: {
      mealId: number;
      name: string;
      description: string;
      mealFoods: { foodId: number; amount: number; unitId: number }[];
    }) => {
      const { mealId, ...body } = params;
      return runFitbitMutation(
        `meals/${mealId}.json`,
        getAccessTokenFn,
        {
          method: 'POST',
          body: JSON.stringify(body),
          contentType: 'application/json',
        },
        `meal ${mealId}`
      );
    }
  );

  server.tool(
    'delete_meal',
    'Delete a saved meal by its mealId.',
    {
      mealId: z.number().int().describe('The mealId to delete.'),
    },
    async ({ mealId }: { mealId: number }) => {
      return runFitbitMutation(
        `meals/${mealId}.json`,
        getAccessTokenFn,
        { method: 'DELETE' },
        `meal ${mealId}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Favorite / recent / frequent foods
  // -------------------------------------------------------------------------

  server.tool(
    'get_favorite_foods',
    "List the user's favorite foods.",
    {},
    async () =>
      runFitbitRead(
        'foods/log/favorite.json',
        getAccessTokenFn,
        'favorite foods'
      )
  );

  server.tool(
    'get_recent_foods',
    "List the user's recently consumed foods.",
    {},
    async () =>
      runFitbitRead(
        'foods/log/recent.json',
        getAccessTokenFn,
        'recent foods'
      )
  );

  server.tool(
    'get_frequent_foods',
    "List the user's frequently consumed foods.",
    {},
    async () =>
      runFitbitRead(
        'foods/log/frequent.json',
        getAccessTokenFn,
        'frequent foods'
      )
  );

  server.tool(
    'add_favorite_food',
    "Add a food to the user's favorites by foodId.",
    {
      foodId: z.number().int().describe('foodId to favorite.'),
    },
    async ({ foodId }: { foodId: number }) => {
      return runFitbitMutation(
        `foods/log/favorite/${foodId}.json`,
        getAccessTokenFn,
        { method: 'POST' },
        `favorite for foodId ${foodId}`
      );
    }
  );

  server.tool(
    'delete_favorite_food',
    "Remove a food from the user's favorites by foodId.",
    {
      foodId: z.number().int().describe('foodId to remove from favorites.'),
    },
    async ({ foodId }: { foodId: number }) => {
      return runFitbitMutation(
        `foods/log/favorite/${foodId}.json`,
        getAccessTokenFn,
        { method: 'DELETE' },
        `favorite for foodId ${foodId}`
      );
    }
  );
}
