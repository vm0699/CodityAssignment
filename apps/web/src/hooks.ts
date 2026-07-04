import { useCallback, useEffect, useRef, useState } from 'react';
import { api, wsUrl } from './api';

/**
 * Data hook: fetches immediately, refetches on an interval, and exposes a
 * manual refetch. Live events (WS) call refetch through `bumpLiveTick`.
 */
export function usePoll<T>(path: string | null, intervalMs = 5000, liveTick = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refetch = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const result = await api<T>(pathRef.current);
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    void refetch();
    const timer = setInterval(() => void refetch(), intervalMs);
    return () => clearInterval(timer);
  }, [path, intervalMs, refetch]);

  // Live events force an immediate refresh.
  useEffect(() => {
    if (liveTick > 0) void refetch();
  }, [liveTick, refetch]);

  return { data, error, loading, refetch };
}

export interface LiveEvent {
  kind: string;
  projectId?: string;
  jobId?: string;
  queueId?: string;
  workerId?: string;
  status?: string;
}

/**
 * Live updates over WebSocket with automatic reconnect. Returns a counter
 * that increments (debounced) whenever relevant events arrive — pages pass it
 * to usePoll to refresh instantly instead of waiting for the next poll.
 */
export function useLiveEvents(projectId: string | null): { tick: number; connected: boolean; lastEvent: LiveEvent | null } {
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      socket = new WebSocket(wsUrl(projectId!));
      socket.onopen = () => setConnected(true);
      socket.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as LiveEvent;
          if (event.kind === 'connected') return;
          setLastEvent(event);
          // Debounce bursts (a batch of 100 jobs completing) into one refresh.
          if (!debounceTimer) {
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              setTick((t) => t + 1);
            }, 400);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      socket?.close();
    };
  }, [projectId]);

  return { tick, connected, lastEvent };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Pulse`;
  }, [title]);
}
