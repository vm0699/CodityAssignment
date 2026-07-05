/** Small shared UI primitives: badges, cards, buttons, modal, empty states. */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { JobStatus } from './types';

export const STATUS_STYLES: Record<JobStatus, string> = {
  scheduled: 'bg-sky-50 text-sky-700 ring-sky-200',
  queued: 'bg-amber-50 text-amber-700 ring-amber-200',
  claimed: 'bg-violet-50 text-violet-700 ring-violet-200',
  running: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-orange-50 text-orange-700 ring-orange-200',
  dead_letter: 'bg-red-50 text-red-700 ring-red-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-slate-200',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status as JobStatus] ?? 'bg-slate-100 text-slate-600 ring-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>
      {status === 'running' && <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />}
      {status.replace('_', ' ')}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-surface-300 bg-surface-100 shadow-card ${className}`}>{children}</div>;
}

export function StatCard({ label, value, sub, tone = 'default' }: {
  label: string; value: ReactNode; sub?: string; tone?: 'default' | 'good' | 'bad' | 'warn';
}) {
  const toneClass = { default: 'text-slate-900', good: 'text-emerald-600', bad: 'text-red-600', warn: 'text-amber-600' }[tone];
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

export function Button({ children, onClick, variant = 'primary', disabled, type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    primary: 'bg-accent hover:bg-accent-hover text-white shadow-sm',
    secondary: 'bg-white hover:bg-surface-200 text-slate-700 border border-surface-300',
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
    ghost: 'hover:bg-surface-200 text-slate-500 hover:text-slate-800',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 pt-16 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl border border-surface-300 bg-surface-100 shadow-popover`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-300 px-5 py-3">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-surface-200 hover:text-slate-700">
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
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-surface-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15';

export function Empty({ message }: { message: string }) {
  return <div className="py-12 text-center text-sm text-slate-400">{message}</div>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>;
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
