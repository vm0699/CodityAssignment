import http from 'node:http';
import { closePool, createLogger, env, envInt, loadEnv, runMigrations } from '@pulse/core';
import { createApp } from './app.js';
import { attachWebSocketServer } from './ws.js';

loadEnv();
const log = createLogger({ component: 'api' });

if (process.env.RUN_MIGRATIONS !== 'false') {
  await runMigrations(env('DATABASE_URL'));
}

const app = createApp();
const server = http.createServer(app);
const wsHandle = await attachWebSocketServer(server);

const port = envInt('API_PORT', 4000);
server.listen(port, () => log.info(`Pulse API listening on http://localhost:${port}`));

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — shutting down`);
  server.close();
  await wsHandle.close();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
