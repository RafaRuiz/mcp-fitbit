# GitHub Copilot Instructions

## Project Overview
Remote, multi-user MCP server for the **Google Health API v4** (`https://health.googleapis.com/v4`), the successor of the Fitbit Web API (shut down 2026-10-30). Each Claude user adds the connector and signs in with their own Google account via OAuth.

**Design Philosophy:** This MCP server acts as a 1:1 JSON proxy to the Google Health API. Tools match the API's methods and parameters (list / get / reconcile / rollUp / dailyRollUp / create / patch / batchDelete) without abstraction layers or client-side data manipulation, and return the raw JSON responses. Reads are generic over `dataType`; writes (food and water) have typed parameters because the request bodies are strict.

## Development Commands
- `npm run build` - Compile TypeScript to build/ directory
- `npm run start` - Run the built server (HTTP on `PORT`, default 8000)
- `npm run dev` - Build and start
- `npm run lint` - Check code quality and style issues
- `npm run format` - Auto-fix code formatting
- `npm test` - Run tests with Vitest
- `npm run test:coverage` - Run tests with coverage report

## CI/CD
- GitHub Actions workflow runs tests, lint checks, and build on push/PR to main branch
- Located at `.github/workflows/ci.yml`
- Deployment: Docker image for CapRover, see `docker/README.md`

## Project Structure
- `src/index.ts` - Entry point: loads config, opens the OAuth store, starts the HTTP app
- `src/config.ts` - Constants (API base, Google URLs and scopes, allowed redirect URIs) and `loadConfig(env)`
- `src/server.ts` - Express app: SDK `mcpAuthRouter` (metadata, /register, /authorize, /token, /revoke), `/oauth/google/callback`, bearer-protected stateless Streamable HTTP at `POST /mcp`, `/health`
- `src/mcp.ts` - `createMcpServer(api)`: new McpServer per request with all tools registered
- `src/utils.ts` - `registerTool`, response helpers, tool annotations, `ToolExtra` type
- `src/google/client.ts` - `createHealthApi` (auth header, retries, error pass-through) and `toToolResponse`
- `src/google/data-types.ts` - Data type enums per operation, meal types, nutrients, volume units
- `src/google/schemas.ts` - Zod schemas (dates, RFC 3339, durations, data point ids) and request helpers
- `src/oauth/provider.ts` - `HealthOAuthProvider`: OAuth 2.1 server for MCP clients that delegates sign-in to Google
- `src/oauth/google.ts` - Google OAuth client (authorize URL, code/refresh exchange, id_token verification, identity) and `GoogleTokenService` (per-user token refresh)
- `src/oauth/store.ts` - `JsonStore`: clients, hashed MCP refresh tokens and Google tokens in `${DATA_DIR}/store.json`
- `src/tools/data-points.ts` - list_data_points, get_data_point, reconcile_data_points, daily_rollup, rollup
- `src/tools/profile.ts` - get_profile, get_settings, get_identity
- `src/tools/nutrition.ts` - log_food, delete_food_logs
- `src/tools/hydration.ts` - log_water, update_water_log, delete_water_logs
- `build/` - Compiled JavaScript output
- `.env` - Environment variables (see `.env.example`)

## Code Conventions
- TypeScript with ES modules, Node >= 22
- Zod (v3 API) for parameter validation; register tools with `registerTool` from `src/utils.ts` (wraps `server.registerTool`)
- Tool handlers receive `(params, extra)` and call `api.call(extra, request)`; never read tokens directly
- All tools return raw JSON from the Google Health API via `toToolResponse`; API errors are returned with their HTTP status and Google error body
- Error handling with console.error for debugging (stdout is free now, but keep logs on stderr)
- **API Fidelity:** Tool parameters must match the Google Health API - no client-side workarounds or data filtering
- **Documentation First:** Check https://developers.google.com/health/ and the discovery doc (`https://health.googleapis.com/$discovery/rest?version=v4`) when adding endpoints to get parameters, scopes, and response formats right
- **Paths:** data type paths are kebab-case (`users/me/dataTypes/nutrition-log/dataPoints`); filter fields are snake_case (`nutrition_log.interval.civil_start_time`)
- **Units:** all nutrient quantities are grams; energy is kcal; volumes are milliliters
- **UTC offsets** are durations in seconds (`"7200s"` = UTC+2), not `+02:00`
- **Lint/format globs are quoted** in package.json (`'src/**/*.ts'`) so subdirectories are included

