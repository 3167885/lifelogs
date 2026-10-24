import { resolveConflictAdoptServer, resolveConflictKeepLocal, useStore } from '../state.js';

export function ConflictBanner(): preact.JSX.Element | null {
  const s = useStore();
  if (s.conflict === null) return null;
  const c = s.conflict;
  return (
    <div class="conflict" role="alert">
      <h2>同步冲突</h2>
      <p>{c.message}</p>
      {c.serverSession !== null && (
        <p class="meta">
          服务器最新版本 v{c.serverSession.version}：
          {c.serverSession.duration_minutes} 分钟，质量 {c.serverSession.quality ?? '—'}
        </p>
      )}
      <div class="row">
        <button onClick={() => void resolveConflictAdoptServer()}>采用服务器版本</button>
        <button onClick={() => void resolveConflictKeepLocal()}>保留本地修改并重新提交</button>
      </div>
    </div>
  );
}
