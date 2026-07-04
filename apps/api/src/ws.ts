import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger, EVENTS_CHANNEL, subscribe, type PulseEvent, type Subscription } from '@pulse/core';
import { verifyToken } from './auth.js';

const log = createLogger({ component: 'ws' });

interface ClientMeta {
  userId: string;
  projectId: string | null;
}

/**
 * Live-update fan-out: one LISTEN connection to Postgres, N browser sockets.
 * Clients connect to /ws?token=<jwt>&projectId=<uuid> and receive only their
 * project's events (worker events are global and go to everyone).
 */
export async function attachWebSocketServer(server: Server): Promise<Subscription> {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map<WebSocket, ClientMeta>();

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) throw new Error('missing token');
      const claims = verifyToken(token);
      clients.set(socket, { userId: claims.sub, projectId: url.searchParams.get('projectId') });
      socket.send(JSON.stringify({ kind: 'connected', at: new Date().toISOString() }));
    } catch {
      socket.close(4001, 'unauthorized');
      return;
    }
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  const subscription = await subscribe(EVENTS_CHANNEL, (payload) => {
    let event: PulseEvent;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    for (const [socket, meta] of clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      // Project-scoped events go to that project's watchers; global events
      // (e.g. worker liveness, which has no projectId) go to everyone.
      if (event.projectId && meta.projectId && event.projectId !== meta.projectId) continue;
      socket.send(payload);
    }
  });

  log.info('WebSocket server attached at /ws');
  return {
    async close() {
      for (const socket of clients.keys()) socket.close(1001, 'server shutting down');
      wss.close();
      await subscription.close();
    },
  };
}
