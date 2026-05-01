import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerNutritionTools } from './nutrition.js';
import * as utils from './utils.js';
import type { ToolResponseStructure } from './utils.js';

// Mock the utils module. We provide simple stand-ins for the response helpers
// so the new write/read tools (which use createErrorResponse/createSuccessResponse)
// produce predictable output without pulling in the full real implementation.
vi.mock('./utils.js', () => ({
  makeFitbitRequest: vi.fn(),
  createErrorResponse: (message: string) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  }),
  createSuccessResponse: (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }),
  createNoDataResponse: (context: string) => ({
    content: [{ type: 'text', text: `No data found for ${context}.` }],
  }),
}));

describe('Nutrition Tools', () => {
  let mockServer: McpServer;
  let mockGetAccessToken: ReturnType<typeof vi.fn>;
  let mockMakeFitbitRequest: ReturnType<typeof vi.fn>;
  let mockServerToolSpy: any; // Simplified spy type

  beforeEach(() => {
    mockServer = {
      tool: vi.fn(), // Mock the .tool method directly
    } as unknown as McpServer;
    mockGetAccessToken = vi.fn();
    mockMakeFitbitRequest = vi.mocked(utils.makeFitbitRequest);
    mockServerToolSpy = vi.spyOn(mockServer, 'tool'); // Spy on the mocked .tool method
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerNutritionTools', () => {
    const expectedTools = [
      // Read tools (existing)
      'get_food_log',
      'get_nutrition',
      'get_nutrition_by_date_range',
      // Food database lookup
      'search_foods',
      'get_food',
      'get_food_units',
      'get_food_locales',
      // Food log write
      'log_food',
      'update_food_log',
      'delete_food_log',
      // Custom foods
      'create_food',
      'delete_custom_food',
      // Water
      'get_water_log',
      'log_water',
      'update_water_log',
      'delete_water_log',
      // Meals
      'get_meals',
      'get_meal',
      'create_meal',
      'update_meal',
      'delete_meal',
      // Favorites / recent / frequent
      'get_favorite_foods',
      'get_recent_foods',
      'get_frequent_foods',
      'add_favorite_food',
      'delete_favorite_food',
    ];

    it('should register all nutrition tools via server.tool', () => {
      registerNutritionTools(mockServer, mockGetAccessToken);
      expect(mockServerToolSpy).toHaveBeenCalledTimes(expectedTools.length);
      for (const name of expectedTools) {
        expect(mockServerToolSpy).toHaveBeenCalledWith(
          name,
          expect.any(String),
          expect.any(Object),
          expect.any(Function)
        );
      }
    });
  });

  // Helper to get the arguments for a specific tool registration
  const getToolRegistrationArgs = (toolName: string) => {
    const call = mockServerToolSpy.mock.calls.find((c: any[]) => c[0] === toolName);
    if (!call) throw new Error(`Tool ${toolName} not registered or spy not capturing call.`);
    return {
      name: call[0] as string,
      description: call[1] as string,
      parametersSchema: call[2] as Record<string, z.ZodTypeAny>,
      handler: call[3] as (params: any) => Promise<ToolResponseStructure>,
    };
  };

  describe('get_food_log tool', () => {
    const toolName = 'get_food_log';
    const defaultDate = 'today';

    beforeEach(() => {
      // Ensure tools are registered before each test in this block
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('should register with correct configuration', () => {
      const config = getToolRegistrationArgs(toolName);
      expect(config.name).toBe(toolName);
      expect(config.description).toBe('Get comprehensive nutrition data (calories, protein, carbs, fat, fiber, sodium) from Fitbit food log for a specific date. Returns daily summary totals and individual food entries with nutritional values.');
      // Check schema structure
      expect(config.parametersSchema.date).toBeInstanceOf(z.ZodOptional);
      expect((config.parametersSchema.date as z.ZodOptional<z.ZodString>)._def.innerType).toBeInstanceOf(z.ZodString);
    });

    it('should call makeFitbitRequest with correct endpoint for default date', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const mockFoodLogData = { foods: [], summary: {}, goals: {} };
      mockMakeFitbitRequest.mockResolvedValue(mockFoodLogData);

      const result = await handler({}); // Call handler with empty params for default date

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/date/${defaultDate}.json`,
        mockGetAccessToken,
        'https://api.fitbit.com/1'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFoodLogData, null, 2) }]
      });
    });

    it('should call makeFitbitRequest with correct endpoint for specified date', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const specificDate = '2023-01-15';
      const mockFoodLogData = { foods: [], summary: {}, goals: {} };
      mockMakeFitbitRequest.mockResolvedValue(mockFoodLogData);

      const result = await handler({ date: specificDate });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/date/${specificDate}.json`,
        mockGetAccessToken,
        'https://api.fitbit.com/1'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFoodLogData, null, 2) }]
      });
    });

    it('should handle API errors gracefully', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      mockMakeFitbitRequest.mockResolvedValue(null); // Simulate API failure

      const result = await handler({ date: '2023-01-15' });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve food log data');
    });
    
    it('should handle null access token by letting makeFitbitRequest handle it', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      mockGetAccessToken.mockResolvedValue(null);
      mockMakeFitbitRequest.mockResolvedValue(null);

      const result = await handler({ date: '2023-01-15' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve food log data');
      
      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/date/2023-01-15.json`,
        mockGetAccessToken, 
        'https://api.fitbit.com/1'
      );
    });
  });

  describe('get_nutrition tool', () => {
    const toolName = 'get_nutrition';
    const defaultDate = 'today';

    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });
    
    it('should register with correct configuration', () => {
      const config = getToolRegistrationArgs(toolName);
      expect(config.name).toBe(toolName);
      expect(config.description).toContain('Get the raw JSON response for nutrition data from Fitbit for a specified resource and period');
      expect(config.parametersSchema.resource).toBeInstanceOf(z.ZodEnum);
      expect(config.parametersSchema.period).toBeInstanceOf(z.ZodEnum);
      expect(config.parametersSchema.date).toBeInstanceOf(z.ZodOptional);
    });

    it('should call makeFitbitRequest with correct endpoint for specified resource, period, and default date', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const resource = 'caloriesIn';
      const period = '7d';
      const mockResponseData = { [`foods-log-${resource}`]: [{ dateTime: '2023-01-15', value: '2000' }] };
      mockMakeFitbitRequest.mockResolvedValue(mockResponseData);

      const params = { resource, period };
      const result = await handler(params);

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/${resource}/date/${defaultDate}/${period}.json`,
        mockGetAccessToken,
        'https://api.fitbit.com/1'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockResponseData, null, 2) }]
      });
    });

    it('should call makeFitbitRequest with correct endpoint for specified resource, period, and date', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const resource = 'water';
      const period = '1m';
      const specificDate = '2023-01-10';
      const mockResponseData = { [`foods-log-${resource}`]: [{ dateTime: '2023-01-10', value: '2000' }] };
      mockMakeFitbitRequest.mockResolvedValue(mockResponseData);
      
      const params = { resource, period, date: specificDate };
      const result = await handler(params);

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/${resource}/date/${specificDate}/${period}.json`,
        mockGetAccessToken,
        'https://api.fitbit.com/1'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockResponseData, null, 2) }]
      });
    });
    
    it('should handle API errors gracefully', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      mockMakeFitbitRequest.mockResolvedValue(null); 
      const params = { resource: 'caloriesIn', period: '7d', date: '2023-01-15' };
      const result = await handler(params);
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve nutrition data');
    });

    it('should handle no data found for the period', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const resource = 'protein';
      const period = '1d';
      const date = '2023-01-01';
      const mockResponseData = { [`foods-log-${resource}`]: [] }; 
      mockMakeFitbitRequest.mockResolvedValue(mockResponseData);

      const params = { resource, period, date };
      const result = await handler(params);

      expect(result.isError).toBeUndefined(); 
      expect(result.content[0].text).toContain(`No nutrition data found for resource '${resource}'`);
    });
  });

  describe('get_nutrition_by_date_range tool', () => {
    const toolName = 'get_nutrition_by_date_range';

    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('should register with correct configuration', () => {
      const config = getToolRegistrationArgs(toolName);
      expect(config.name).toBe(toolName);
      expect(config.description).toContain('Get the raw JSON response for nutrition data from Fitbit for a specific resource and date range.');
      expect(config.parametersSchema.resource).toBeInstanceOf(z.ZodEnum);
      expect(config.parametersSchema.startDate).toBeInstanceOf(z.ZodString);
      expect(config.parametersSchema.endDate).toBeInstanceOf(z.ZodString);
    });

    it('should call makeFitbitRequest with correct endpoint for specified resource and date range', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const resource = 'fat';
      const startDate = '2023-01-01';
      const endDate = '2023-01-07';
      const mockResponseData = { [`foods-log-${resource}`]: [{ dateTime: '2023-01-01', value: '50' }] };
      mockMakeFitbitRequest.mockResolvedValue(mockResponseData);

      const params = { resource, startDate, endDate };
      const result = await handler(params);

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        `foods/log/${resource}/date/${startDate}/${endDate}.json`,
        mockGetAccessToken,
        'https://api.fitbit.com/1'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockResponseData, null, 2) }]
      });
    });

    it('should handle API errors gracefully', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      mockMakeFitbitRequest.mockResolvedValue(null); 
      const params = { resource: 'carbs', startDate: '2023-01-01', endDate: '2023-01-07' };
      const result = await handler(params);
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve nutrition data');
    });
    
    it('should handle no data found for the date range', async () => {
      const { handler } = getToolRegistrationArgs(toolName);
      const resource = 'fiber';
      const startDate = '2023-02-01';
      const endDate = '2023-02-05';
      const mockResponseData = { [`foods-log-${resource}`]: [] };
      mockMakeFitbitRequest.mockResolvedValue(mockResponseData);

      const params = { resource, startDate, endDate };
      const result = await handler(params);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(`No nutrition data found for resource '${resource}'`);
    });
  });

  // ==========================================================================
  // Tests for new nutrition write tools
  // ==========================================================================

  describe('search_foods tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('passes query to /foods/search.json with skipUserPrefix', async () => {
      const { handler } = getToolRegistrationArgs('search_foods');
      mockMakeFitbitRequest.mockResolvedValue({ foods: [] });

      await handler({ query: 'banana smoothie' });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/search.json?query=banana+smoothie',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { skipUserPrefix: true }
      );
    });

    it('returns an error if the API call fails', async () => {
      const { handler } = getToolRegistrationArgs('search_foods');
      mockMakeFitbitRequest.mockResolvedValue(null);

      const result = await handler({ query: 'banana' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_food_units tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('calls /foods/units.json with skipUserPrefix and no params', async () => {
      const { handler } = getToolRegistrationArgs('get_food_units');
      mockMakeFitbitRequest.mockResolvedValue([{ id: 304, name: 'serving' }]);

      await handler({});

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/units.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { skipUserPrefix: true }
      );
    });
  });

  describe('log_food tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('logs by foodId with required params and favorite flag', async () => {
      const { handler } = getToolRegistrationArgs('log_food');
      mockMakeFitbitRequest.mockResolvedValue({ foodLog: { logId: 1 } });

      await handler({
        date: '2026-04-30',
        mealTypeId: 3,
        unitId: 304,
        amount: 1.5,
        foodId: 82294,
        favorite: true,
      });

      const [endpoint, , , options] = mockMakeFitbitRequest.mock.calls[0] as [
        string,
        unknown,
        unknown,
        { method?: string },
      ];
      expect(options).toEqual({ method: 'POST' });
      expect(endpoint.startsWith('foods/log.json?')).toBe(true);
      expect(endpoint).toContain('date=2026-04-30');
      expect(endpoint).toContain('mealTypeId=3');
      expect(endpoint).toContain('unitId=304');
      expect(endpoint).toContain('amount=1.5');
      expect(endpoint).toContain('foodId=82294');
      expect(endpoint).toContain('favorite=true');
      expect(endpoint).not.toContain('foodName');
    });

    it('logs a custom food by foodName with full macros', async () => {
      const { handler } = getToolRegistrationArgs('log_food');
      mockMakeFitbitRequest.mockResolvedValue({ foodLog: { logId: 2 } });

      await handler({
        date: '2026-04-30',
        mealTypeId: 1,
        unitId: 226,
        amount: 1,
        foodName: 'Homemade Granola Bowl',
        brandName: 'Home',
        calories: 420,
        totalFat: 18.2,
        saturatedFat: 4.1,
        transFat: 0,
        cholesterol: 12,
        sodium: 220,
        totalCarbohydrate: 52,
        dietaryFiber: 7,
        sugars: 12,
        protein: 14,
        calcium: 0.15,
        iron: 3.5,
      });

      const [endpoint] = mockMakeFitbitRequest.mock.calls[0] as [string];
      expect(endpoint).toContain('foodName=Homemade+Granola+Bowl');
      expect(endpoint).toContain('brandName=Home');
      expect(endpoint).toContain('calories=420');
      expect(endpoint).toContain('totalFat=18.2');
      expect(endpoint).toContain('saturatedFat=4.1');
      expect(endpoint).toContain('protein=14');
      expect(endpoint).toContain('iron=3.5');
      expect(endpoint).not.toContain('foodId');
      expect(endpoint).not.toContain('favorite');
    });

    it('rejects requests with neither foodId nor foodName', async () => {
      const { handler } = getToolRegistrationArgs('log_food');
      const result = await handler({
        date: '2026-04-30',
        mealTypeId: 3,
        unitId: 304,
        amount: 1,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'foodId' or 'foodName'");
      expect(mockMakeFitbitRequest).not.toHaveBeenCalled();
    });

    it('rejects requests that supply both foodId and foodName', async () => {
      const { handler } = getToolRegistrationArgs('log_food');
      const result = await handler({
        date: '2026-04-30',
        mealTypeId: 3,
        unitId: 304,
        amount: 1,
        foodId: 1,
        foodName: 'X',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not both');
      expect(mockMakeFitbitRequest).not.toHaveBeenCalled();
    });

    it('returns an error response when the API call fails', async () => {
      const { handler } = getToolRegistrationArgs('log_food');
      mockMakeFitbitRequest.mockResolvedValue(null);

      const result = await handler({
        date: '2026-04-30',
        mealTypeId: 3,
        unitId: 304,
        amount: 1,
        foodId: 82294,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to post');
    });
  });

  describe('delete_food_log tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('issues DELETE on the right endpoint', async () => {
      const { handler } = getToolRegistrationArgs('delete_food_log');
      mockMakeFitbitRequest.mockResolvedValue({});

      await handler({ foodLogId: 555 });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/log/555.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { method: 'DELETE' }
      );
    });
  });

  describe('update_food_log tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('POSTs only the supplied fields', async () => {
      const { handler } = getToolRegistrationArgs('update_food_log');
      mockMakeFitbitRequest.mockResolvedValue({ foodLog: { logId: 1 } });

      await handler({ foodLogId: 99, amount: 2 });

      const [endpoint, , , options] = mockMakeFitbitRequest.mock.calls[0] as [
        string,
        unknown,
        unknown,
        { method?: string },
      ];
      expect(endpoint).toBe('foods/log/99.json?amount=2');
      expect(options).toEqual({ method: 'POST' });
    });
  });

  describe('create_food tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('POSTs to /foods.json with skipUserPrefix and full nutrition', async () => {
      const { handler } = getToolRegistrationArgs('create_food');
      mockMakeFitbitRequest.mockResolvedValue({ food: { foodId: 100 } });

      await handler({
        name: 'My Salad',
        defaultFoodMeasurementUnitId: 304,
        defaultServingSize: 1,
        calories: 250,
        formType: 'DRY',
        description: 'leafy and crunchy',
        protein: 8,
        totalFat: 12,
        sodium: 300,
      });

      const [endpoint, , , options] = mockMakeFitbitRequest.mock.calls[0] as [
        string,
        unknown,
        unknown,
        { method?: string; skipUserPrefix?: boolean },
      ];
      expect(options).toEqual({ method: 'POST', skipUserPrefix: true });
      expect(endpoint.startsWith('foods.json?')).toBe(true);
      expect(endpoint).toContain('name=My+Salad');
      expect(endpoint).toContain('defaultFoodMeasurementUnitId=304');
      expect(endpoint).toContain('formType=DRY');
      expect(endpoint).toContain('protein=8');
      expect(endpoint).toContain('totalFat=12');
      expect(endpoint).toContain('sodium=300');
    });
  });

  describe('delete_custom_food tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('DELETEs at /foods/{id}.json with skipUserPrefix', async () => {
      const { handler } = getToolRegistrationArgs('delete_custom_food');
      mockMakeFitbitRequest.mockResolvedValue({});

      await handler({ foodId: 42 });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/42.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { method: 'DELETE', skipUserPrefix: true }
      );
    });
  });

  describe('log_water tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('POSTs date+amount and includes the optional unit', async () => {
      const { handler } = getToolRegistrationArgs('log_water');
      mockMakeFitbitRequest.mockResolvedValue({ waterLog: { logId: 1 } });

      await handler({ date: '2026-04-30', amount: 12, unit: 'fl oz' });

      const [endpoint] = mockMakeFitbitRequest.mock.calls[0] as [string];
      expect(endpoint.startsWith('foods/log/water.json?')).toBe(true);
      expect(endpoint).toContain('date=2026-04-30');
      expect(endpoint).toContain('amount=12');
      expect(endpoint).toContain('unit=fl+oz');
    });

    it('omits unit when not provided', async () => {
      const { handler } = getToolRegistrationArgs('log_water');
      mockMakeFitbitRequest.mockResolvedValue({ waterLog: { logId: 2 } });

      await handler({ date: '2026-04-30', amount: 250 });

      const [endpoint] = mockMakeFitbitRequest.mock.calls[0] as [string];
      expect(endpoint).not.toContain('unit=');
    });
  });

  describe('delete_water_log tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('DELETEs at the water log endpoint', async () => {
      const { handler } = getToolRegistrationArgs('delete_water_log');
      mockMakeFitbitRequest.mockResolvedValue({});

      await handler({ waterLogId: 7 });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/log/water/7.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { method: 'DELETE' }
      );
    });
  });

  describe('create_meal tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('POSTs JSON body to /meals.json', async () => {
      const { handler } = getToolRegistrationArgs('create_meal');
      mockMakeFitbitRequest.mockResolvedValue({ meal: { id: 1 } });

      const params = {
        name: 'Breakfast',
        description: 'oatmeal + banana',
        mealFoods: [
          { foodId: 81000, amount: 1, unitId: 147 },
          { foodId: 12345, amount: 0.5, unitId: 304 },
        ],
      };
      await handler(params);

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'meals.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        {
          method: 'POST',
          body: JSON.stringify(params),
          contentType: 'application/json',
        }
      );
    });
  });

  describe('delete_meal tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('DELETEs at /meals/{id}.json', async () => {
      const { handler } = getToolRegistrationArgs('delete_meal');
      mockMakeFitbitRequest.mockResolvedValue({});

      await handler({ mealId: 9 });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'meals/9.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { method: 'DELETE' }
      );
    });
  });

  describe('add_favorite_food tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('POSTs to /foods/log/favorite/{id}.json', async () => {
      const { handler } = getToolRegistrationArgs('add_favorite_food');
      mockMakeFitbitRequest.mockResolvedValue({});

      await handler({ foodId: 12 });

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/log/favorite/12.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        { method: 'POST' }
      );
    });
  });

  describe('get_meals tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('GETs /meals.json (user-scoped, no skipUserPrefix)', async () => {
      const { handler } = getToolRegistrationArgs('get_meals');
      mockMakeFitbitRequest.mockResolvedValue({ meals: [] });

      await handler({});

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'meals.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        {}
      );
    });
  });

  describe('get_recent_foods tool', () => {
    beforeEach(() => {
      registerNutritionTools(mockServer, mockGetAccessToken);
    });

    it('hits the legacy /foods/log/recent.json path', async () => {
      const { handler } = getToolRegistrationArgs('get_recent_foods');
      mockMakeFitbitRequest.mockResolvedValue([]);

      await handler({});

      expect(mockMakeFitbitRequest).toHaveBeenCalledWith(
        'foods/log/recent.json',
        mockGetAccessToken,
        'https://api.fitbit.com/1',
        {}
      );
    });
  });
});
