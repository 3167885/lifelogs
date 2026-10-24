import { useState } from 'preact/hooks';
import { editSession } from '../state.js';
import type { SessionView } from '../api.js';

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toUtcIso(localValue: string): string | null {
  const ms = Date.parse(localValue);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function EditPage({ session, onDone }: { session: SessionView; onDone: () => void }): preact.JSX.Element {
  const [start, setStart] = useState(toLocalInput(session.start_at));
  const [end, setEnd] = useState(toLocalInput(session.end_at));
  const [quality, setQuality] = useState(session.quality === null ? '' : String(session.quality));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    setError(null);
    const s = toUtcIso(start);
    const en = toUtcIso(end);
    if (s === null || en === null) {
      setError('时间格式无效');
      return;
    }
    setBusy(true);
    const result = await editSession(session.id, session.version, {
      start_at: s,
      end_at: en,
      quality: quality === '' ? null : Number(quality),
    });
    setBusy(false);
    if (result !== null) setError(result);
    else onDone();
  }

  return (
    <section class="card">
      <h1>编辑记录</h1>
      <p class="hint">
        服务器版本 v{session.version}：{session.duration_minutes} 分钟
      </p>
      <form onSubmit={onSubmit}>
        <label>
          开始时间
          <input type="datetime-local" value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          结束时间
          <input type="datetime-local" value={end} onInput={(e) => setEnd((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          质量（1–5，留空清除）
          <input type="number" min="1" max="5" step="1" value={quality} onInput={(e) => setQuality((e.target as HTMLInputElement).value)} />
        </label>
        <div class="row">
          <button type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          <button type="button" onClick={onDone}>取消</button>
        </div>
        {error !== null && <p class="error">{error}</p>}
      </form>
    </section>
  );
}
