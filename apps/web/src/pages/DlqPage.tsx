import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { del, post } from '../api';
import { useApp } from '../App';
import { useConfirm } from '../confirm';
import { useDocumentTitle, usePoll } from '../hooks';
import { useToast } from '../toast';
import type { DlqEntry, Paginated } from '../types';
import { Button, Card, Empty, ErrorNote, Modal, shortId, timeAgo } from '../ui';

export default function DlqPage() {
  useDocumentTitle('Dead Letter Queue');
  const { project, liveTick } = useApp();
  const pid = project!.id;
  const toast = useToast();
  const confirm = useConfirm();
  const [includeRequeued, setIncludeRequeued] = useState(false);
  const { data: entries, refetch } = usePoll<Paginated<DlqEntry>>(
    `/api/projects/${pid}/dlq?limit=50&includeRequeued=${includeRequeued}`, 5000, liveTick);
  const [inspecting, setInspecting] = useState<DlqEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function requeue(entry: DlqEntry) {
    setError(null);
    try {
      await post(`/api/dlq/${entry.id}/requeue`);
      await refetch();
      setInspecting(null);
      toast.show('success', `Job requeued from the Dead Letter Queue.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function purge(entry: DlqEntry) {
    const ok = await confirm({
      title: 'Purge this job permanently?',
      message: `This deletes the "${entry.job_type}" job and its entire execution history. This cannot be undone.`,
      confirmLabel: 'Purge permanently',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await del(`/api/dlq/${entry.id}`);
      await refetch();
      setInspecting(null);
      toast.show('success', 'Job purged permanently.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dead Letter Queue</h1>
          <p className="text-sm text-slate-500">Jobs that exhausted every retry — inspect, requeue, or purge</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-500">
          <input type="checkbox" checked={includeRequeued} onChange={(e) => setIncludeRequeued(e.target.checked)}
            className="rounded border-surface-400 text-accent focus:ring-accent/30" />
          Show requeued history
        </label>
      </div>
      <ErrorNote message={error} />

      <Card className="overflow-x-auto">
        {entries?.data.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-300 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Job</th>
                <th className="px-3 py-3">Queue</th>
                <th className="px-3 py-3 text-right">Attempts</th>
                <th className="px-3 py-3">Moved</th>
                <th className="px-3 py-3">Error</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.data.map((entry) => (
                <tr key={entry.id}
                  className="cursor-pointer border-b border-surface-200 last:border-0 transition-colors hover:bg-surface-50"
                  onClick={() => setInspecting(entry)}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{entry.job_type}</div>
                    <div className="font-mono text-xs text-slate-500">{shortId(entry.job_id)}</div>
                  </td>
                  <td className="px-3 py-3 text-slate-500">{entry.queue_name}</td>
                  <td className="px-3 py-3 text-right font-mono text-slate-700">{entry.attempts_made}</td>
                  <td className="px-3 py-3 text-slate-500">
                    {timeAgo(entry.moved_at)}
                    {entry.requeued_at && <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">requeued</span>}
                  </td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-red-600" title={entry.error ?? ''}>{entry.error}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {!entry.requeued_at && (
                      <div className="flex justify-end gap-1">
                        <button title="Requeue" onClick={() => void requeue(entry)}
                          className="rounded p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600">
                          <RefreshCw size={15} />
                        </button>
                        <button title="Purge" onClick={() => void purge(entry)}
                          className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="Dead letter queue is empty — that's a good thing." />
        )}
      </Card>

      {inspecting && (
        <Modal title={`Dead letter · ${inspecting.job_type}`} onClose={() => setInspecting(null)} wide>
          <div className="space-y-4 text-sm">
            <div className="text-slate-500">{inspecting.reason} · moved {timeAgo(inspecting.moved_at)}</div>
            {inspecting.failure_summary && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-red-500">Failure summary</div>
                <p className="text-red-700">{inspecting.failure_summary}</p>
              </div>
            )}
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Last error</h4>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-surface-200 bg-surface-50 p-3 font-mono text-xs text-red-600">
                {inspecting.error ?? '—'}
              </pre>
            </div>
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Payload snapshot</h4>
              <pre className="max-h-40 overflow-auto rounded-lg border border-surface-200 bg-surface-50 p-3 font-mono text-xs text-slate-700">
                {JSON.stringify(inspecting.payload_snapshot, null, 2)}
              </pre>
            </div>
            {!inspecting.requeued_at && (
              <div className="flex justify-end gap-2">
                <Button variant="danger" onClick={() => void purge(inspecting)}>Purge permanently</Button>
                <Button onClick={() => void requeue(inspecting)}>Requeue job</Button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
