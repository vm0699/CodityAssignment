import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertOctagon, CalendarClock, Cpu, LayoutDashboard, List, Layers, LogOut, Menu, Settings, Terminal, X, Zap,
} from 'lucide-react';
import { api, patch, getToken, setToken } from './api';
import { useLiveEvents } from './hooks';
import { useToast } from './toast';
import type { Org, Project, User } from './types';
import { Button, ErrorNote, Field, HeartbeatLine, Modal, inputClass } from './ui';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import QueuesPage from './pages/QueuesPage';
import JobsPage from './pages/JobsPage';
import WorkersPage from './pages/WorkersPage';
import DlqPage from './pages/DlqPage';
import SchedulesPage from './pages/SchedulesPage';
import ActivityPage from './pages/ActivityPage';

interface AppContextValue {
  user: User;
  orgs: Org[];
  projects: Project[];
  project: Project | null;
  setProjectId: (id: string) => void;
  refreshProjects: () => Promise<void>;
  liveTick: number;
  liveConnected: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        <Routes location={location}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

/** Rename/describe the current project — including the auto-provisioned
 * starter workspace every new account gets, so nothing is permanently
 * hardcoded. */
function EditProjectModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/projects/${project.id}`, { name, description });
      onSaved();
      toast.show('success', 'Project updated.');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Description">
          <textarea className={`${inputClass} h-24`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(() => localStorage.getItem('pulse_project'));
  const [booting, setBooting] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const setProjectId = useCallback((id: string) => {
    localStorage.setItem('pulse_project', id);
    setProjectIdState(id);
  }, []);

  const refreshProjects = useCallback(async () => {
    const res = await api<{ data: Project[] }>('/api/projects');
    setProjects(res.data);
  }, []);

  useEffect(() => {
    const onLogout = () => {
      setAuthed(false);
      setUser(null);
    };
    window.addEventListener('pulse:logout', onLogout);
    return () => window.removeEventListener('pulse:logout', onLogout);
  }, []);

  useEffect(() => {
    if (!authed) {
      setBooting(false);
      return;
    }
    void (async () => {
      try {
        const me = await api<{ user: User; organizations: Org[] }>('/api/auth/me');
        setUser(me.user);
        setOrgs(me.organizations);
        const res = await api<{ data: Project[] }>('/api/projects');
        setProjects(res.data);
        if (res.data.length > 0 && !res.data.some((p) => p.id === localStorage.getItem('pulse_project'))) {
          localStorage.setItem('pulse_project', res.data[0].id);
          setProjectIdState(res.data[0].id);
        }
      } catch {
        setToken(null);
        setAuthed(false);
      } finally {
        setBooting(false);
      }
    })();
  }, [authed]);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? projects[0] ?? null, [projects, projectId]);
  const { tick: liveTick, connected: liveConnected } = useLiveEvents(authed && project ? project.id : null);

  if (booting) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-50 text-slate-500">
        <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.2, repeat: Infinity }}>
          <Zap size={18} className="mr-2 inline text-accent" />
        </motion.span>
        Loading&hellip;
      </div>
    );
  }

  if (!authed || !user) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage onAuthed={() => { setBooting(true); setAuthed(true); }} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  const ctx: AppContextValue = {
    user, orgs, projects, project, setProjectId, refreshProjects, liveTick, liveConnected,
  };

  const nav = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/queues', label: 'Queues', icon: Layers },
    { to: '/jobs', label: 'Jobs', icon: List },
    { to: '/schedules', label: 'Schedules', icon: CalendarClock },
    { to: '/workers', label: 'Workers', icon: Cpu },
    { to: '/dlq', label: 'Dead Letter', icon: AlertOctagon },
    { to: '/activity', label: 'Activity Log', icon: Terminal },
  ];

  const sidebarContent = (
    <>
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-accent" />
          <span className="text-lg font-bold tracking-tight text-slate-900">Pulse</span>
        </div>
        <button
          className="rounded p-1 text-slate-500 hover:bg-surface-200 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <select
          className="w-full rounded-lg border border-surface-300 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
          value={project?.id ?? ''}
          onChange={(e) => { setProjectId(e.target.value); navigate('/'); setMobileNavOpen(false); }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {project && (
          <button
            title="Edit project"
            onClick={() => setEditingProject(true)}
            className="shrink-0 rounded-lg border border-surface-300 p-1.5 text-slate-500 hover:bg-surface-200 hover:text-slate-800"
          >
            <Settings size={15} />
          </button>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map(({ to, label, icon: Icon }) => {
          const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
          return (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobileNavOpen(false)}
              className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'text-accent' : 'text-slate-500 hover:bg-surface-200 hover:text-slate-800'
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-lg bg-accent-soft"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              <Icon size={16} className="relative z-10" />
              <span className="relative z-10">{label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="border-t border-surface-300 px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
          {liveConnected ? (
            <>
              <HeartbeatLine width={44} height={16} color="#10b981" />
              Live updates connected
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              Polling (WS reconnecting)
            </>
          )}
        </div>
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-700">{user.name}</div>
            <div className="truncate text-xs text-slate-500">{user.email}</div>
          </div>
          <button
            title="Sign out"
            className="rounded p-1.5 text-slate-500 hover:bg-surface-200 hover:text-slate-700"
            onClick={() => { setToken(null); window.dispatchEvent(new Event('pulse:logout')); }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen overflow-hidden bg-surface-50">
        {/* Desktop sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-surface-300 bg-surface-100 lg:flex">
          {sidebarContent}
        </aside>

        {/* Mobile slide-over sidebar */}
        <AnimatePresence>
          {mobileNavOpen && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <motion.div
                className="absolute inset-0 bg-slate-900/30"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setMobileNavOpen(false)}
              />
              <motion.aside
                className="relative flex h-full w-64 flex-col border-r border-surface-300 bg-surface-100 shadow-popover"
                initial={{ x: -264 }} animate={{ x: 0 }} exit={{ x: -264 }}
                transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              >
                {sidebarContent}
              </motion.aside>
            </div>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <div className="flex items-center gap-2 border-b border-surface-300 bg-surface-100 px-4 py-3 lg:hidden">
            <button
              className="rounded p-1.5 text-slate-500 hover:bg-surface-200"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={20} />
            </button>
            <Zap size={18} className="text-accent" />
            <span className="font-bold text-slate-900">Pulse</span>
          </div>

          {/* Main */}
          <main className="flex-1 overflow-y-auto">
            {project ? (
              <AnimatedRoutes />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-500">
                No projects yet — create one from the API or seed the demo data.
              </div>
            )}
          </main>
        </div>
      </div>

      {editingProject && project && (
        <EditProjectModal
          project={project}
          onClose={() => setEditingProject(false)}
          onSaved={() => void refreshProjects()}
        />
      )}
    </AppContext.Provider>
  );
}
