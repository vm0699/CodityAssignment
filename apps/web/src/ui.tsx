/** Small shared UI primitives: badges, cards, buttons, modal, empty states. */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { JobStatus } from './types';

export const STATUS_STYLES: Record<JobStatus, string> = {
  scheduled: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  queued: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  claimed: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  running: 'bg-blue-500/15 text-blue-300 ring-blue-500/30',
  completed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  failed: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  dead_letter: 'bg-red-500/15 text-red-300 ring-red-500/30',
  cancelled: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status as JobStatus] ?? 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>
      {status === 'running' && <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />}
      {status.replace('_', ' ')}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-surface-700 bg-surface-900 ${className}`}>{children}</div>;
}

export function StatCard({ label, value, sub, tone = 'default' }: {
  label: string; value: ReactNode; sub?: string; tone?: 'default' | 'good' | 'bad' | 'warn';
}) {
  const toneClass = { default: 'text-slate-100', good: 'text-emerald-400', bad: 'text-red-400', warn: 'text-amber-400' }[tone];
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

export function Button({ children, onClick, variant = 'primary', disabled, type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    primary: 'bg-accent hover:bg-accent-hover text-white',
    secondary: 'bg-surface-700 hover:bg-surface-600 text-slate-200',
    danger: 'bg-red-600/80 hover:bg-red-600 text-white',
    ghost: 'hover:bg-surface-800 text-slate-400 hover:text-slate-200',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl border border-surface-600 bg-surface-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-5 py-3">
          <h3 className="font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-surface-700 hover:text-slate-200">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-600">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-surface-600 bg-surface-800 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-accent';

export function Empty({ message }: { message: string }) {
  return <div className="py-12 text-center text-sm text-slate-500">{message}</div>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{message}</div>;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return `in ${formatDuration(-seconds * 1000)}`;
  if (seconds < 5) return 'just now';
  return `${formatDuration(seconds * 1000)} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
