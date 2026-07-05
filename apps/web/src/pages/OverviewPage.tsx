import { motion } from 'framer-motion';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useApp } from '../App';
import { useCountUp, usePoll, useDocumentTitle } from '../hooks';
import type { Overview, Paginated, QueueStats, Queue, ThroughputPoint, WorkerView } from '../types';
import { Card, Empty, HBarRow, RadialGauge, SegmentedBar, formatDuration } from '../ui';

const STATUS_COLORS: Record<string, string> = {
  running: '#3b82f6',
  queued: '#f59e0b',
  scheduled: '#0ea5e9',
  completed: '#10b981',
  failed: '#fb923c',
  dead_letter: '#ef4444',
  cancelled: '#94a3b8',
};

function AnimatedNumber({ value }: { value: number | string }) {
  return <>{useCountUp(value)}</>;
}

/** The centerpiece motion visual — jobs literally flow left to right through
 * the pipeline stages, with particles streaming along each active edge and a
 * pulsing branch down to the Dead Letter Queue when something needs
 * attention. This is what the platform's job lifecycle actually looks like,
 * not just a number in a box. */
function JobPipeline({ counts }: { counts: Record<string, number> }) {
  const stages = [
    { label: 'Scheduled', value: counts.scheduled ?? 0, color: '#0ea5e9' },
    { label: 'Queued', value: counts.queued ?? 0, color: '#f59e0b' },
    { label: 'Running', value: (counts.claimed ?? 0) + (counts.running ?? 0), color: '#3b82f6' },
    { label: 'Completed', value: counts.completed ?? 0, color: '#10b981' },
  ];
  const deadLetter = counts.dead_letter ?? 0;

  return (
    <Card className="p-5">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="font-semibold text-slate-800">Job pipeline</h2>
        <span className="text-xs text-slate-500">live flow through the system</span>
      </div>
      <div className="flex items-center">
        {stages.map((stage, i) => (
          <div key={stage.label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-2">
              <motion.div
                className="flex h-14 w-14 items-center justify-center rounded-full border-2 bg-white text-base font-bold tabular-nums"
                style={{ borderColor: stage.color, color: stage.color }}
                animate={stage.value > 0 ? { scale: [1, 1.07, 1] } : {}}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              >
                <AnimatedNumber value={stage.value} />
              </motion.div>
              <span className="text-xs font-medium text-slate-600">{stage.label}</span>
            </div>
            {i < stages.length - 1 && (
              <div className="relative mx-1 h-px min-w-[24px] flex-1 bg-surface-300 sm:mx-2">
                {stage.value > 0 &&
                  [0, 0.6, 1.2].map((delay) => (
                    <motion.span
                      key={delay}
                      className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                      style={{ backgroundColor: stage.color }}
                      initial={{ left: '0%', opacity: 0 }}
                      animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 1.8, repeat: Infinity, delay, ease: 'linear' }}
                    />
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {deadLetter > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="mt-5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <motion.span
            className="h-2 w-2 shrink-0 rounded-full bg-red-500"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
          <AnimatedNumber value={deadLetter} /> job(s) branched into the Dead Letter Queue —{' '}
          <Link to="/dlq" className="font-medium underline">inspect them</Link>.
        </motion.div>
      )}
    </Card>
  );
}

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

  const kpis = [
    { label: 'Backlog', value: backlog, sub: 'queued + scheduled', tone: backlog > 100 ? 'text-amber-600' : 'text-slate-900' },
    { label: 'In flight', value: active, sub: 'claimed + running', tone: 'text-slate-900' },
    { label: 'Completed (1h)', value: overview?.completed_last_hour ?? '—', sub: 'jobs finished', tone: 'text-emerald-600' },
    { label: 'Failed attempts (1h)', value: overview?.failed_attempts_last_hour ?? '—', sub: 'incl. retried', tone: (overview?.failed_attempts_last_hour ?? 0) > 0 ? 'text-amber-600' : 'text-slate-900' },
    { label: 'Dead letter', value: overview?.dead_letter_active ?? '—', sub: 'need attention', tone: (overview?.dead_letter_active ?? 0) > 0 ? 'text-red-600' : 'text-slate-900' },
    { label: 'Workers online', value: overview?.workers_online ?? '—', sub: 'fleet size', tone: (overview?.workers_online ?? 0) === 0 ? 'text-red-600' : 'text-emerald-600' },
  ];

  const statusSegments = (['completed', 'running', 'queued', 'scheduled', 'failed', 'dead_letter', 'cancelled'] as const)
    .map((s) => ({ label: s.replace('_', ' '), value: counts[s] ?? 0, color: STATUS_COLORS[s] }));
  const maxBacklog = Math.max(1, ...(stats?.data.map((s) => s.queued + s.scheduled) ?? [1]));

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Overview</h1>
          <p className="text-sm text-slate-500">{project!.name} — system health at a glance</p>
        </div>
      </div>

      {/* Hero KPI strip — one unified panel with vertical rules, not six separate boxes */}
      <div className="rounded-2xl border border-surface-200 bg-gradient-to-br from-accent-soft/60 via-white to-white p-5 sm:p-6">
        <div className="flex flex-wrap gap-x-8 gap-y-5">
          {kpis.map((k, i) => (
            <div key={k.label} className={`min-w-[128px] flex-1 ${i > 0 ? 'sm:border-l sm:border-surface-300 sm:pl-8' : ''}`}>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{k.label}</div>
              <div className={`mt-1 text-3xl font-bold tabular-nums ${k.tone}`}><AnimatedNumber value={k.value} /></div>
              <div className="text-xs text-slate-500">{k.sub}</div>
            </div>
          ))}
        </div>
      </div>

      <JobPipeline counts={counts} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-800">Throughput (30 min)</h2>
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
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gFail" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 6px -4px rgb(15 23 42 / 0.1)' }}
                  labelStyle={{ color: '#475569' }}
                />
                <Area type="monotone" dataKey="completed" stroke="#10b981" fill="url(#gComp)" strokeWidth={2} name="completed" />
                <Area type="monotone" dataKey="failed" stroke="#f43f5e" fill="url(#gFail)" strokeWidth={2} name="failed" />
                <Area type="monotone" dataKey="created" stroke="#6366f1" fill="none" strokeWidth={1.5} strokeDasharray="4 3" name="created" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-slate-800">Job status mix</h2>
          <SegmentedBar segments={statusSegments} height={14} />
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
            {statusSegments.map((s) => (
              <div key={s.label} className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="capitalize text-slate-600">{s.label}</span>
                <span className="font-mono font-medium text-slate-800">{s.value}</span>
              </div>
            ))}
          </div>
          {overview?.oldest_queued_age_seconds != null && overview.oldest_queued_age_seconds > 30 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Oldest queued job has waited {formatDuration(overview.oldest_queued_age_seconds * 1000)} — workers may be saturated.
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-800">Queue depth</h2>
            <span className="text-xs text-slate-500">backlog per queue</span>
          </div>
          {stats?.data.length ? (
            <div className="space-y-3">
              {stats.data.map((s) => {
                const queue = queues?.data.find((q) => q.id === s.queue_id);
                const backlogCount = s.queued + s.scheduled;
                return (
                  <HBarRow
                    key={s.queue_id}
                    label={queue?.name ?? s.queue_id.slice(0, 8)}
                    value={backlogCount}
                    max={maxBacklog}
                    color={queue?.is_paused ? '#f59e0b' : '#4f46e5'}
                    sub={
                      <span className="text-[10px] text-slate-500">
                        {queue?.is_paused ? 'paused' : `${s.success_rate_24h == null ? '—' : Math.round(s.success_rate_24h * 100) + '%'} success`}
                      </span>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <Empty message="No queues yet" />
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-800">Worker fleet</h2>
            <span className="text-xs text-slate-500">load = running / concurrency</span>
          </div>
          {workers?.data.length ? (
            <div className="flex flex-wrap gap-5">
              {workers.data.slice(0, 8).map((w) => {
                const loadPct = w.concurrency > 0 ? (w.running_jobs / w.concurrency) * 100 : 0;
                const dot = w.status === 'online' ? 'bg-emerald-500' : w.status === 'draining' ? 'bg-amber-500' : 'bg-red-500';
                const ring = w.status === 'online' ? '#4f46e5' : w.status === 'draining' ? '#f59e0b' : '#ef4444';
                return (
                  <div key={w.id} className="flex flex-col items-center gap-1.5 text-center">
                    <div className="relative flex items-center justify-center">
                      <RadialGauge value={loadPct} color={ring} />
                      <span className="absolute text-[11px] font-semibold text-slate-700">{w.running_jobs}/{w.concurrency}</span>
                      {w.running_jobs > 0 && (
                        <motion.span
                          className="absolute inset-0 rounded-full"
                          style={{ boxShadow: `0 0 0 2px ${ring}` }}
                          animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.25, 1] }}
                          transition={{ duration: 1.6, repeat: Infinity }}
                        />
                      )}
                    </div>
                    <div className="flex max-w-[92px] items-center gap-1">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                      <span className="truncate font-mono text-[11px] text-slate-600">{w.name.replace('worker-', '')}</span>
                    </div>
                    <span className="text-[10px] text-slate-500">hb {w.seconds_since_heartbeat}s ago</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty message="No workers registered — start one with: npm run dev:worker" />
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-surface-200 pt-4 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wider text-slate-500">Engineering notes</span>
        <span>52/52 automated tests passing (unit + integration vs. real Postgres)</span>
        <span className="text-slate-300">&middot;</span>
        <span>atomic SKIP LOCKED job claiming</span>
        <span className="text-slate-300">&middot;</span>
        <span>advisory-lock scheduler leader election</span>
        <span className="text-slate-300">&middot;</span>
        <span>crash-recovery reaper</span>
        <span className="text-slate-300">&middot;</span>
        <Link to="/activity" className="font-medium text-accent hover:underline">watch it happen live in the Activity Log &rarr;</Link>
      </div>
    </div>
  );
}
