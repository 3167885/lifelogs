/**
 * Token 安全存储封装（阶段 3 里程碑二）。
 * - 原生：MainActivity 注册的 SecureToken 插件（Android Keystore AES-GCM）。
 * - 浏览器开发环境：仅内存（明确不写 localStorage）。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureTokenPlugin {
  setToken(call: { token: string }): Promise<void>;
  getToken(): Promise<{ token?: string | null }>;
  clearToken(): Promise<void>;
}

const Native = registerPlugin<SecureTokenPlugin>('SecureToken');

let memoryToken: string | null = null;

let lastError: string | null = null;

export function secureTokenError(): string | null {
  return lastError;
}

export async function loadToken(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return memoryToken;
  try {
    const res = await Native.getToken();
    memoryToken = typeof res.token === 'string' ? res.token : null;
    lastError = null;
  } catch (e) {
    memoryToken = null;
    lastError = e instanceof Error ? e.message : String(e);
  }
  return memoryToken;
}

export async function storeToken(token: string | null): Promise<void> {
  memoryToken = token;
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (token === null) await Native.clearToken();
    else await Native.setToken({ token });
    lastError = null;
  } catch (e) {
    // 存储失败不影响本会话内内存 token；重启后需要重新登录。
    lastError = e instanceof Error ? e.message : String(e);
  }
}
