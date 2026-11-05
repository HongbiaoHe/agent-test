/**
 * main 进程的持久化：设置（settings.json，明文）与密钥（secrets.json，safeStorage 加密 → 系统钥匙串保护）。
 * 密钥包括各提供方的模型 Key，以及 MCP 凭据加密用的随机密钥（首次启动生成）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import {
  type DesktopSettings,
  type KeyStatus,
  PROVIDER_KEYS,
  type ProviderKey,
  THEME_PREFERENCES,
  type WebAccountStatus,
} from '../shared/desktop';
import { validateWorkspaceDir } from '../shared/workspace';

export const DEFAULT_MODEL = 'google-genai:gemini-3.8-flash';
/** Web 后端（apps/backend）默认地址：本机开发端口，可在设置里改成线上地址 */
export const DEFAULT_WEB_API_URL = 'http://localhost:3101';

const settingsSchema = z.object({
  workspaceDir: z.string(),
  defaultModel: z.string(),
  webApiUrl: z.string(),
  loginSkipped: z.boolean(),
  theme: z.enum(THEME_PREFERENCES),
});

const secretsSchema = z.object({
  google: z.string().optional(),
  deepseek: z.string().optional(),
  mcpKey: z.string().optional(),
  /** Web 账号会话：令牌加密保存；邮箱与登录时的后端地址一起记下（换地址 = 换账号体系） */
  webToken: z.string().optional(),
  webEmail: z.string().optional(),
  webApiUrl: z.string().optional(),
});

/** JWT 载荷里用到的字段（Web 后端签发：sub = 用户 id，exp = 过期秒数）；解析不了返回 null（当作已过期） */
function jwtPayload(token: string): { sub: string; exp: number } | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = z
      .object({ sub: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), exp: z.number() })
      .safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
type Secrets = z.infer<typeof secretsSchema>;

export class DesktopStore {
  private readonly settingsFile: string;
  private readonly secretsFile: string;

  constructor(private readonly userData: string) {
    this.settingsFile = join(userData, 'settings.json');
    this.secretsFile = join(userData, 'secrets.json');
  }

  getSettings(): DesktopSettings {
    const defaults: DesktopSettings = {
      workspaceDir: process.env.SPARK_DEFAULT_WORKSPACE ?? join(homedir(), 'Spark'),
      defaultModel: DEFAULT_MODEL,
      webApiUrl: process.env.SPARK_WEB_API_URL ?? DEFAULT_WEB_API_URL,
      loginSkipped: false,
      theme: 'system',
    };
    const raw = readJson(this.settingsFile);
    const parsed = settingsSchema.partial().safeParse(raw);
    return { ...defaults, ...(parsed.success ? parsed.data : {}) };
  }

  updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.getSettings(), ...patch };
    const err = validateWorkspaceDir(next.workspaceDir);
    if (err) throw new Error(err);
    writeJson(this.settingsFile, next);
    return next;
  }

  keyStatus(): KeyStatus {
    const s = this.secrets();
    return { google: !!s.google, deepseek: !!s.deepseek };
  }

  setKey(provider: ProviderKey, value: string | null): KeyStatus {
    const s = this.secrets();
    const trimmed = value?.trim();
    s[provider] = trimmed ? this.encrypt(trimmed) : undefined;
    writeJson(this.secretsFile, s);
    return this.keyStatus();
  }

  /** 解密后的 Key（只交给 agent-host 的 env，不发给 renderer） */
  keys(): Partial<Record<ProviderKey, string>> {
    const s = this.secrets();
    const out: Partial<Record<ProviderKey, string>> = {};
    for (const p of PROVIDER_KEYS) {
      const enc = s[p];
      if (enc) out[p] = this.decrypt(enc);
    }
    return out;
  }

  // ── Web 账号 ────────────────────────────────────────────────────────────

  webAccount(): WebAccountStatus {
    const s = this.secrets();
    const apiUrl = this.getSettings().webApiUrl;
    const token = s.webToken ? this.decrypt(s.webToken) : null;
    const exp = token ? (jwtPayload(token)?.exp ?? 0) * 1000 || null : null;
    // 令牌过期、或设置里换了后端地址：视为未登录（旧令牌对新地址无效）
    const signedIn = !!token && !!exp && exp > Date.now() && s.webApiUrl === apiUrl;
    return {
      signedIn,
      email: signedIn ? (s.webEmail ?? null) : null,
      apiUrl,
      expiresAt: signedIn && exp ? new Date(exp).toISOString() : null,
    };
  }

  /**
   * 当前账号的数据目录：会话、技能、连接器都在这里（每个用户一份，互相看不到）。
   * 已登录 = `<userData>/users/<Web 用户 id>`；未登录 = 访客空间，就是 userData 本身
   * （登录功能上线前的数据原地成为访客数据，不用迁移）。模型 Key、外观、默认工作区是设备级，不在这里。
   */
  profileDir(): string {
    const s = this.secrets();
    const token = this.webAccount().signedIn && s.webToken ? this.decrypt(s.webToken) : null;
    const sub = token ? jwtPayload(token)?.sub : null;
    return sub ? join(this.userData, 'users', sub) : this.userData;
  }

  /** 交给 agent-host 的有效令牌（未登录 / 已过期返回 null） */
  webToken(): string | null {
    const s = this.secrets();
    return this.webAccount().signedIn && s.webToken ? this.decrypt(s.webToken) : null;
  }

  setWebSession(email: string, token: string, apiUrl: string): void {
    this.updateSettings({ webApiUrl: apiUrl });
    const s = this.secrets();
    s.webToken = this.encrypt(token);
    s.webEmail = email;
    s.webApiUrl = apiUrl;
    writeJson(this.secretsFile, s);
  }

  clearWebSession(): void {
    // 退出登录 = 回到登录页（不再沿用之前的「跳过」）
    this.updateSettings({ loginSkipped: false });
    const s = this.secrets();
    s.webToken = undefined;
    s.webEmail = undefined;
    s.webApiUrl = undefined;
    writeJson(this.secretsFile, s);
  }

  /** MCP 凭据加密密钥：没有就生成一把随机密钥并加密保存 */
  mcpEncryptionKey(): string {
    const s = this.secrets();
    if (s.mcpKey) return this.decrypt(s.mcpKey);
    const key = randomBytes(32).toString('base64url');
    s.mcpKey = this.encrypt(key);
    writeJson(this.secretsFile, s);
    return key;
  }

  private secrets(): Secrets {
    const parsed = secretsSchema.safeParse(readJson(this.secretsFile));
    return parsed.success ? parsed.data : {};
  }

  private encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统钥匙串不可用，无法安全保存密钥');
    }
    return safeStorage.encryptString(plain).toString('base64');
  }

  private decrypt(b64: string): string {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
