#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { createGoogleOAuthClient } from './oauth/google.js';
import { JsonStore } from './oauth/store.js';
import { createApp } from './server.js';

// Load .env from the package root (one level up from build/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const config = loadConfig(process.env);
  const store = await JsonStore.open(path.join(config.dataDir, 'store.json'));
  const google = createGoogleOAuthClient(config, {
    healthApiBase: config.healthApiBase,
  });
  const app = createApp({ config, store, google });

  const server = app.listen(config.port, () => {
    console.error(
      `Google Health MCP server listening on port ${config.port}; MCP endpoint ${config.mcpUrl.href}`
    );
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    server.close();
    void store.flush().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
