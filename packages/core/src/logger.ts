/**
 * Minimal structured logger. Pretty colored output on TTYs for development,
 * newline-delimited JSON when LOG_FORMAT=json (container/production mode) so
 * logs are machine-parseable.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const minLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';
const asJson = process.env.LOG_FORMAT === 'json' || (!process.stdout.isTTY && process.env.LOG_FORMAT !== 'pretty');

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function write(level: Level, scope: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const time = new Date().toISOString();
  if (asJson) {
    process.stdout.write(JSON.stringify({ time, level, msg, ...scope, ...ctx }) + '\n');
  } else {
    const extra = { ...scope, ...ctx };
    const extraStr = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
    process.stdout.write(`${COLORS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}\x1b[90m${extraStr}${RESET}\n`);
  }
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, ctx) => write('debug', bindings, msg, ctx),
    info: (msg, ctx) => write('info', bindings, msg, ctx),
    warn: (msg, ctx) => write('warn', bindings, msg, ctx),
    error: (msg, ctx) => write('error', bindings, msg, ctx),
    child: (more) => createLogger({ ...bindings, ...more }),
  };
}
