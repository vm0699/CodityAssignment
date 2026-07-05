/** Small shared UI primitives: badges, cards, buttons, modal, empty states. */
import { motion } from 'framer-motion';
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
    primary: 'bg-accent hover:bg-accent-hover text-white shadow-sm',
    secondary: 'bg-white hover:bg-surface-200 text-slate-700 border border-surface-300',
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
    ghost: 'hover:bg-surface-200 text-slate-500 hover:text-slate-800',
  }[variant];
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={{ duration: 0.12 }}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 pt-16 backdrop-blur-[2px]"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      onClick={onClose}
    >
      <motion.div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl border border-surface-300 bg-surface-100 shadow-popover`}
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 450, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-300 px-5 py-3">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-surface-200 hover:text-slate-700">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </motion.div>
    </motion.div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-surface-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15';

export function Empty({ message }: { message: string }) {
  return <div className="py-12 text-center text-sm text-slate-500">{message}</div>;
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

/** Circular progress ring — e.g. a worker's load (running / concurrency). */
export function RadialGauge({ value, size = 48, strokeWidth = 5, color = '#4f46e5', trackColor = '#e2e8f0' }: {
  value: number; size?: number; strokeWidth?: number; color?: string; trackColor?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, value));
  const offset = circumference - (clamped / 100) * circumference;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

/** Single proportional bar split into colored segments — an alternative to a list of badges+counts. */
export function SegmentedBar({ segments, height = 10 }: {
  segments: Array<{ label: string; value: number; color: string }>; height?: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="flex w-full overflow-hidden rounded-full bg-surface-200" style={{ height }}>
      {total > 0
        ? segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.label}
                title={`${s.label}: ${s.value}`}
                style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
                className="transition-all duration-500 first:rounded-l-full last:rounded-r-full"
              />
            ))
        : null}
    </div>
  );
}

/**
 * A traveling ECG-style pulse line — the literal namesake motif. Used next to
 * "live" indicators so liveness is *shown* moving, not just stated in text.
 * The faint full path is the "trace"; the bright animated segment is the
 * pulse sweeping through it, on an infinite loop.
 */
export function HeartbeatLine({ width = 88, height = 24, color = '#10b981', className = '' }: {
  width?: number; height?: number; color?: string; className?: string;
}) {
  const path = 'M0,12 H22 L28,4 L34,20 L40,2 L46,12 H88';
  return (
    <svg width={width} height={height} viewBox="0 0 88 24" fill="none" className={className}>
      <path d={path} stroke={color} strokeOpacity={0.18} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <motion.path
        d={path}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="18 200"
        animate={{ strokeDashoffset: [0, -218] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
      />
    </svg>
  );
}

/** One row of a horizontal bar-list comparison (e.g. queue backlog side by side). */
export function HBarRow({ label, value, max, color = '#4f46e5', valueLabel, sub }: {
  label: string; value: number; max: number; color?: string; valueLabel?: string; sub?: ReactNode;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 shrink-0">
        <div className="truncate text-sm font-medium text-slate-700">{label}</div>
        {sub}
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-200">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="w-12 shrink-0 text-right font-mono text-sm text-slate-700">{valueLabel ?? value}</div>
    </div>
  );
}
