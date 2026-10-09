# Contributing to MCP Fitbit Server

Thank you for your interest in contributing to the MCP Fitbit Server! This project acts as a 1:1 JSON proxy to the Google Health API (the successor of the Fitbit Web API), providing AI assistants with access to health data through a remote, multi-user MCP connector.

## 🎯 Project Philosophy

This MCP server is designed to be:
- **Simple and focused** - Direct proxy to the Google Health API without abstraction layers
- **Small remote service** - One container serving a handful of allowed Google accounts
- **Minimal complexity** - Easy to understand and maintain
- **API faithful** - Tools match Google Health API methods and parameters exactly

## 🚀 Getting Started

### Prerequisites
- Node.js 22+
- NPM
- A Google Cloud project with the Google Health API enabled and an OAuth client of type *Web application*

### Setup
1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL=http://localhost:8000` and `ALLOWED_EMAILS`
4. Build and start: `npm run dev`
5. Connect a client: `claude mcp add --transport http health http://localhost:8000/mcp` (or the MCP Inspector with Streamable HTTP)

## 📝 Development Workflow

### Making Changes
1. Create a feature branch from `main`
2. Make your changes following our coding conventions
3. Run the full validation suite:
   ```powershell
   npm run build
   npm run test:coverage
   npm run lint
   ```
4. Test your changes against a local server with Claude Code or the MCP Inspector
5. Create a pull request

### Code Conventions

**TypeScript Standards:**
- Use TypeScript with ES modules
- Zod for parameter validation
- Prefer explicit types over `any`

**API Integration:**
- Call the API through `api.call(extra, request)` (`src/google/client.ts`); paths start with `/users/me/...`
- Tool parameters must exactly match Google Health API requirements
- Return raw JSON via `toToolResponse` - no client-side data manipulation
- Check the [Google Health API docs](https://developers.google.com/health/) and the discovery document for endpoints, scopes and fields

**Error Handling:**
- Use `console.error` for debugging information
- Let errors bubble up naturally - don't swallow them
- Provide meaningful error messages

**Testing:**
- Write unit tests for all new tools using Vitest
- Follow the pattern in existing `*.test.ts` files
- Use a fake server (`{ registerTool: vi.fn() }`) and a fake `HealthApi` (`{ call: vi.fn() }`), then assert the request each handler builds
- Test tool registration, handler logic, error cases, and parameter validation

## 🧪 Testing

Run tests with:
```powershell
npm test                 # Run all tests
npm run test:coverage    # Run tests with coverage report
npm run test:ui          # Run tests with interactive UI
```

We aim for 80%+ test coverage. New features should include comprehensive tests.

## 🔍 Adding New Google Health Endpoints

Most data types are already reachable through the generic tools (`list_data_points`, `reconcile_data_points`, `daily_rollup`, `rollup`, `get_data_point`). To expose a new data type, add it to the right list in `src/google/data-types.ts`. New tools are only needed for new write operations or new non-dataPoints methods:

1. **Research the API first:** [Google Health API docs](https://developers.google.com/health/) and `https://health.googleapis.com/$discovery/rest?version=v4`
2. **Create or extend a tool module** in `src/tools/`
3. **Parameter validation:** Zod schemas matching the API fields (reuse `src/google/schemas.ts`)
4. **Register the module** in `src/mcp.ts`, and add any new scope to `DEFAULT_GOOGLE_SCOPES` in `src/config.ts`
5. **Write tests:** a corresponding `*.test.ts` file
6. **Update documentation:** README.md and CLAUDE.md

### Example Tool Structure:
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type HealthApi, toToolResponse } from '../google/client.js';
import { dataTypePath } from '../google/schemas.js';
import { READ_ONLY_ANNOTATIONS, registerTool } from '../utils.js';

export function registerExampleTools(server: McpServer, api: HealthApi) {
  registerTool(server, {
    name: 'list_weight',
    description: 'List weight data points (GET users/me/dataTypes/weight/dataPoints)',
    inputSchema: {
      filter: z.string().optional().describe('AIP-160 filter'),
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async ({ filter }, extra) =>
      toToolResponse(
        await api.call(extra, {
          path: dataTypePath('weight'),
          query: { filter },
        })
      ),
  });
}
```

## 📚 Documentation

- Update README.md for new features
- Add JSDoc comments for complex functions
- Update this CONTRIBUTING.md if development processes change
- Keep TASKS.md updated with completed items

## 🐛 Bug Reports

When reporting bugs:
- Include steps to reproduce
- Provide error messages and logs
- Mention your environment (Node.js version, OS)
- Test with `npm run dev` to see if it reproduces in the MCP inspector

## 💡 Feature Requests

For new features:
- Check existing issues first
- Explain the use case and benefit
- Consider if it fits the project's simple, focused philosophy
- Reference specific Google Health API methods and data types when applicable

## 📋 Pull Request Guidelines

- Use clear, descriptive commit messages
- Keep PRs focused on a single feature/fix
- Include tests for new functionality
- Update documentation as needed
- Ensure all CI checks pass

## 🔧 Development Commands

```powershell
npm run build         # Compile TypeScript
npm run start         # Run the built server
npm run dev           # Build and start the server
npm run lint          # Check code quality
npm run lint:fix      # Auto-fix linting issues
npm run format        # Format code with Prettier
npm run format:check  # Check code formatting
npm test              # Run tests
npm run test:coverage # Run tests with coverage
```

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## ❓ Questions?

Feel free to open an issue for questions about contributing or the codebase.

---

Thank you for helping make the MCP Fitbit Server better! 🎉
