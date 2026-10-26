import { useState } from 'preact/hooks';
import { refreshStatus, resolveConflict, useStore } from '../state.js';
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
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  async function onResolve(id: string, choice: 'server' | 'local'): Promise<void> {
    setResolving(id);
    setResolveError(null);
    const err = await resolveConflict(id, choice);
    setResolving(null);
    if (err !== null) setResolveError(err);
  }

  if (editing !== null) {
    return <EditPage session={editing} onDone={() => void refreshStatus()} afterDone={() => setEditing(null)} />;
  }

  return (
    <section class="card">
      <h1>历史记录</h1>
      {resolveError !== null && <p class="error">{resolveError}</p>}
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
            <div class="item-actions">
              <button onClick={() => setEditing(item)}>编辑</button>
            </div>
          </li>
        ))}
      </ul>
      {store.sessions.some((s) => s.conflict_note !== null) && (
        <div class="conflict">
          <h2>版本冲突待处理</h2>
          <p class="hint">
            服务器上已有更新。请明确选择保留哪一份；在做出选择前，本地修改不会被覆盖。
          </p>
          {store.sessions
            .filter((s) => s.conflict_note !== null)
            .map((s) => (
              <div key={`resolve-${s.id}`} class="conflict-actions">
                <div>
                  {local(s.start_at)} → {local(s.end_at)}（v{s.version}）
                </div>
                <button
                  disabled={resolving !== null}
                  onClick={() => void onResolve(s.id, 'server')}
                >
                  采用服务器版本
                </button>
                <button
                  disabled={resolving !== null}
                  onClick={() => void onResolve(s.id, 'local')}
                >
                  保留本地修改并重新提交
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
