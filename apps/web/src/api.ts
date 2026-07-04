/** Typed fetch wrapper with JWT handling and API error unwrapping. */

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem('pulse_token');
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem('pulse_token', token);
  else localStorage.removeItem('pulse_token');
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    if (res.status === 401 && getToken()) {
      // Session expired — clear and bounce to login.
      setToken(null);
      window.dispatchEvent(new Event('pulse:logout'));
    }
    throw new ApiRequestError(res.status, err.code ?? 'ERROR', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** WebSocket URL for live updates (proxied by Vite in dev, nginx in prod). */
export function wsUrl(projectId: string): string {
  const token = getToken() ?? '';
  const base = BASE || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = `?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`;
  return url.toString();
}
