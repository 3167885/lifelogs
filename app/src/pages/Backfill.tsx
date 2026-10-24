import { useState } from 'preact/hooks';
import { backfill } from '../state.js';

/** datetime-local 值 → 规范化 UTC ISO 字符串（本地时区解释）。 */
function toUtcIso(localValue: string): string | null {
  const ms = Date.parse(localValue);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function BackfillPage(): preact.JSX.Element {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [quality, setQuality] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    setError(null);
    setOk(null);
    const s = toUtcIso(start);
    const en = toUtcIso(end);
    if (s === null || en === null) {
      setError('请填写有效的开始和结束时间');
      return;
    }
    setBusy(true);
    const q = quality === '' ? null : Number(quality);
    const result = await backfill(s, en, q);
    setBusy(false);
    if (result !== null) setError(result);
    else {
      setOk('补录成功（已写入服务器）');
      setStart('');
      setEnd('');
      setQuality('');
    }
  }

  return (
    <section class="card">
      <h1>补录记录</h1>
      <form onSubmit={onSubmit}>
        <label>
          开始时间
          <input type="datetime-local" value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          结束时间
          <input type="datetime-local" value={end} onInput={(e) => setEnd((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          质量（1–5，可选）
          <input type="number" min="1" max="5" step="1" value={quality} onInput={(e) => setQuality((e.target as HTMLInputElement).value)} />
        </label>
        <button type="submit" disabled={busy}>{busy ? '提交中…' : '补录'}</button>
        {error !== null && <p class="error">{error}</p>}
        {ok !== null && <p class="result">{ok}</p>}
      </form>
      <p class="hint">阶段 2：补录直接同步写入服务器；离线补录与待同步状态在阶段 3 实现。</p>
    </section>
  );
}
