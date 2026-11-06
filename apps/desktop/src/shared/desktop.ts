/**
 * main 进程持有的桌面端设置与 Key 状态（renderer 经 preload 暴露的 window.desktop 读写），
 * 以及 main → agent-host 的控制消息。
 */

import type { LanguagePreference, Locale } from './i18n/locales';

export interface DesktopSettings {
  /** 新会话默认使用的工作区（默认 ~/Spark）；每个会话可另选目录与权限 */
  workspaceDir: string;
  /** 新会话默认模型（provider:model） */
  defaultModel: string;
  /** Web 后端地址（登录 Web 账号后，生图 / 生视频 / 配音经它调 aigc）；默认 http://localhost:3101 */
  webApiUrl: string;
  /** 启动时的登录页选了「先跳过」：不再自动弹出（退出登录时清掉，下次启动重新出现） */
  loginSkipped: boolean;
  /** 外观：跟随系统 / 浅色 / 深色（main 设到 nativeTheme.themeSource，页面的 prefers-color-scheme 随之变） */
  theme: ThemePreference;
  /** 界面语言：跟随系统 / 指定（main 用 resolveLocale 解析成实际语言，经 getLocale 给 renderer、经 config 给 agent-host） */
  language: LanguagePreference;
}

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Web 账号登录状态（令牌只在 main / agent-host，renderer 只看到这些） */
export interface WebAccountStatus {
  signedIn: boolean;
  email: string | null;
  apiUrl: string;
  /** 令牌过期时刻（ISO）；未登录为 null */
  expiresAt: string | null;
}

export const PROVIDER_KEYS = ['google', 'deepseek'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export type KeyStatus = Record<ProviderKey, boolean>;

/** renderer 经 preload 拿到的原生能力（实现见 src/preload/index.ts） */
export interface DesktopApi {
  getSettings(): Promise<DesktopSettings>;
  /** 实际界面语言（设置为「跟随系统」时按系统首选语言解析） */
  getLocale(): Promise<Locale>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  getKeyStatus(): Promise<KeyStatus>;
  /** 写入 / 清除（null）某提供方的 Key；会重启 agent-host 让新 Key 生效 */
  setKey(provider: ProviderKey, value: string | null): Promise<KeyStatus>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  /** 拖进窗口的文件 → 本地绝对路径（contextIsolation 下 File 不再带 path） */
  getPathForFile(file: File): string;
  openExternal(url: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  /** 工作区网页预览的源（spark-preview://w-<hash>）：工作区根即站点根，页面地址 = 源 + / + 工作区相对路径 */
  sitePreviewOrigin(workspaceDir: string): Promise<string>;
  /** 预览弹窗读远程 md / 文本（经 main 取，绕开 renderer 的跨域限制）；只放行 http(s)，最多 2MB */
  fetchText(url: string): Promise<{ text: string; truncated: boolean }>;
  getWebAccount(): Promise<WebAccountStatus>;
  /** 发邮箱验证码；测试环境后端会直接返回验证码（devCode） */
  sendWebCode(email: string, apiUrl: string): Promise<{ devCode?: string }>;
  /** 验证码登录：成功后令牌加密保存，并重启 agent-host 让媒体工具生效 */
  signInWeb(email: string, code: string, apiUrl: string): Promise<WebAccountStatus>;
  signOutWeb(): Promise<WebAccountStatus>;
}

/** main → agent-host（utilityProcess.postMessage） */
export type HostControlMessage =
  | { type: 'config'; settings: DesktopSettings; keys: KeyStatus; locale: Locale }
  | { type: 'port' };

/** renderer 收到 agent-host 端口时，preload 转发的 window message 标记 */
export const AGENT_PORT_MESSAGE = 'spark:agent-port';

/** agent-host 即将重启 / 已退出：renderer 应丢弃旧端口，新请求等新端口 */
export const AGENT_PORT_CLOSED_MESSAGE = 'spark:agent-port-closed';
