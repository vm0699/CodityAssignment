import { useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Zap } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, setToken } from '../api';
import { Button, ErrorNote, Field, inputClass } from '../ui';

export default function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>(searchParams.get('mode') === 'register' ? 'register' : 'login');
  const [email, setEmail] = useState('demo@pulse.dev');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Client-side pre-check so the user gets instant, specific feedback
    // instead of a round-trip to the API for something checkable locally.
    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    setBusy(true);
    try {
      const res =
        mode === 'login'
          ? await post<{ token: string }>('/api/auth/login', { email, password })
          : await post<{ token: string }>('/api/auth/register', { email, password, name });
      setToken(res.token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2">
          <Zap size={28} className="text-accent" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Pulse</h1>
        </Link>
        <div className="rounded-xl border border-surface-300 bg-white p-6 shadow-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">
            {mode === 'login' ? 'Sign in' : 'Create an account'}
          </h2>
          <form onSubmit={submit} className="space-y-3">
            {mode === 'register' && (
              <Field label="Name">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
            )}
            <Field label="Email">
              <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password" hint={mode === 'login' ? 'demo account: demo@pulse.dev / demo1234' : 'at least 8 characters'}>
              <div className="relative">
                <input
                  className={`${inputClass} pr-9`}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={mode === 'register' ? 8 : undefined}
                  required
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-500 hover:text-slate-600"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </Field>
            <ErrorNote message={error} />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}
            </Button>
          </form>
          <button
            className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-700"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          >
            {mode === 'login' ? "Don't have an account? Register" : 'Already registered? Sign in'}
          </button>
        </div>
        <Link to="/" className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-slate-600">
          <ArrowLeft size={13} /> Back to home
        </Link>
      </div>
    </div>
  );
}
