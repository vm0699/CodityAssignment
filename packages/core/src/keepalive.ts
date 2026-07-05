import http from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger({ component: 'keepalive' });

/**
 * Binds a bare-bones HTTP server that answers 200 on any path. Free-tier PaaS
 * platforms (Render, etc.) only offer perpetual compute to "web service"
 * deployments, which requires binding to $PORT — this lets the worker and
 * scheduler (which have no HTTP API of their own) qualify for that tier
 * while their real work continues in the background, unaffected.
 */
export function startHealthServer(port: number): void {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    })
    .listen(port, () => log.info(`health endpoint listening on :${port} (for platform health checks)`));
}

/**
 * Self-pings the service's own public URL on an interval. Free web-service
 * tiers spin a service down after ~15 minutes with no *inbound* HTTP traffic
 * — a worker/scheduler normally never receives any, since nothing calls
 * them over HTTP. This keeps them warm without a paid "always-on" plan.
 * Disclosed trade-off, not hidden: see docs/DEPLOYMENT.md.
 */
export function startKeepAlivePing(url: string, intervalMs = 600_000): void {
  const ping = () => {
    fetch(url).catch((err) => log.warn('keep-alive ping failed', { error: (err as Error).message }));
  };
  setInterval(ping, intervalMs).unref();
  log.info(`keep-alive ping scheduled every ${Math.round(intervalMs / 60_000)} min`, { url });
}
