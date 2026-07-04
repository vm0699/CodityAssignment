import pg from 'pg';
import type { Db } from './db.js';
import { env } from './env.js';
import { createLogger } from './logger.js';
import type { PulseEvent } from './types.js';

const log = createLogger({ component: 'events' });

/** State-change fan-out channel (dashboard live updates). */
export const EVENTS_CHANNEL = 'pulse_events';
/** Wake-up ping for workers: "new work may be runnable, poll now". */
export const WAKE_CHANNEL = 'pulse_wake';

/**
 * Publishes an event through Postgres NOTIFY. Using the database as the bus
 * means every service sees events without adding a broker, and events emitted
 * inside a transaction are only delivered on commit — no phantom updates.
 */
export async function publishEvent(db: Db, event: Omit<PulseEvent, 'at'>): Promise<void> {
  const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
  await db.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, payload]);
}

export async function publishWake(db: Db): Promise<void> {
  await db.query(`SELECT pg_notify($1, '')`, [WAKE_CHANNEL]);
}

export interface Subscription {
  close(): Promise<void>;
}

/**
 * LISTENs on a channel with a dedicated connection. Reconnects with backoff
 * on connection loss — a worker must never silently stop hearing wake-ups.
 */
export async function subscribe(
  channel: string,
  onMessage: (payload: string) => void,
): Promise<Subscription> {
  let client: pg.Client | null = null;
  let closed = false;
  let reconnectDelay = 500;

  async function connect(): Promise<void> {
    if (closed) return;
    client = new pg.Client({ connectionString: env('DATABASE_URL') });
    client.on('notification', (msg) => {
      if (msg.channel === channel) onMessage(msg.payload ?? '');
    });
    client.on('error', (err) => {
      log.warn(`listener connection error on ${channel}, reconnecting`, { error: err.message });
      scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${channel}`);
    reconnectDelay = 500;
    log.debug(`listening on ${channel}`);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const old = client;
    client = null;
    old?.end().catch(() => undefined);
    setTimeout(() => {
      connect().catch((err) => {
        log.warn(`reconnect to ${channel} failed, retrying`, { error: (err as Error).message });
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
        scheduleReconnect();
      });
    }, reconnectDelay).unref();
  }

  await connect();

  return {
    async close() {
      closed = true;
      await client?.end().catch(() => undefined);
    },
  };
}
