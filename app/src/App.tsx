import { useEffect, useState } from 'preact/hooks';
import { API_BASE } from './api.js';
import { bindSyncTriggers, bootstrap, useStore } from './state.js';
import { secureTokenError } from './secure-token.js';
import { LoginPage } from './pages/Login.js';
import { PunchPage } from './pages/Punch.js';
import { HistoryPage } from './pages/History.js';
import { BackfillPage } from './pages/Backfill.js';

type Route = 'punch' | 'history' | 'backfill';

const ROUTES: Record<string, Route> = {
  '#punch': 'punch',
  '#history': 'history',
  '#backfill': 'backfill',
};

function currentRoute(): Route {
  return ROUTES[location.hash] ?? 'punch';
}

export function App(): preact.JSX.Element {
  const s = useStore();
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    bindSyncTriggers();
    void bootstrap();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!s.signedIn) return <LoginPage />;

  return (
    <main>
      {route === 'punch' && <PunchPage />}
      {route === 'history' && <HistoryPage />}
      {route === 'backfill' && <BackfillPage />}
      <nav class="tabbar">
        <a href="#punch" class={route === 'punch' ? 'active' : ''}>打卡</a>
        <a href="#history" class={route === 'history' ? 'active' : ''}>历史</a>
        <a href="#backfill" class={route === 'backfill' ? 'active' : ''}>补录</a>
      </nav>
      <p class="hint backend">
        后端：{API_BASE}
        {s.storageNote !== null ? ` · ${s.storageNote}` : ''}
        {secureTokenError() !== null ? ` · 安全存储异常：${secureTokenError()}` : ''}
        {s.sync.lastAt !== null ? ` · 上次同步 ${new Date(s.sync.lastAt).toLocaleTimeString()}` : ''}
      </p>
    </main>
  );
}
