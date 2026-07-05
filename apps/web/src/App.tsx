import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Activity, AlertOctagon, CalendarClock, Cpu, LayoutDashboard, List, Layers, LogOut, Menu, Terminal, X, Zap,
} from 'lucide-react';
import { api, getToken, setToken } from './api';
import { useLiveEvents } from './hooks';
import type { Org, Project, User } from './types';
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

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(() => localStorage.getItem('pulse_project'));
  const [booting, setBooting] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigate = useNavigate();

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
      <div className="flex h-screen items-center justify-center bg-surface-50 text-slate-400">
        <Zap size={18} className="mr-2 animate-pulse text-accent" /> Loading&hellip;
      </div>
    );
  }

  if (!authed || !user) {
    return <LoginPage onAuthed={() => { setBooting(true); setAuthed(true); }} />;
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
          className="rounded p-1 text-slate-400 hover:bg-surface-200 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <select
          className="w-full rounded-lg border border-surface-300 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
          value={project?.id ?? ''}
          onChange={(e) => { setProjectId(e.target.value); navigate('/'); setMobileNavOpen(false); }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onClick={() => setMobileNavOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive ? 'bg-accent-soft text-accent' : 'text-slate-500 hover:bg-surface-200 hover:text-slate-800'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-surface-300 px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
          <Activity size={12} className={liveConnected ? 'text-emerald-500' : 'text-slate-300'} />
          {liveConnected ? 'Live updates connected' : 'Polling (WS reconnecting)'}
        </div>
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-700">{user.name}</div>
            <div className="truncate text-xs text-slate-400">{user.email}</div>
          </div>
          <button
            title="Sign out"
            className="rounded p-1.5 text-slate-400 hover:bg-surface-200 hover:text-slate-700"
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
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-slate-900/30" onClick={() => setMobileNavOpen(false)} />
            <aside className="relative flex h-full w-64 flex-col border-r border-surface-300 bg-surface-100 shadow-popover">
              {sidebarContent}
            </aside>
          </div>
        )}

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
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/queues" element={<QueuesPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/workers" element={<WorkersPage />} />
                <Route path="/dlq" element={<DlqPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            ) : (
              <div className="flex h-full items-center justify-center text-slate-400">
                No projects yet — create one from the API or seed the demo data.
              </div>
            )}
          </main>
        </div>
      </div>
    </AppContext.Provider>
  );
}
