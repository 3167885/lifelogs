import { useState } from 'preact/hooks';
import { login } from '../state.js';

export function LoginPage(): preact.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await login(email, password);
    setBusy(false);
    if (result !== null) setError(result);
  }

  return (
    <section class="card">
      <h1>登录</h1>
      <form onSubmit={onSubmit}>
        <label>
          邮箱
          <input
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            autocomplete="username"
            required
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            autocomplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        {error !== null && <p class="error">{error}</p>}
      </form>
      <p class="hint">
        记录保存在本机 SQLite；登录后即可打卡，同步稍后自动进行。
      </p>
    </section>
  );
}
