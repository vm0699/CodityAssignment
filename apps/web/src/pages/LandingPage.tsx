import { motion } from 'framer-motion';
import {
  ArrowRight, CalendarClock, Cpu, GitBranch, Layers, Lock, Radio, RefreshCw, ShieldCheck, Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, HeartbeatLine } from '../ui';

const STAGE_COLORS = ['#0ea5e9', '#f59e0b', '#3b82f6', '#10b981'];
const STAGE_LABELS = ['Scheduled', 'Queued', 'Running', 'Completed'];

/**
 * A self-contained, illustrative version of the real Overview job pipeline —
 * fake numbers that gently drift on a loop, purely to show what the product
 * actually looks like in motion before anyone signs in. Not wired to any API.
 */
function HeroPipelinePreview() {
  const [counts, setCounts] = useState([2, 4, 3, 128]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCounts(([scheduled, queued, running, completed]) => {
        const moved = Math.random() > 0.5 && queued > 0;
        return [
          Math.max(0, scheduled + (Math.random() > 0.6 ? 1 : -1)),
          Math.max(1, queued + (moved ? -1 : 1)),
          Math.max(0, running + (moved ? 1 : 0) - (Math.random() > 0.7 ? 1 : 0)),
          completed + (Math.random() > 0.5 ? 1 : 0),
        ];
      });
    }, 1400);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="rounded-2xl border border-surface-200 bg-white p-5 shadow-popover sm:p-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <HeartbeatLine width={40} height={14} color="#10b981" />
          live preview
        </div>
      </div>
      <div className="flex items-center">
        {STAGE_LABELS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-2">
              <motion.div
                className="flex h-12 w-12 items-center justify-center rounded-full border-2 bg-white text-sm font-bold tabular-nums sm:h-14 sm:w-14 sm:text-base"
                style={{ borderColor: STAGE_COLORS[i], color: STAGE_COLORS[i] }}
                animate={{ scale: [1, 1.06, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.2 }}
              >
                {counts[i]}
              </motion.div>
              <span className="text-[10px] font-medium text-slate-500 sm:text-xs">{label}</span>
            </div>
            {i < STAGE_LABELS.length - 1 && (
              <div className="relative mx-1 h-px min-w-[16px] flex-1 bg-surface-300 sm:mx-2">
                {[0, 0.6, 1.2].map((delay) => (
                  <motion.span
                    key={delay}
                    className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                    style={{ backgroundColor: STAGE_COLORS[i] }}
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
    </div>
  );
}

const FEATURES = [
  {
    icon: Lock,
    title: 'Atomic job claiming',
    body: '`FOR UPDATE SKIP LOCKED` guarantees no job is ever claimed by two workers — even under heavy contention across a whole fleet.',
  },
  {
    icon: RefreshCw,
    title: 'Smart retries & Dead Letter Queue',
    body: 'Fixed, linear, or exponential backoff with jitter. Jobs that exhaust every attempt land safely in a DLQ you can inspect and requeue.',
  },
  {
    icon: CalendarClock,
    title: 'Cron & workflow dependencies',
    body: 'Recurring schedules and multi-step job DAGs, materialized by a leader-elected scheduler with automatic failover.',
  },
  {
    icon: Radio,
    title: 'Live, everything',
    body: 'A WebSocket-powered dashboard: queue depth, worker load, throughput charts, and a live feed of the system’s own internals.',
  },
  {
    icon: Cpu,
    title: 'Worker fleet management',
    body: 'Scale horizontally by starting more workers. Heartbeat-based liveness and a crash-recovery reaper requeue orphaned jobs automatically.',
  },
  {
    icon: ShieldCheck,
    title: 'Role-based access control',
    body: 'Owner, admin, member, and viewer roles scoped per organization, enforced on every single endpoint — not just the UI.',
  },
];

const HOW_IT_WORKS = [
  { icon: Layers, title: 'Create', body: 'Submit a job — immediate, delayed, scheduled, recurring, or as a batch — through the REST API or the dashboard.' },
  { icon: GitBranch, title: 'Queue', body: 'It lands in a priority queue with its own concurrency limit, rate limit, and retry policy.' },
  { icon: Lock, title: 'Claim', body: 'A worker atomically claims it the instant a slot is free — Postgres NOTIFY wakes workers in milliseconds.' },
  { icon: RefreshCw, title: 'Complete or retry', body: 'Success finishes the job. Failure backs off and retries automatically, or moves to the DLQ after the last attempt.' },
];

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.5, ease: 'easeOut' },
} as const;

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen overflow-x-hidden bg-surface-50 text-slate-800">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-surface-200/80 bg-surface-50/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Zap size={22} className="text-accent" />
            <span className="text-lg font-bold tracking-tight text-slate-900">Pulse</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
            <a href="#features" className="hover:text-slate-900">Features</a>
            <a href="#how-it-works" className="hover:text-slate-900">How it works</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('/login')}>Sign in</Button>
            <Button onClick={() => navigate('/login?mode=register')}>Get started</Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 left-1/4 h-96 w-96 rounded-full bg-accent-soft opacity-60 blur-3xl" />
          <div className="absolute top-40 right-1/4 h-72 w-72 rounded-full bg-emerald-100 opacity-60 blur-3xl" />
        </div>
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-2 lg:items-center lg:py-28">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-surface-300 bg-white px-3 py-1 text-xs font-medium text-slate-600">
              <Zap size={12} className="text-accent" /> Production-inspired distributed job scheduler
            </div>
            <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
              Background jobs that <span className="text-accent">never get lost.</span>
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-600">
              Pulse claims jobs atomically across a worker fleet, retries failures with backoff,
              and shows you everything live — queues, workers, throughput, and the system's own
              heartbeat. Built on PostgreSQL alone, no broker required.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button className="!px-5 !py-2.5 !text-base" onClick={() => navigate('/login?mode=register')}>
                <span className="flex items-center gap-1.5">Get started free <ArrowRight size={16} /></span>
              </Button>
              <Button variant="secondary" className="!px-5 !py-2.5 !text-base" onClick={() => navigate('/login')}>
                Sign in
              </Button>
            </div>
            <p className="mt-4 text-xs text-slate-400">
              New here? Registering auto-provisions a populated demo workspace — queues, jobs, retries, all real.
            </p>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, delay: 0.1 }}>
            <HeroPipelinePreview />
          </motion.div>
        </div>

        {/* Trust band */}
        <motion.div {...fadeUp} className="border-y border-surface-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-5 text-xs font-medium text-slate-500 sm:px-6">
            <span>Atomic SKIP LOCKED claiming</span>
            <span className="text-slate-300">&middot;</span>
            <span>Zero message broker</span>
            <span className="text-slate-300">&middot;</span>
            <span>Real-time WebSocket updates</span>
            <span className="text-slate-300">&middot;</span>
            <span>Advisory-lock leader election</span>
            <span className="text-slate-300">&middot;</span>
            <span>52/52 automated tests passing</span>
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <motion.div {...fadeUp} className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">Everything a real job queue needs</h2>
          <p className="mt-3 text-slate-600">Not a toy — the concurrency, reliability, and observability details that matter in production.</p>
        </motion.div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: i * 0.05 }}
              className="rounded-xl border border-surface-200 bg-white p-5 transition-shadow hover:shadow-card"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <f.icon size={19} />
              </div>
              <h3 className="font-semibold text-slate-900">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-y border-surface-200 bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <motion.div {...fadeUp} className="mx-auto mb-12 max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900">From submission to completion</h2>
            <p className="mt-3 text-slate-600">The same four steps every job takes, whether it's the first one or the millionth.</p>
          </motion.div>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {HOW_IT_WORKS.map((step, i) => (
              <motion.div key={step.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.08 }} className="relative">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border-2 border-accent text-accent">
                  <step.icon size={18} />
                </div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Step {i + 1}</div>
                <h3 className="font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{step.body}</p>
                {i < HOW_IT_WORKS.length - 1 && (
                  <div className="absolute right-[-1rem] top-5 hidden text-slate-300 lg:block">
                    <ArrowRight size={18} />
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Engineering credibility panel */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <motion.div {...fadeUp}>
            <h2 className="text-3xl font-bold tracking-tight text-slate-900">Built the way it actually has to work</h2>
            <p className="mt-4 leading-relaxed text-slate-600">
              The claim query is the whole game in a job scheduler. Pulse serializes claim decisions with
              an advisory lock and locks candidate rows with <code className="rounded bg-surface-200 px-1.5 py-0.5 text-sm text-slate-700">SKIP LOCKED</code>,
              so two workers can race for the same batch and never double-claim a single job — proven by
              a concurrency test that hammers it with parallel claimers.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-slate-600">
              <li className="flex items-center gap-2"><ArrowRight size={14} className="shrink-0 text-accent" /> Exactly-once claiming, at-least-once execution</li>
              <li className="flex items-center gap-2"><ArrowRight size={14} className="shrink-0 text-accent" /> Crash recovery via heartbeat lease + reaper</li>
              <li className="flex items-center gap-2"><ArrowRight size={14} className="shrink-0 text-accent" /> Leader-elected scheduler, automatic failover</li>
            </ul>
          </motion.div>
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-popover">
              <div className="flex items-center gap-1.5 border-b border-slate-800 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                <span className="ml-2 text-xs text-slate-500">claim_jobs.sql</span>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-slate-300">
{`WITH runnable AS (
  SELECT j.id,
    row_number() OVER (
      PARTITION BY j.queue_id
      ORDER BY j.priority DESC, j.run_at ASC
    ) AS rn
  FROM jobs j
  WHERE j.status = 'queued' AND j.run_at <= now()
),
locked AS (
  SELECT id FROM jobs
  WHERE id IN (SELECT id FROM runnable WHERE rn <= $2)
  FOR UPDATE SKIP LOCKED   -- ← the whole trick
)
UPDATE jobs SET status = 'claimed', worker_id = $1
FROM locked WHERE jobs.id = locked.id
RETURNING jobs.*;`}
              </pre>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden bg-gradient-to-br from-accent to-indigo-700 py-20">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-20">
          <div className="absolute -bottom-24 left-1/3 h-80 w-80 rounded-full bg-white blur-3xl" />
        </div>
        <motion.div {...fadeUp} className="relative mx-auto max-w-2xl px-4 text-center sm:px-6">
          <h2 className="text-3xl font-bold text-white sm:text-4xl">Ready to see it move?</h2>
          <p className="mt-3 text-indigo-100">
            Register and get a fully populated workspace instantly — queues, retries, a cron
            schedule, and a job already sitting in the Dead Letter Queue to poke at.
          </p>
          <Button
            variant="secondary"
            className="!mt-7 !bg-white !px-6 !py-2.5 !text-base !text-accent hover:!bg-indigo-50"
            onClick={() => navigate('/login?mode=register')}
          >
            <span className="flex items-center gap-1.5">Get started free <ArrowRight size={16} /></span>
          </Button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-200 bg-white py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-sm text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-accent" />
            <span className="font-semibold text-slate-700">Pulse</span>
          </div>
          <span>A distributed job scheduling platform.</span>
        </div>
      </footer>
    </div>
  );
}
