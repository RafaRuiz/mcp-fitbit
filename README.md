# Google Health (Fitbit) MCP Connector for AI

[![CI](https://github.com/TheDigitalNinja/mcp-fitbit/actions/workflows/ci.yml/badge.svg)](https://github.com/TheDigitalNinja/mcp-fitbit/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/TheDigitalNinja/mcp-fitbit/badge.svg?branch=main)](https://coveralls.io/github/TheDigitalNinja/mcp-fitbit?branch=main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Connect Claude to your Fitbit / Google Health data, for several people at once

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for the **Google Health API**, the successor of the Fitbit Web API. Fitbit's API stops working on **2026-10-30**; this version talks to `health.googleapis.com/v4` instead.

Each person adds the connector in their own Claude (web, desktop or mobile) and signs in with their own Google account. The server keeps every user's Google tokens separate, and only the Google accounts you allow can connect.

## What it does

📈 **Any health data type**: steps, distance, calories, active zone minutes, heart rate, HRV, SpO2, weight, body fat, sleep, exercise, VO2 max… via generic list / reconcile / rollup tools  
📅 **Daily totals**: `daily_rollup` for steps, calories, nutrition and water per day  
🥗 **Log food**: chat to log meals with full macros and micronutrients (in grams)  
💧 **Log water**: create, update and delete hydration entries  
👤 **Profile & settings**: age, units, time zone and UTC offset

*Ask things like: "How did I sleep this week?", "Steps per day in September", or "Log my breakfast: 3 eggs and a slice of toast with these macros…".*

## Architecture

```
Claude (web / desktop / mobile / Claude Code)
   │  OAuth 2.1 (DCR + PKCE) + Streamable HTTP
   ▼
this server ── /authorize → Google sign-in → /oauth/google/callback
   │  per-user Google tokens (store.json)
   ▼
Google Health API v4
```

The server is its own OAuth authorization server and delegates sign-in to Google: Claude only ever sees this server's tokens, and the Google refresh tokens stay on the server. See [`docker/README.md`](docker/README.md) for a full deployment guide (CapRover, in Spanish).

## Setup

### 1. Google Cloud
1. Enable the **Google Health API** in a Google Cloud project.
2. Create an **OAuth client ID** of type *Web application*, with redirect URI `https://<your-host>/oauth/google/callback` (plus `http://localhost:8000/oauth/google/callback` for local testing).
3. Under **Google Auth Platform → Data access**, add the scopes: `openid`, `email` and the `googlehealth` scopes `activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`, `sleep.readonly`, `nutrition.readonly`, `nutrition.writeonly`, `profile.readonly` and `settings.readonly`.
4. Under **Audience**, add every user as a test user. Apps in *Testing* get Google refresh tokens that expire after 7 days. Publish the app (unverified, up to 100 users) to avoid weekly reconnects.
5. Every user must have opened the **Google Health app** once and finished moving their Fitbit account.

### 2. Run the server
```bash
cp .env.example .env   # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL, ALLOWED_EMAILS
npm install
npm run build
npm start              # http://localhost:8000, MCP endpoint at /mcp
```
Or use the Dockerfile; mount a persistent volume at `/data`.

### 3. Connect Claude
- **claude.ai / Claude desktop / mobile:** Settings → Connectors → Add custom connector → `https://<your-host>/mcp`. Leave the OAuth client fields empty.
- **Claude Code:** `claude mcp add --transport http health https://<your-host>/mcp`, then `/mcp` → Authenticate.

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Google OAuth Web client |
| `PUBLIC_BASE_URL` | yes | Public origin (https in production) |
| `ALLOWED_EMAILS` | yes | Comma-separated Google accounts allowed to connect |
| `DATA_DIR` | no | Where `store.json` lives (default `./data`, `/data` in Docker) |
| `PORT` | no | Default `8000` |
| `TRUST_PROXY` | no | Reverse proxy hops (default `1`) |
| `GOOGLE_SCOPES` | no | Space-separated scope override |

## Available Tools

### Read
| Tool | API method | Notes |
|---|---|---|
| `list_data_points` | `dataPoints.list` | Any data type, AIP-160 time filter, paging, data source family |
| `get_data_point` | `dataPoints.get` | Single data point (e.g. a food or measurement unit) |
| `reconcile_data_points` | `dataPoints.reconcile` | Merged across sources; preferred for sleep |
| `daily_rollup` | `dataPoints.dailyRollUp` | Daily buckets in civil time (steps, total-calories, nutrition-log, hydration-log…) |
| `rollup` | `dataPoints.rollUp` | Fixed windows over a physical time range (e.g. hourly heart rate) |
| `get_profile` / `get_settings` / `get_identity` | `users.*` | Profile, units/time zone/UTC offset, user ids |

Filter examples: `weight.sample_time.civil_time >= "2026-10-01"`, `nutrition_log.interval.civil_start_time >= "2026-10-09" AND nutrition_log.interval.civil_start_time < "2026-10-10"`, `sleep.interval.civil_end_time >= "2026-10-01"`.

### Write
| Tool | API method | Notes |
|---|---|---|
| `log_food` | `nutrition-log` create | Anonymous food (`foodDisplayName` + values) or identified food (`food`); every nutrient in **grams** |
| `delete_food_logs` | `nutrition-log` batchDelete | Anonymous food logs can't be edited: delete and log again |
| `log_water` / `update_water_log` / `delete_water_logs` | `hydration-log` create / patch / batchDelete | Amounts in milliliters |

Timestamps are RFC 3339 and UTC offsets are durations (`"7200s"` = UTC+2).

### Removed in 2.0
The Google Health API has no equivalent for these Fitbit tools: activity goals, food search, food locales, custom foods, saved meals, and favorite, recent and frequent foods. Keep your usual meals in your Claude project instructions and log each food with its nutrients.

## Development
```bash
npm run build          # compile
npm test               # unit + integration tests (Vitest)
npm run test:coverage
npm run lint
npm run format
```

## License
MIT
