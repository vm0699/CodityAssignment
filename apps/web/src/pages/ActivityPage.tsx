import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { useDocumentTitle, usePoll } from '../hooks';
import type { Paginated, SystemEvent } from '../types';
import { Card, inputClass } from '../ui';

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-slate-500',
  info: 'text-sky-300',
  warn: 'text-amber-300',
  error: 'text-red-400',
};

const COMPONENT_TONE: Record<string, string> = {
  'concurrency.claim': 'text-violet-300',
  'reliability.reaper': 'text-amber-300',
  'reliability.dlq': 'text-red-300',
  'scheduler.leader-election': 'text-emerald-300',
  'scheduler.cron': 'text-sky-300',
  'scheduler.promote': 'text-sky-300',
  'worker.lifecycle': 'text-slate-300',
  'api.rate-limit': 'text-amber-300',
  migrate: 'text-slate-300',
};

export default function ActivityPage() {
  useDocumentTitle('Activity Log');
  const { liveTick } = useApp();
  const [filter, setFilter] = useState('');
  const { data } = usePoll<Paginated<SystemEvent> | { data: SystemEvent[] }>('/api/system/events?limit=300', 3000, liveTick);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  const events = useMemo(() => {
    const raw = [...(data?.data ?? [])].reverse(); // API returns newest-first; feed reads oldest-to-newest
    if (!filter.trim()) return raw;
    const needle = filter.toLowerCase();
    return raw.filter((e) => e.component.toLowerCase().includes(needle) || e.message.toLowerCase().includes(needle));
  }, [data, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  });

  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, paused]);

  const components = useMemo(() => [...new Set((data?.data ?? []).map((e) => e.component))].sort(), [data]);

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Activity log</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          A live feed of the platform&rsquo;s own operational machinery &mdash; atomic job claims
          (<code className="rounded bg-surface-200 px-1 text-slate-600">SKIP LOCKED</code>), worker heartbeats and reaper crash-recovery,
          scheduler leader election, cron fires, rate-limit trips, and Dead Letter Queue moves. This is the
          concurrency and reliability engineering happening under the hood, not just what the rest of the UI shows.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} !w-64`}
          placeholder="Filter by component or text&hellip;"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {components.slice(0, 8).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(filter === c ? '' : c)}
              className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset transition ${
                filter === c
                  ? 'bg-accent-soft text-accent ring-accent/30'
                  : 'bg-white text-slate-500 ring-surface-300 hover:text-slate-800'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className={`ml-auto rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            paused ? 'bg-amber-50 text-amber-700' : 'bg-white text-slate-600 border border-surface-300 hover:bg-surface-100'
          }`}
        >
          {paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        </button>
      </div>

      {/* Deliberately dark, terminal-style panel — a light gray-on-white log
          feed reads poorly at density; this matches the convention of CI/
          deploy log viewers (GitHub Actions, Vercel, Render) sitting inside
          an otherwise light dashboard. */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden !border-slate-800 !bg-slate-900 !shadow-none">
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
        >
          {events.length === 0 && (
            <div className="text-slate-500">
              No activity yet &mdash; start a worker (<code>npm run dev:worker</code>) and scheduler
              (<code>npm run dev:scheduler</code>) to see live events here.
            </div>
          )}
          {events.map((e) => (
            <div key={e.id} className="flex gap-2 py-0.5 hover:bg-white/5">
              <span className="shrink-0 text-slate-500">{new Date(e.created_at).toLocaleTimeString()}</span>
              <span className={`shrink-0 w-12 uppercase ${LEVEL_COLOR[e.level] ?? 'text-slate-400'}`}>{e.level}</span>
              <span className={`shrink-0 w-44 truncate ${COMPONENT_TONE[e.component] ?? 'text-slate-400'}`}>
                {e.component}
              </span>
              <span className="text-slate-300">{e.message}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
