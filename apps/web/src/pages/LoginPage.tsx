import { useState } from 'react';
import { Zap } from 'lucide-react';
import { post, setToken } from '../api';
import { Button, ErrorNote, Field, inputClass } from '../ui';

export default function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@pulse.dev');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Zap size={28} className="text-accent" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Pulse</h1>
        </div>
        <div className="rounded-xl border border-surface-700 bg-surface-900 p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-100">
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
              <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <ErrorNote message={error} />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}
            </Button>
          </form>
          <button
            className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? "Don't have an account? Register" : 'Already registered? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
