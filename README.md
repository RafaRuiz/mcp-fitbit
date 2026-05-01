# Fitbit MCP Connector for AI

[![Fitbit API](https://img.shields.io/badge/Fitbit-00B0B9?logo=fitbit&logoColor=white)](https://dev.fitbit.com/)
[![CI](https://github.com/TheDigitalNinja/mcp-fitbit/actions/workflows/ci.yml/badge.svg)](https://github.com/TheDigitalNinja/mcp-fitbit/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/TheDigitalNinja/mcp-fitbit/badge.svg?branch=main)](https://coveralls.io/github/TheDigitalNinja/mcp-fitbit?branch=main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/mcp-fitbit.svg)](https://badge.fury.io/js/mcp-fitbit)
[![npm downloads](https://img.shields.io/npm/dm/mcp-fitbit.svg)](https://www.npmjs.com/package/mcp-fitbit)

> Connect AI assistants to your Fitbit health data

Give your AI assistant access to your Fitbit data for personalized health insights, trend analysis, and automated tracking. Works with Claude Desktop and other MCP-compatible AI tools.

## What it does

🏃 **Exercise & Activities** - Get detailed workout logs and activity data  
😴 **Sleep Analysis** - Retrieve sleep patterns and quality metrics  
⚖️ **Weight Tracking** - Access weight trends over time  
❤️ **Heart Rate Data** - Monitor heart rate patterns and zones  
🍎 **Nutrition Logs** - Review food intake, calories, and macros  
🥗 **Log Foods & Meals** - Chat to log meals with full macro/micro detail (kcal, protein, carbs, sat/trans fat, fiber, sodium, vitamins, minerals…), water, custom foods, and saved meals  
👤 **Profile Info** - Access basic Fitbit profile details

*Ask your AI things like: "Show me my sleep patterns this week", "What's my average heart rate during workouts?", or "Log my breakfast: 2 eggs, 1 slice toast, 200g Greek yogurt with the nutrition values".*

## Quick Start

**🚀 Want to test the tools right away?**

### Option 1: Install from npm (Recommended)
1. [Get Fitbit API credentials](https://dev.fitbit.com/)
   - Create an app with OAuth 2.0 Application Type: `Personal`
   - Set Callback URL: `http://localhost:3000/callback`
   - Note your **Client ID** and **Client Secret**

2. Install the package globally:
```bash
npm install -g mcp-fitbit
```

3. Add to your Claude Desktop config file:
```json
{
  "mcpServers": {
    "fitbit": {
      "command": "mcp-fitbit",
      "args": [],
      "env": {
        "FITBIT_CLIENT_ID": "your_client_id_here",
        "FITBIT_CLIENT_SECRET": "your_client_secret_here"
      }
    }
  }
}
```
 - Config file location:
   - Windows: %AppData%\Claude\claude_desktop_config.json
   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
   - Linux: ~/.config/Claude/claude_desktop_config.json

4. Restart Claude Desktop and ask about your Fitbit data!



### Option 2: Development Setup
1. [Get Fitbit API credentials](https://dev.fitbit.com/) (see Installation below)
2. Then run:

```bash
git clone https://github.com/TheDigitalNinja/mcp-fitbit
cd mcp-fitbit
npm install
# Create .env with your Fitbit credentials
npm run dev
```

Both options open the **MCP Inspector** at `http://localhost:5173` where you can test all tools interactively and handle the OAuth flow.

## Installation

### For End Users (npm package)

1. **Get Fitbit API credentials** at [dev.fitbit.com](https://dev.fitbit.com/)
   - Set **OAuth 2.0 Application Type** to `Personal`  
   - Set **Callback URL** to `http://localhost:3000/callback`

2. **Install the package:**
   ```bash
   npm install -g mcp-fitbit
   ```

3. **Create `.env` file in the package directory:**
   
   When you run `mcp-fitbit` for the first time, it will tell you exactly where to create the `.env` file. It will look something like:
   ```
   C:\Users\YourName\AppData\Roaming\npm\node_modules\mcp-fitbit\.env
   ```

4. **Add your credentials to the `.env` file:**
   ```bash
   FITBIT_CLIENT_ID=your_client_id_here
   FITBIT_CLIENT_SECRET=your_client_secret_here
   ```

5. **Run the server:**
   ```bash
   mcp-fitbit
   ```

### For Developers (from source)

1. **Get Fitbit API credentials** at [dev.fitbit.com](https://dev.fitbit.com/)
   - Set **OAuth 2.0 Application Type** to `Personal`
   - Set **Callback URL** to `http://localhost:3000/callback`

2. **Clone and setup:**
   ```bash
   git clone https://github.com/TheDigitalNinja/mcp-fitbit
   cd mcp-fitbit
   npm install
   ```

3. **Create `.env` file:**
   ```bash
   FITBIT_CLIENT_ID=your_client_id_here
   FITBIT_CLIENT_SECRET=your_client_secret_here
   ```

4. **Build the server:**
   ```bash
   npm run build
   ```


## Available Tools

### Read tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_weight` | Weight data over time periods | `period`: `1d`, `7d`, `30d`, `3m`, `6m`, `1y` |
| `get_sleep_by_date_range` | Sleep logs for date range (max 100 days) | `startDate`, `endDate` (YYYY-MM-DD) |
| `get_exercises` | Activity/exercise logs after date | `afterDate` (YYYY-MM-DD), `limit` (1-100) |
| `get_daily_activity_summary` | Daily activity summary with goals | `date` (YYYY-MM-DD) |
| `get_activity_goals` | User's activity goals (daily/weekly) | `period`: `daily`, `weekly` |
| `get_activity_timeseries` | Activity time series data (max 30 days) | `resourcePath`, `startDate`, `endDate` (YYYY-MM-DD) |
| `get_azm_timeseries` | Active Zone Minutes time series (max 1095 days) | `startDate`, `endDate` (YYYY-MM-DD) |
| `get_heart_rate` | Heart rate for time period | `period`: `1d`, `7d`, `30d`, `1w`, `1m`, optional `date` |
| `get_heart_rate_by_date_range` | Heart rate for date range (max 1 year) | `startDate`, `endDate` (YYYY-MM-DD) |
| `get_food_log` | Complete nutrition data for a day | `date` (YYYY-MM-DD or "today") |
| `get_nutrition` | Individual nutrient over time | `resource`, `period`, optional `date` |
| `get_nutrition_by_date_range` | Individual nutrient for date range | `resource`, `startDate`, `endDate` |
| `search_foods` | Search Fitbit's public + your private food database | `query` |
| `get_food` | Full details for a specific food | `foodId` |
| `get_food_units` | List of valid Fitbit food units (id → name) | None |
| `get_food_locales` | Locales supported by the foods database | None |
| `get_water_log` | Water entries and total for a date | `date` |
| `get_meals` | All saved meals | None |
| `get_meal` | A single saved meal | `mealId` |
| `get_favorite_foods` | Favorite foods | None |
| `get_recent_foods` | Recently consumed foods | None |
| `get_frequent_foods` | Frequently consumed foods | None |
| `get_profile` | User profile information | None |

### Write tools (nutrition)

| Tool | Description | Parameters |
|------|-------------|------------|
| `log_food` | Log a food entry with full macro/micro detail. Provide either `foodId` (from `search_foods`) or `foodName` + nutrition values for a one-off custom entry. | `date`, `mealTypeId`, `unitId`, `amount`, plus `foodId`/`favorite` OR `foodName`/`brandName`/`calories`/`totalFat`/`saturatedFat`/`transFat`/`cholesterol`/`sodium`/`potassium`/`totalCarbohydrate`/`dietaryFiber`/`sugars`/`protein`/`vitamin*`/`calcium`/`iron`/`magnesium`/etc. |
| `update_food_log` | Update quantity/calories on an existing food log entry | `foodLogId`, optional `mealTypeId`/`unitId`/`amount`/`calories` |
| `delete_food_log` | Remove a food log entry | `foodLogId` |
| `create_food` | Save a private (custom) food with full nutrition | `name`, `defaultFoodMeasurementUnitId`, `defaultServingSize`, `calories`, optional `formType`/`description`/all macro/micro fields |
| `delete_custom_food` | Delete one of your private foods | `foodId` |
| `log_water` | Log a water entry | `date`, `amount`, optional `unit` (`ml`, `fl oz`, `cup`) |
| `update_water_log` | Update an existing water entry | `waterLogId`, `amount`, optional `unit` |
| `delete_water_log` | Remove a water entry | `waterLogId` |
| `create_meal` | Save a meal made of multiple foods | `name`, `description`, `mealFoods[]` (`{foodId, amount, unitId}`) |
| `update_meal` | Replace the contents of a saved meal | `mealId`, `name`, `description`, `mealFoods[]` |
| `delete_meal` | Delete a saved meal | `mealId` |
| `add_favorite_food` | Add a food to favorites | `foodId` |
| `delete_favorite_food` | Remove a food from favorites | `foodId` |

**Meal type IDs (`mealTypeId`):** `1`=Breakfast, `2`=Morning Snack, `3`=Lunch, `4`=Afternoon Snack, `5`=Dinner, `7`=Anytime.

**Nutrition resources:** `caloriesIn`, `water`, `protein`, `carbs`, `fat`, `fiber`, `sodium`

**Activity time series resources:** `steps`, `distance`, `calories`, `activityCalories`, `caloriesBMR`, `tracker/activityCalories`, `tracker/calories`, `tracker/distance`

### Logging meals from chat

Typical workflow when chatting with your AI assistant:

1. *"Log my lunch: 150g grilled chicken, 200g rice, 1 cup broccoli."*
2. The assistant calls `search_foods` for each item to look up `foodId` + `unitId`.
3. It calls `log_food` once per item with `date`, `mealTypeId=3`, `unitId`, `amount`.
4. For one-off or custom dishes (e.g. *"my homemade lasagna with these macros…"*), it uses `log_food` with `foodName` plus `calories`, `protein`, `totalFat`, `saturatedFat`, `transFat`, `dietaryFiber`, `sodium`, etc., or it can `create_food` first to get a reusable `foodId` and then `log_food` by id.

### Claude Desktop

**Using npm package (recommended):**

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "fitbit": {
      "command": "mcp-fitbit",
      "args": []
    }
  }
}
```

**Using local development version:**

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "fitbit": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-fitbit\\build\\index.js"]
    }
  }
}
```

**Config file locations:**
- Windows: `%AppData%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### First Run Authorization

When you first ask your AI assistant to use Fitbit data:
1. The server opens your browser to `http://localhost:3000/auth`
2. Log in to Fitbit and grant permissions
3. You'll be redirected to a success page
4. Your AI can now access your Fitbit data!

## Development

```bash
npm run lint          # Check code quality
npm run format        # Fix formatting
npm run build         # Compile TypeScript
npm run dev           # Run with MCP inspector
```

**Architecture:** See [TASKS.md](TASKS.md) for improvement opportunities and technical details.

