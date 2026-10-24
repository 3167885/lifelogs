import { useState } from 'preact/hooks';
import { refreshStatus, useStore } from '../state.js';
import { EditPage } from './Edit.js';
import type { LocalSession } from '../local.js';

function local(iso: string): string {
  return new Date(iso).toLocaleString();
}

function syncLabel(s: LocalSession): string {
  if (s.sync_state === 'synced') return '已同步';
  return s.source === 'paired' ? '待同步（临时配对）' : '待同步';
}

export function HistoryPage(): preact.JSX.Element {
  const store = useStore();
  const [editing, setEditing] = useState<LocalSession | null>(null);

  if (editing !== null) {
    return <EditPage session={editing} onDone={() => void refreshStatus()} afterDone={() => setEditing(null)} />;
  }

  return (
    <section class="card">
      <h1>历史记录</h1>
      {store.sessions.length === 0 && <p class="hint">暂无记录。可在「补录」页添加。</p>}
      <ul class="session-list">
        {store.sessions.map((item) => (
          <li key={item.id} class="session-item">
            <div>
              <strong>{item.duration_minutes} 分钟</strong>
              <div>
                {local(item.start_at)} → {local(item.end_at)}
              </div>
              <div class="meta">
                质量：{item.quality ?? '—'} · v{item.version} · {syncLabel(item)}
                {item.conflict_note !== null ? ` · ⚠ ${item.conflict_note}` : ''}
              </div>
            </div>
            <button onClick={() => setEditing(item)}>编辑</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
