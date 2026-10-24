import { logout, punchSleep, punchWake, refreshStatus, syncNow, useStore } from '../state.js';

function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function PunchPage(): preact.JSX.Element {
  const s = useStore();
  const busy = s.status.kind === 'busy';
  const openAt = s.status.kind === 'open_sleep' ? s.status.occurredAt : null;

  return (
    <section class="card">
      <h1>睡眠打卡</h1>

      <div class="status" role="status">
        {s.status.kind === 'idle' && <span>当前没有待配对的入睡记录</span>}
        {s.status.kind === 'open_sleep' && (
          <span>
            已入睡，等待醒来打卡
            <br />
            <strong>{openAt !== '' ? localTime(openAt ?? '') : '…'}</strong>
          </span>
        )}
        {s.status.kind === 'busy' && <span>保存中…</span>}
        {s.status.kind === 'storage_error' && <span class="error">{s.status.message}</span>}
        {s.status.kind === 'signed_out' && <span>未登录</span>}
      </div>

      <div class="punch-buttons">
        <button class="big" disabled={busy || openAt !== null} onClick={() => void punchSleep()}>
          睡了
        </button>
        <button class="big" disabled={busy || openAt === null} onClick={() => void punchWake()}>
          醒了
        </button>
      </div>

      {s.lastResult !== null && <p class="result">{s.lastResult}</p>}

      <div class="sync-status">
        {s.sync.phase === 'running' && <span>同步中…</span>}
        {s.sync.phase === 'offline' && <span class="warn">离线：{s.sync.message ?? ''}</span>}
        {s.sync.phase === 'unauthorized' && <span class="error">{s.sync.message}（本地记录已保留）</span>}
        {s.sync.phase === 'failed' && <span class="error">同步失败：{s.sync.message}</span>}
        {s.sync.phase === 'success' && <span>已同步 ✓</span>}
        {s.sync.pendingCount > 0 && <span class="meta">待同步 {s.sync.pendingCount} 条</span>}
      </div>

      <div class="row">
        <button onClick={() => void syncNow()}>立即同步</button>
        <button onClick={() => void refreshStatus()}>刷新状态</button>
        <button onClick={() => void logout()}>退出登录</button>
      </div>
    </section>
  );
}
