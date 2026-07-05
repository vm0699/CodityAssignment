import { useState } from 'react';
import { Pause, Play, Plus, Settings2, Trash2 } from 'lucide-react';
import { del, patch, post } from '../api';
import { useApp } from '../App';
import { useConfirm } from '../confirm';
import { useDocumentTitle, usePoll } from '../hooks';
import { useToast } from '../toast';
import type { Queue, QueueStats, RetryPolicy } from '../types';
import { Button, Card, Empty, ErrorNote, Field, Modal, inputClass, formatDuration } from '../ui';

export default function QueuesPage() {
  useDocumentTitle('Queues');
  const { project, liveTick } = useApp();
  const pid = project!.id;
  const toast = useToast();
  const confirm = useConfirm();
  const { data: queues, refetch } = usePoll<{ data: Queue[] }>(`/api/projects/${pid}/queues`, 8000, liveTick);
  const { data: stats } = usePoll<{ data: QueueStats[] }>(`/api/projects/${pid}/queues/stats`, 5000, liveTick);
  const { data: policies, refetch: refetchPolicies } = usePoll<{ data: RetryPolicy[] }>(`/api/projects/${pid}/retry-policies`, 30_000);

  const [editing, setEditing] = useState<Queue | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingPolicy, setCreatingPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function togglePause(queue: Queue) {
    setError(null);
    try {
      await post(`/api/queues/${queue.id}/${queue.is_paused ? 'resume' : 'pause'}`);
      await refetch();
      toast.show('success', `Queue "${queue.name}" ${queue.is_paused ? 'resumed' : 'paused'}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(queue: Queue) {
    const ok = await confirm({
      title: `Delete "${queue.name}"?`,
      message: 'This permanently deletes the queue and ALL of its jobs. This cannot be undone.',
      confirmLabel: 'Delete queue',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/queues/${queue.id}`);
      await refetch();
      toast.show('success', `Queue "${queue.name}" deleted.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Queues</h1>
          <p className="text-sm text-slate-500">Configuration, health and controls</p>
        </div>
        <Button onClick={() => setCreating(true)}><span className="flex items-center gap-1.5"><Plus size={15} /> New queue</span></Button>
      </div>
      <ErrorNote message={error} />

      <Card className="overflow-x-auto">
        {queues?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-300 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Queue</th>
                <th className="px-3 py-3 text-right">Priority</th>
                <th className="px-3 py-3 text-right">Concurrency</th>
                <th className="px-3 py-3 text-right">Rate limit</th>
                <th className="px-3 py-3">Retry policy</th>
                <th className="px-3 py-3 text-right">Backlog</th>
                <th className="px-3 py-3 text-right">In flight</th>
                <th className="px-3 py-3 text-right">Avg (24h)</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queues.data.map((queue) => {
                const s = stats?.data.find((x) => x.queue_id === queue.id);
                const policy = policies?.data.find((p) => p.id === queue.retry_policy_id);
                return (
                  <tr key={queue.id} className="border-b border-surface-200 last:border-0 transition-colors hover:bg-surface-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">
                        {queue.name}
                        {queue.is_paused && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">paused</span>}
                      </div>
                      {queue.description && <div className="text-xs text-slate-500">{queue.description}</div>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{queue.priority}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{queue.max_concurrency}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{queue.rate_limit_per_second ? `${queue.rate_limit_per_second}/s` : '—'}</td>
                    <td className="px-3 py-3 text-slate-500">{policy ? policy.name : 'system default'}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{s ? s.queued + s.scheduled : '—'}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{s ? s.claimed + s.running : '—'}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-700">{s?.avg_duration_ms_24h ? formatDuration(s.avg_duration_ms_24h) : '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button title={queue.is_paused ? 'Resume' : 'Pause'} onClick={() => void togglePause(queue)}
                          className="rounded p-1.5 text-slate-500 hover:bg-surface-200 hover:text-slate-800">
                          {queue.is_paused ? <Play size={15} /> : <Pause size={15} />}
                        </button>
                        <button title="Configure" onClick={() => setEditing(queue)}
                          className="rounded p-1.5 text-slate-500 hover:bg-surface-200 hover:text-slate-800">
                          <Settings2 size={15} />
                        </button>
                        <button title="Delete" onClick={() => void remove(queue)}
                          className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty message="No queues yet — create one to start scheduling jobs." />
        )}
      </Card>

      {/* Retry policies */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800">Retry policies</h2>
          <p className="text-sm text-slate-500">Reusable backoff strategies queues can reference</p>
        </div>
        <Button variant="secondary" onClick={() => setCreatingPolicy(true)}>
          <span className="flex items-center gap-1.5"><Plus size={15} /> New policy</span>
        </Button>
      </div>
      <Card className="overflow-x-auto">
        {policies?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-300 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Name</th>
                <th className="px-3 py-3">Strategy</th>
                <th className="px-3 py-3 text-right">Max attempts</th>
                <th className="px-3 py-3 text-right">Base delay</th>
                <th className="px-3 py-3 text-right">Max delay</th>
                <th className="px-3 py-3 text-right">Jitter</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((p) => (
                <tr key={p.id} className="border-b border-surface-200 last:border-0 transition-colors hover:bg-surface-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{p.name}</td>
                  <td className="px-3 py-3"><span className="rounded bg-surface-200 px-2 py-0.5 text-xs text-slate-600">{p.strategy}</span></td>
                  <td className="px-3 py-3 text-right font-mono text-slate-700">{p.max_attempts}</td>
                  <td className="px-3 py-3 text-right font-mono text-slate-700">{formatDuration(p.base_delay_ms)}</td>
                  <td className="px-3 py-3 text-right font-mono text-slate-700">{formatDuration(p.max_delay_ms)}</td>
                  <td className="px-3 py-3 text-right font-mono text-slate-700">{Math.round(p.jitter_factor * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No retry policies — queues fall back to exponential ×3, 1s base, 60s cap." />
        )}
      </Card>

      {creating && (
        <QueueForm
          title="New queue"
          policies={policies?.data ?? []}
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            await post(`/api/projects/${pid}/queues`, body);
            await refetch();
            setCreating(false);
            toast.show('success', `Queue "${body.name}" created.`);
          }}
        />
      )}
      {editing && (
        <QueueForm
          title={`Configure "${editing.name}"`}
          initial={editing}
          policies={policies?.data ?? []}
          onClose={() => setEditing(null)}
          onSubmit={async (body) => {
            await patch(`/api/queues/${editing.id}`, body);
            await refetch();
            setEditing(null);
            toast.show('success', 'Queue configuration saved.');
          }}
        />
      )}
      {creatingPolicy && (
        <PolicyForm
          onClose={() => setCreatingPolicy(false)}
          onSubmit={async (body) => {
            await post(`/api/projects/${pid}/retry-policies`, body);
            await refetchPolicies();
            setCreatingPolicy(false);
            toast.show('success', `Retry policy "${body.name}" created.`);
          }}
        />
      )}
    </div>
  );
}

function QueueForm({ title, initial, policies, onClose, onSubmit }: {
  title: string;
  initial?: Queue;
  policies: RetryPolicy[];
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 0);
  const [maxConcurrency, setMaxConcurrency] = useState(initial?.max_concurrency ?? 10);
  const [retryPolicyId, setRetryPolicyId] = useState<string>(initial?.retry_policy_id ?? '');
  const [rateLimit, setRateLimit] = useState<string>(initial?.rate_limit_per_second?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name, description, priority, maxConcurrency,
        retryPolicyId: retryPolicyId || null,
        rateLimitPerSecond: rateLimit ? Number(rateLimit) : null,
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" hint="letters, digits, dot, dash, underscore">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description">
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority" hint="higher runs first">
            <input className={inputClass} type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </Field>
          <Field label="Max concurrency" hint="global cap across workers">
            <input className={inputClass} type="number" min={1} max={1000} value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Retry policy">
            <select className={inputClass} value={retryPolicyId} onChange={(e) => setRetryPolicyId(e.target.value)}>
              <option value="">system default</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Rate limit (jobs/sec)" hint="empty = unlimited">
            <input className={inputClass} type="number" min={1} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function PolicyForm({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<'fixed' | 'linear' | 'exponential'>('exponential');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [baseDelayMs, setBaseDelayMs] = useState(1000);
  const [maxDelayMs, setMaxDelayMs] = useState(60_000);
  const [jitter, setJitter] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name, strategy, maxAttempts, baseDelayMs, maxDelayMs, jitterFactor: jitter });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New retry policy" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Strategy">
            <select className={inputClass} value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
              <option value="fixed">fixed</option>
              <option value="linear">linear</option>
              <option value="exponential">exponential</option>
            </select>
          </Field>
          <Field label="Max attempts">
            <input className={inputClass} type="number" min={1} max={25} value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Base delay (ms)">
            <input className={inputClass} type="number" min={0} value={baseDelayMs}
              onChange={(e) => setBaseDelayMs(Number(e.target.value))} />
          </Field>
          <Field label="Max delay (ms)">
            <input className={inputClass} type="number" min={0} value={maxDelayMs}
              onChange={(e) => setMaxDelayMs(Number(e.target.value))} />
          </Field>
          <Field label="Jitter (0–1)">
            <input className={inputClass} type="number" min={0} max={1} step={0.1} value={jitter}
              onChange={(e) => setJitter(Number(e.target.value))} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
