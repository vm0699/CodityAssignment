import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, XCircle } from 'lucide-react';
import { post } from '../api';
import { useApp } from '../App';
import { useDocumentTitle, usePoll } from '../hooks';
import type { Job, JobDetail, JobLog, Paginated, Queue } from '../types';
import {
  Button, Card, Empty, ErrorNote, Field, Modal, StatusBadge, formatDuration, inputClass, shortId, timeAgo,
} from '../ui';

const STATUS_FILTERS = ['', 'queued', 'scheduled', 'running', 'claimed', 'completed', 'failed', 'dead_letter', 'cancelled'];

export default function JobsPage() {
  useDocumentTitle('Jobs');
  const { project, liveTick } = useApp();
  const pid = project!.id;

  const [status, setStatus] = useState('');
  const [queueId, setQueueId] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const limit = 20;

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) params.set('status', status);
    if (queueId) params.set('queueId', queueId);
    if (search.trim()) params.set('search', search.trim());
    return params.toString();
  }, [status, queueId, search, offset]);

  const { data: jobs, refetch } = usePoll<Paginated<Job>>(`/api/projects/${pid}/jobs?${query}`, 4000, liveTick);
  const { data: queues } = usePoll<{ data: Queue[] }>(`/api/projects/${pid}/queues`, 30_000);

  const total = jobs?.pagination.total ?? 0;
  const pageEnd = Math.min(offset + limit, total);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Job explorer</h1>
          <p className="text-sm text-slate-500">{total} job(s) matching filters</p>
        </div>
        <Button onClick={() => setCreating(true)}><span className="flex items-center gap-1.5"><Plus size={15} /> New job</span></Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputClass} !w-44`} value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{s === '' ? 'All statuses' : s.replace('_', ' ')}</option>
          ))}
        </select>
        <select className={`${inputClass} !w-44`} value={queueId} onChange={(e) => { setQueueId(e.target.value); setOffset(0); }}>
          <option value="">All queues</option>
          {queues?.data.map((q) => (
            <option key={q.id} value={q.id}>{q.name}</option>
          ))}
        </select>
        <input
          className={`${inputClass} !w-64`}
          placeholder="Search id prefix or type…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
        />
      </div>

      <Card>
        {jobs?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-700 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Job</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Queue</th>
                <th className="px-3 py-3 text-right">Priority</th>
                <th className="px-3 py-3 text-right">Attempt</th>
                <th className="px-3 py-3">Created</th>
                <th className="px-3 py-3">Runs / ran at</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((job) => (
                <tr
                  key={job.id}
                  className="cursor-pointer border-b border-surface-800 last:border-0 hover:bg-surface-800/50"
                  onClick={() => setSelected(job.id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-200">{job.type}</div>
                    <div className="font-mono text-xs text-slate-600">{shortId(job.id)}{job.batch_id ? ' · batch' : ''}{job.scheduled_job_id ? ' · cron' : ''}</div>
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={job.status} /></td>
                  <td className="px-3 py-2.5 text-slate-400">{job.queue_name}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{job.priority}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{job.attempt}{job.max_attempts ? `/${job.max_attempts}` : ''}</td>
                  <td className="px-3 py-2.5 text-slate-500">{timeAgo(job.created_at)}</td>
                  <td className="px-3 py-2.5 text-slate-500">
                    {job.status === 'scheduled' ? `due ${timeAgo(job.run_at)}` : timeAgo(job.started_at ?? job.claimed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No jobs match these filters." />
        )}
        {total > limit && (
          <div className="flex items-center justify-between border-t border-surface-700 px-4 py-2 text-sm text-slate-500">
            <span>{offset + 1}–{pageEnd} of {total}</span>
            <div className="flex gap-1">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}
                className="rounded p-1 hover:bg-surface-700 disabled:opacity-30"><ChevronLeft size={16} /></button>
              <button disabled={pageEnd >= total} onClick={() => setOffset(offset + limit)}
                className="rounded p-1 hover:bg-surface-700 disabled:opacity-30"><ChevronRight size={16} /></button>
            </div>
          </div>
        )}
      </Card>

      {selected && <JobDetailModal jobId={selected} onClose={() => setSelected(null)} onChanged={refetch} />}
      {creating && (
        <NewJobModal
          queues={queues?.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); void refetch(); }}
        />
      )}
    </div>
  );
}

function JobDetailModal({ jobId, onClose, onChanged }: { jobId: string; onClose: () => void; onChanged: () => void }) {
  const { liveTick } = useApp();
  const { data: job, refetch } = usePoll<JobDetail>(`/api/jobs/${jobId}`, 3000, liveTick);
  const { data: logs } = usePoll<{ data: JobLog[] }>(`/api/jobs/${jobId}/logs`, 3000, liveTick);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'retry' | 'cancel') {
    setError(null);
    try {
      await post(`/api/jobs/${jobId}/${action}`);
      await refetch();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!job) return null;
  const canCancel = ['scheduled', 'queued', 'claimed', 'running'].includes(job.status);
  const canRetry = ['failed', 'dead_letter', 'cancelled', 'scheduled'].includes(job.status);

  return (
    <Modal title={`${job.type} · ${shortId(job.id)}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={job.status} />
          <span className="text-slate-500">queue <span className="text-slate-300">{job.queue_name}</span></span>
          <span className="text-slate-500">attempt <span className="font-mono text-slate-300">{job.attempt}{job.max_attempts ? `/${job.max_attempts}` : ''}</span></span>
          <span className="text-slate-500">priority <span className="font-mono text-slate-300">{job.priority}</span></span>
          <span className="text-slate-500">timeout <span className="font-mono text-slate-300">{formatDuration(job.timeout_ms)}</span></span>
          <div className="ml-auto flex gap-2">
            {canRetry && (
              <Button variant="secondary" onClick={() => void act('retry')}>
                <span className="flex items-center gap-1"><RefreshCw size={13} /> Retry now</span>
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" onClick={() => void act('cancel')}>
                <span className="flex items-center gap-1"><XCircle size={13} /> Cancel</span>
              </Button>
            )}
          </div>
        </div>
        <ErrorNote message={error} />

        {job.failure_summary && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-red-400">Failure summary</div>
            <p className="text-red-200">{job.failure_summary}</p>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Payload</h4>
            <pre className="max-h-40 overflow-auto rounded-lg bg-surface-950 p-3 font-mono text-xs text-slate-300">
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Output</h4>
            <pre className="max-h-40 overflow-auto rounded-lg bg-surface-950 p-3 font-mono text-xs text-slate-300">
              {job.output ? JSON.stringify(job.output, null, 2) : '—'}
            </pre>
          </div>
        </div>

        {(job.dependencies.dependsOn.length > 0 || job.dependencies.dependents.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Depends on</h4>
              {job.dependencies.dependsOn.map((d) => (
                <div key={d.id} className="mb-1 flex items-center gap-2 text-xs">
                  <StatusBadge status={d.status} /> <span className="text-slate-300">{d.type}</span>
                  <span className="font-mono text-slate-600">{shortId(d.id)}</span>
                </div>
              ))}
              {job.dependencies.dependsOn.length === 0 && <div className="text-xs text-slate-600">none</div>}
            </div>
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Unblocks</h4>
              {job.dependencies.dependents.map((d) => (
                <div key={d.id} className="mb-1 flex items-center gap-2 text-xs">
                  <StatusBadge status={d.status} /> <span className="text-slate-300">{d.type}</span>
                  <span className="font-mono text-slate-600">{shortId(d.id)}</span>
                </div>
              ))}
              {job.dependencies.dependents.length === 0 && <div className="text-xs text-slate-600">none</div>}
            </div>
          </div>
        )}

        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Executions (retry history)</h4>
          {job.executions.length ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-3">Attempt</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Worker</th>
                  <th className="py-1 pr-3">Started</th>
                  <th className="py-1 pr-3">Duration</th>
                  <th className="py-1">Error</th>
                </tr>
              </thead>
              <tbody>
                {job.executions.map((e) => (
                  <tr key={e.id} className="border-t border-surface-800">
                    <td className="py-1.5 pr-3 font-mono">{e.attempt}</td>
                    <td className="py-1.5 pr-3"><StatusBadge status={e.status} /></td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500">{e.worker_id ? shortId(e.worker_id) : '—'}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{timeAgo(e.started_at)}</td>
                    <td className="py-1.5 pr-3 font-mono">{e.duration_ms != null ? formatDuration(e.duration_ms) : '—'}</td>
                    <td className="max-w-[220px] truncate py-1.5 text-red-300/80" title={e.error ?? ''}>{e.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-xs text-slate-600">not executed yet</div>
          )}
        </div>

        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Logs</h4>
          <div className="max-h-56 overflow-auto rounded-lg bg-surface-950 p-3 font-mono text-xs">
            {logs?.data.length ? (
              logs.data.map((l) => (
                <div key={l.id} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-slate-600">{new Date(l.created_at).toLocaleTimeString()}</span>
                  <span className={`shrink-0 uppercase ${
                    l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : 'text-sky-400'
                  }`}>{l.level}</span>
                  <span className="text-slate-300">{l.message}</span>
                </div>
              ))
            ) : (
              <span className="text-slate-600">no log lines yet</span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function NewJobModal({ queues, onClose, onCreated }: { queues: Queue[]; onClose: () => void; onCreated: () => void }) {
  const [queueId, setQueueId] = useState(queues[0]?.id ?? '');
  const [type, setType] = useState('demo.compute');
  const [payload, setPayload] = useState('{\n  "iterations": 25\n}');
  const [priority, setPriority] = useState(0);
  const [delayMs, setDelayMs] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState('');
  const [count, setCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = payload.trim() ? JSON.parse(payload) : {};
      const base = {
        type, payload: parsed, priority,
        ...(delayMs > 0 ? { delayMs } : {}),
        ...(maxAttempts ? { maxAttempts: Number(maxAttempts) } : {}),
      };
      if (count > 1) {
        await post(`/api/queues/${queueId}/jobs/batch`, { jobs: Array.from({ length: count }, () => ({ ...base })) });
      } else {
        await post(`/api/queues/${queueId}/jobs`, base);
      }
      onCreated();
    } catch (err) {
      setError(err instanceof SyntaxError ? `Payload is not valid JSON: ${err.message}` : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New job" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Queue">
            <select className={inputClass} value={queueId} onChange={(e) => setQueueId(e.target.value)} required>
              {queues.map((q) => (
                <option key={q.id} value={q.id}>{q.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Type" hint="demo.compute, demo.sleep, demo.flaky, demo.fail, email.send, http.request">
            <input className={inputClass} value={type} onChange={(e) => setType(e.target.value)} required list="job-types" />
            <datalist id="job-types">
              {['demo.compute', 'demo.sleep', 'demo.flaky', 'demo.fail', 'email.send', 'http.request'].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Payload (JSON)">
          <textarea className={`${inputClass} h-24 font-mono`} value={payload} onChange={(e) => setPayload(e.target.value)} />
        </Field>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Priority">
            <input className={inputClass} type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </Field>
          <Field label="Delay (ms)">
            <input className={inputClass} type="number" min={0} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} />
          </Field>
          <Field label="Max attempts">
            <input className={inputClass} type="number" min={1} max={25} value={maxAttempts} placeholder="policy"
              onChange={(e) => setMaxAttempts(e.target.value)} />
          </Field>
          <Field label="Count" hint=">1 = batch">
            <input className={inputClass} type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !queueId}>{busy ? 'Submitting…' : count > 1 ? `Submit batch of ${count}` : 'Submit job'}</Button>
        </div>
      </form>
    </Modal>
  );
}