## Authentication Architecture
- MCP clients (claude.ai, Claude Code, MCP Inspector) discover OAuth via `401` + `WWW-Authenticate: resource_metadata=...`, register with DCR, and use PKCE
- Allowed DCR redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, and loopback `http://localhost|127.0.0.1:*`
- `/authorize` redirects to Google (`access_type=offline`, `prompt=consent`); `/oauth/google/callback` verifies the id_token, enforces `ALLOWED_EMAILS`, stores the user's Google refresh token, and redirects back with our own authorization code
- MCP access tokens (1 h, memory only) carry `extra.userId` (Google `sub`); MCP refresh tokens (90 days, rotated) are persisted hashed
- `GoogleTokenService` refreshes Google access tokens per user (single in-flight refresh); `invalid_grant` marks the user revoked and the client must reconnect
- Instance count must be 1 (in-memory codes and access tokens)

## Testing the Server
**Local (Claude Code):**
1. Create `.env` from `.env.example` with `PUBLIC_BASE_URL=http://localhost:8000` and a Google OAuth client whose redirect URIs include `http://localhost:8000/oauth/google/callback`
2. `npm run build && npm start`
3. `claude mcp add --transport http health http://localhost:8000/mcp`, then `/mcp` → Authenticate
4. Or use `npx @modelcontextprotocol/inspector` with transport "Streamable HTTP" and URL `http://localhost:8000/mcp`

**Tools available after auth:**
- **Read:** list_data_points, get_data_point, reconcile_data_points, daily_rollup, rollup, get_profile, get_settings, get_identity
- **Write:** log_food, delete_food_logs, log_water, update_water_log, delete_water_logs

## Environment Setup
Requires `.env` (or container env) with:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://health.example.com
ALLOWED_EMAILS=you@gmail.com,partner@gmail.com
```
Optional: `DATA_DIR`, `PORT`, `TRUST_PROXY`, `GOOGLE_SCOPES`, `HEALTH_API_BASE`, `MCP_ACCESS_TOKEN_TTL_SECONDS`, `MCP_REFRESH_TOKEN_TTL_SECONDS`.

## API Notes
- Methods: `list` (GET, filter/pageSize/pageToken/dataSourceFamily), `reconcile` (GET), `dailyRollUp` / `rollUp` (POST, body with range), `create` (POST, returns Operation), `patch` (PATCH, full DataPoint), `batchDelete` (POST `{names}`)
- Filters (AIP-160, `>=` / `<` / `AND`): interval types use `{type}.interval.civil_start_time`, sample types `{type}.sample_time.civil_time`, daily types `{type}.date`, sleep only `sleep.interval.civil_end_time`
- Page size max 10000 (25 for exercise and sleep); rollup range max 14 days for heart-rate, active-minutes, total-calories, calories-in-heart-rate-zone, 90 days otherwise
- Session intervals (nutrition-log, hydration-log) need `endTime` strictly after `startTime` (`INVALID_TIME_RANGE`); the write tools default it to start + 1 minute, like the Fitbit app
- Nutrition logs from anonymous food (foodDisplayName + values) are not editable: delete and re-create
- There is no food search, custom food creation, saved meals or favorites in this API
- Rate limit: 300 requests/minute per user

## Contributing & Improvements

When working on this codebase:
1. Follow the existing code style and patterns
2. Update relevant documentation
3. Test changes with Claude Code or the MCP Inspector against a local server
4. Keep tool names and parameters stable for connected users
5. **VERY IMPORTANT:** When you have completed a task, you MUST run both build, test, and lint commands (`npm run build` then `npm run test:coverage` then  `npm run lint`) to ensure your code is correct
6. Update documentation when making changes

**For identified improvement opportunities, see [TASKS.md](TASKS.md)**
