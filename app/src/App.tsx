import { useEffect, useState } from 'preact/hooks';
import { API_BASE } from './api.js';
import { refreshPending, refreshSessions, useStore } from './state.js';
import { LoginPage } from './pages/Login.js';
import { PunchPage } from './pages/Punch.js';
import { HistoryPage } from './pages/History.js';
import { BackfillPage } from './pages/Backfill.js';
import { ConflictBanner } from './pages/Conflict.js';

type Route = 'punch' | 'history' | 'backfill';

const ROUTES: Record<string, Route> = {
  '#punch': 'punch',
  '#history': 'history',
  '#backfill': 'backfill',
};

function currentRoute(): Route {
  const r = ROUTES[location.hash];
  return r ?? 'punch';
}

export function App(): preact.JSX.Element {
  const s = useStore();
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    if (s.signedIn) {
      void Promise.all([refreshSessions(), refreshPending()]);
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, [s.signedIn]);

  if (!s.signedIn) return <LoginPage />;

  return (
    <main>
      <ConflictBanner />
      {route === 'punch' && <PunchPage />}
      {route === 'history' && <HistoryPage />}
      {route === 'backfill' && <BackfillPage />}
      <nav class="tabbar">
        <a href="#punch" class={route === 'punch' ? 'active' : ''}>打卡</a>
        <a href="#history" class={route === 'history' ? 'active' : ''}>历史</a>
        <a href="#backfill" class={route === 'backfill' ? 'active' : ''}>补录</a>
      </nav>
      <p class="hint backend">后端：{API_BASE}（在线模式；无离线持久化 — 阶段 3 接入 SQLite/Outbox）</p>
    </main>
  );
}
