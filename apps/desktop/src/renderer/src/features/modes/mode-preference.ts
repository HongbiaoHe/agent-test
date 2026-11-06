/**
 * 最近用的模式（localStorage `agent.mode`，同 Web 的 use-mode-preference）：新建会话时带上。
 * 只记 id；模式被删时 agent-host 按通用模式建会话，这里不用校验。
 */
const KEY = 'agent.mode';

export function readModePreference(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeModePreference(modeId: string | null): void {
  try {
    if (modeId) localStorage.setItem(KEY, modeId);
    else localStorage.removeItem(KEY);
  } catch {
    // 私有窗口 / 存储被禁用：不记就不记
  }
}
