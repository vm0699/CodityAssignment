import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../App';
import { usePoll, useDocumentTitle } from '../hooks';
import type { Overview, Paginated, QueueStats, Queue, ThroughputPoint, WorkerView } from '../types';
import { Card, Empty, StatCard, StatusBadge, formatDuration } from '../ui';

export default function OverviewPage() {
  useDocumentTitle('Overview');
  const { project, liveTick } = useApp();
  const pid = project!.id;

  const { data: overview } = usePoll<Overview>(`/api/projects/${pid}/metrics/overview`, 5000, liveTick);
  const { data: throughput } = usePoll<{ data: ThroughputPoint[] }>(
    `/api/projects/${pid}/metrics/throughput?windowMinutes=30&bucketSeconds=30`, 5000, liveTick);
  const { data: queues } = usePoll<{ data: Queue[] }>(`/api/projects/${pid}/queues`, 10_000, liveTick);
  const { data: stats } = usePoll<{ data: QueueStats[] }>(`/api/projects/${pid}/queues/stats`, 5000, liveTick);
  const { data: workers } = usePoll<Paginated<WorkerView>>(`/api/workers`, 5000, liveTick);

  const counts = overview?.status_counts ?? {};
  const active = (counts.claimed ?? 0) + (counts.running ?? 0);
  const backlog = (counts.queued ?? 0) + (counts.scheduled ?? 0);
  const chartData = (throughput?.data ?? []).map((p) => ({
    ...p,
    time: new Date(p.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Overview</h1>
        <p className="text-sm text-slate-500">{project!.name} — system health at a glance</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Backlog" value={backlog} sub="queued + scheduled" tone={backlog > 100 ? 'warn' : 'default'} />
        <StatCard label="In flight" value={active} sub="claimed + running" />
        <StatCard label="Completed (1h)" value={overview?.completed_last_hour ?? '—'} tone="good" />
        <StatCard label="Failed attempts (1h)" value={overview?.failed_attempts_last_hour ?? '—'}
          tone={(overview?.failed_attempts_last_hour ?? 0) > 0 ? 'warn' : 'default'} />
        <StatCard label="Dead letter" value={overview?.dead_letter_active ?? '—'}
          tone={(overview?.dead_letter_active ?? 0) > 0 ? 'bad' : 'default'} />
        <StatCard label="Workers online" value={overview?.workers_online ?? '—'}
          tone={(overview?.workers_online ?? 0) === 0 ? 'bad' : 'good'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-200">Throughput (30 min)</h2>
            <div className="text-xs text-slate-500">
              avg {overview?.avg_duration_ms_1h ? formatDuration(overview.avg_duration_ms_1h) : '—'} · p95{' '}
              {overview?.p95_duration_ms_1h ? formatDuration(overview.p95_duration_ms_1h) : '—'}
            </div>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="gComp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gFail" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1f2a42" strokeDasharray="3 3" />
                <XAxis dataKey="time" stroke="#475569" fontSize={11} tickLine={false} />
                <YAxis stroke="#475569" fontSize={11} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#161e30', border: '1px solid #2b3a5c', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Area type="monotone" dataKey="completed" stroke="#34d399" fill="url(#gComp)" strokeWidth={2} name="completed" />
                <Area type="monotone" dataKey="failed" stroke="#f87171" fill="url(#gFail)" strokeWidth={2} name="failed" />
                <Area type="monotone" dataKey="created" stroke="#818cf8" fill="none" strokeWidth={1.5} strokeDasharray="4 3" name="created" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-slate-200">Job statuses</h2>
          <div className="space-y-2">
            {(['running', 'queued', 'scheduled', 'completed', 'failed', 'dead_letter', 'cancelled'] as const).map((status) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <StatusBadge status={status} />
                <span className="font-mono text-slate-300">{counts[status] ?? 0}</span>
              </div>
            ))}
            {overview?.oldest_queued_age_seconds != null && overview.oldest_queued_age_seconds > 30 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Oldest queued job has waited {formatDuration(overview.oldest_queued_age_seconds * 1000)} — workers may be saturated.
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-slate-200">Queue depth</h2>
          {stats?.data.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="pb-2">Queue</th>
                  <th className="pb-2 text-right">Queued</th>
                  <th className="pb-2 text-right">Running</th>
                  <th className="pb-2 text-right">Success (24h)</th>
                </tr>
              </thead>
              <tbody>
                {stats.data.map((s) => {
                  const queue = queues?.data.find((q) => q.id === s.queue_id);
                  return (
                    <tr key={s.queue_id} className="border-t border-surface-800">
                      <td className="py-2 text-slate-300">
                        {queue?.name ?? s.queue_id.slice(0, 8)}
                        {queue?.is_paused && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">paused</span>}
                      </td>
                      <td className="py-2 text-right font-mono">{s.queued}</td>
                      <td className="py-2 text-right font-mono">{s.running + s.claimed}</td>
                      <td className="py-2 text-right font-mono">
                        {s.success_rate_24h == null ? '—' : `${Math.round(s.success_rate_24h * 100)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty message="No queues yet" />
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-slate-200">Workers</h2>
          {workers?.data.length ? (
            <div className="space-y-2">
              {workers.data.slice(0, 6).map((w) => (
                <div key={w.id} className="flex items-center justify-between rounded-lg bg-surface-800/60 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${
                      w.status === 'online' ? 'bg-emerald-400' : w.status === 'draining' ? 'bg-amber-400' : 'bg-red-400'
                    }`} />
                    <span className="font-mono text-xs text-slate-300">{w.name}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {w.running_jobs}/{w.concurrency} slots · hb {w.seconds_since_heartbeat}s ago
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty message="No workers registered — start one with: npm run dev:worker" />
          )}
        </Card>
      </div>
    </div>
  );
}
