import { useApp } from '../App';
import { useDocumentTitle, usePoll } from '../hooks';
import type { Paginated, WorkerView } from '../types';
import { Card, Empty, timeAgo } from '../ui';

const WORKER_TONE: Record<WorkerView['status'], string> = {
  online: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  draining: 'bg-amber-50 text-amber-700 ring-amber-200',
  offline: 'bg-slate-100 text-slate-500 ring-slate-200',
  dead: 'bg-red-50 text-red-700 ring-red-200',
};

export default function WorkersPage() {
  useDocumentTitle('Workers');
  const { liveTick } = useApp();
  const { data: workers } = usePoll<Paginated<WorkerView>>('/api/workers', 4000, liveTick);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Workers</h1>
        <p className="text-sm text-slate-500">
          Fleet liveness — a worker missing heartbeats past its lease is marked dead and its jobs are requeued automatically.
        </p>
      </div>

      <Card className="overflow-x-auto">
        {workers?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-300 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Worker</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Host / PID</th>
                <th className="px-3 py-3 text-right">Load</th>
                <th className="px-3 py-3">Last heartbeat</th>
                <th className="px-3 py-3">Started</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.map((w) => (
                <tr key={w.id} className="border-b border-surface-200 last:border-0 transition-colors hover:bg-surface-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{w.name}</div>
                    <div className="font-mono text-xs text-slate-500">{w.id.slice(0, 13)}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${WORKER_TONE[w.status]}`}>
                      {w.status}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500">{w.hostname} · {w.pid}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-200">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, (w.running_jobs / Math.max(1, w.concurrency)) * 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs text-slate-600">{w.running_jobs}/{w.concurrency}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-500">
                    {w.status === 'online' || w.status === 'draining' ? (
                      <span className={w.seconds_since_heartbeat > 15 ? 'text-amber-600' : ''}>
                        {w.seconds_since_heartbeat}s ago
                      </span>
                    ) : (
                      timeAgo(w.last_heartbeat_at)
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-500">{timeAgo(w.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No workers registered. Start one with: npm run dev:worker (scale by running it multiple times)." />
        )}
      </Card>
    </div>
  );
}
