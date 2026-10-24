import { logout, punchSleep, punchWake, refreshPending, useStore } from '../state.js';

function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function PunchPage(): preact.JSX.Element {
  const s = useStore();
  const busy = s.status.kind === 'syncing';

  return (
    <section class="card">
      <h1>睡眠打卡</h1>

      <div class="status" role="status">
        {s.status.kind === 'idle' && <span>当前没有待配对的入睡记录</span>}
        {s.status.kind === 'open_sleep' && (
          <span>
            已入睡，等待醒来打卡
            <br />
            <strong>{localTime(s.status.occurredAt)}</strong>
          </span>
        )}
        {s.status.kind === 'syncing' && <span>同步中…</span>}
        {s.status.kind === 'error' && (
          <span class="error">
            {s.status.code}：{s.status.message}
          </span>
        )}
        {s.status.kind === 'signed_out' && <span>未登录</span>}
      </div>

      {s.pendingWarning !== null && (
        <p class="warn">数据异常（{s.pendingWarning}）：请知悉，不要重复打卡。</p>
      )}

      <div class="punch-buttons">
        <button class="big" disabled={busy || s.status.kind === 'open_sleep'} onClick={() => void punchSleep()}>
          睡了
        </button>
        <button class="big" disabled={busy || s.status.kind !== 'open_sleep'} onClick={() => void punchWake()}>
          醒了
        </button>
      </div>

      {s.lastResult !== null && <p class="result">{s.lastResult}</p>}

      <div class="row">
        <button onClick={() => void refreshPending()}>刷新状态</button>
        <button onClick={() => void logout()}>退出登录</button>
      </div>
    </section>
  );
}
