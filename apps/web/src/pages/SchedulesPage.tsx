import { useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { del, patch, post } from '../api';
import { useApp } from '../App';
import { useConfirm } from '../confirm';
import { useDocumentTitle, usePoll } from '../hooks';
import { useToast } from '../toast';
import type { Queue, Schedule } from '../types';
import { Button, Card, Empty, ErrorNote, Field, Modal, inputClass, timeAgo } from '../ui';

export default function SchedulesPage() {
  useDocumentTitle('Schedules');
  const { project, liveTick } = useApp();
  const pid = project!.id;
  const toast = useToast();
  const confirm = useConfirm();
  const { data: schedules, refetch } = usePoll<{ data: Schedule[] }>(`/api/projects/${pid}/schedules`, 5000, liveTick);
  const { data: queues } = usePoll<{ data: Queue[] }>(`/api/projects/${pid}/queues`, 30_000);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(schedule: Schedule) {
    setError(null);
    try {
      await patch(`/api/schedules/${schedule.id}`, { status: schedule.status === 'active' ? 'paused' : 'active' });
      await refetch();
      toast.show('success', `Schedule "${schedule.name}" ${schedule.status === 'active' ? 'paused' : 'resumed'}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(schedule: Schedule) {
    const ok = await confirm({
      title: `Delete "${schedule.name}"?`,
      message: 'Already-created jobs from this schedule are kept; only future firings stop.',
      confirmLabel: 'Delete schedule',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/schedules/${schedule.id}`);
      await refetch();
      toast.show('success', `Schedule "${schedule.name}" deleted.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Recurring schedules</h1>
          <p className="text-sm text-slate-500">Cron definitions materialised into jobs by the scheduler service</p>
        </div>
        <Button onClick={() => setCreating(true)}><span className="flex items-center gap-1.5"><Plus size={15} /> New schedule</span></Button>
      </div>
      <ErrorNote message={error} />

      <Card className="overflow-x-auto">
        {schedules?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-300 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Schedule</th>
                <th className="px-3 py-3">Cron</th>
                <th className="px-3 py-3">Queue / type</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Next run</th>
                <th className="px-3 py-3">Last fired</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((s) => {
                const queue = queues?.data.find((q) => q.id === s.queue_id);
                return (
                  <tr key={s.id} className="border-b border-surface-200 last:border-0 transition-colors hover:bg-surface-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{s.name}</td>
                    <td className="px-3 py-3">
                      <code className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-xs text-sky-700">{s.cron_expression}</code>
                      <div className="mt-0.5 text-xs text-slate-500">{s.cron_description !== s.cron_expression ? s.cron_description : ''} {s.timezone !== 'UTC' ? `(${s.timezone})` : ''}</div>
                    </td>
                    <td className="px-3 py-3 text-slate-500">{queue?.name ?? '—'} · {s.job_type}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                        s.status === 'active'
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                          : 'bg-amber-50 text-amber-700 ring-amber-200'
                      }`}>{s.status}</span>
                    </td>
                    <td className="px-3 py-3 text-slate-500">{s.status === 'active' ? timeAgo(s.next_run_at) : '—'}</td>
                    <td className="px-3 py-3 text-slate-500">{timeAgo(s.last_enqueued_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button title={s.status === 'active' ? 'Pause' : 'Resume'} onClick={() => void toggle(s)}
                          className="rounded p-1.5 text-slate-500 hover:bg-surface-200 hover:text-slate-800">
                          {s.status === 'active' ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                        <button title="Delete" onClick={() => void remove(s)}
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
          <Empty message="No recurring schedules yet." />
        )}
      </Card>

      {creating && (
        <ScheduleForm
          queues={queues?.data ?? []}
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            await post(`/api/projects/${pid}/schedules`, body);
            await refetch();
            setCreating(false);
            toast.show('success', `Schedule "${body.name}" created.`);
          }}
        />
      )}
    </div>
  );
}

function ScheduleForm({ queues, onClose, onSubmit }: {
  queues: Queue[]; onClose: () => void; onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [queueId, setQueueId] = useState(queues[0]?.id ?? '');
  const [cron, setCron] = useState('*/5 * * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [jobType, setJobType] = useState('demo.compute');
  const [payload, setPayload] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name, queueId, cronExpression: cron, timezone, jobType,
        payload: payload.trim() ? JSON.parse(payload) : {},
      });
    } catch (err) {
      setError(err instanceof SyntaxError ? `Payload is not valid JSON: ${err.message}` : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New recurring schedule" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Queue">
            <select className={inputClass} value={queueId} onChange={(e) => setQueueId(e.target.value)} required>
              {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cron expression" hint="e.g. */5 * * * * — every 5 minutes">
            <input className={`${inputClass} font-mono`} value={cron} onChange={(e) => setCron(e.target.value)} required />
          </Field>
          <Field label="Timezone">
            <input className={inputClass} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
        </div>
        <Field label="Job type">
          <input className={inputClass} value={jobType} onChange={(e) => setJobType(e.target.value)} required />
        </Field>
        <Field label="Payload (JSON)">
          <textarea className={`${inputClass} h-20 font-mono`} value={payload} onChange={(e) => setPayload(e.target.value)} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !queueId}>{busy ? 'Creating…' : 'Create schedule'}</Button>
        </div>
      </form>
    </Modal>
  );
}
