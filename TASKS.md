# MCP Google Health Server - Remaining Tasks

Version 2.0 migrated the server from the Fitbit Web API (shut down 2026-10-30) to the Google Health API and turned it into a remote, multi-user MCP connector with OAuth.

## Validate against the live API (Priority: High)
*   **V1:** Confirm every default scope is offered in the Google Cloud "Data access" picker (the v4 discovery document does not list `googlehealth.nutrition.readonly`). If one is missing, drop it via `GOOGLE_SCOPES` and in `DEFAULT_GOOGLE_SCOPES`.
*   **V2:** Check each filter style once against real data: interval (`steps`, `nutrition_log`), sample (`weight`), daily (`daily_resting_heart_rate.date`) and sleep (`sleep.interval.civil_end_time`).
*   **V3:** Check which `mealType` values are accepted when creating a nutrition log (the docs mention only BREAKFAST, LUNCH, DINNER and SNACK) and narrow `MEAL_TYPES` if needed.
*   **V4:** Check whether `delete_food_logs` / `update_water_log` work on entries created by the Fitbit / Google Health apps, or only on entries this server created.
*   **V5:** Confirm that publishing the Google app ("In production", unverified) removes the 7-day refresh token expiry for the restricted Health scopes.

## Possible improvements (Priority: Medium)
*   **I1:** Optional `exportExerciseTcx` and `pairedDevices` tools (methods exist in the API).
*   **I2:** Persist MCP access tokens so a restart doesn't force every client to refresh (currently in memory by design).
*   **I3:** Admin endpoint or CLI to list connected users and revoke a user's tokens.

## Design Philosophy Reminder

This MCP server is designed to be:
- **Simple and focused** - 1:1 proxy to the Google Health API
- **Small remote service** - One container, a few allowed Google accounts
- **Minimal complexity** - Easy to understand and maintain

## Contributing

When working on remaining tasks:
1. Maintain the project's simplicity
2. Avoid over-engineering solutions
3. Test against a local server with Claude Code or the MCP Inspector
4. Update this document when completed
