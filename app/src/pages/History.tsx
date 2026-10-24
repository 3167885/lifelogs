import { useState } from 'preact/hooks';
import { refreshSessions, useStore } from '../state.js';
import { EditPage } from './Edit.js';
import type { SessionView } from '../api.js';

function local(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function HistoryPage(): preact.JSX.Element {
  const s = useStore();
  const [editing, setEditing] = useState<SessionView | null>(null);

  if (editing !== null) {
    return <EditPage session={editing} onDone={() => setEditing(null)} />;
  }

  return (
    <section class="card">
      <h1>历史记录</h1>
      <div class="row">
        <button onClick={() => void refreshSessions()}>从服务器刷新</button>
      </div>
      {s.sessions.length === 0 && <p class="hint">暂无记录。可在「补录」页添加。</p>}
      <ul class="session-list">
        {s.sessions.map((item) => (
          <li key={item.id} class="session-item">
            <div>
              <strong>{item.duration_minutes} 分钟</strong>
              <div>
                {local(item.start_at)} → {local(item.end_at)}
              </div>
              <div class="meta">
                质量：{item.quality ?? '—'} · v{item.version} · 已同步（服务端确认）
              </div>
            </div>
            <button onClick={() => setEditing(item)}>编辑</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
