/**
 * Web 账号登录（邮箱验证码，同 Web 端 /auth/send-code、/auth/verify-code）：在 main 进程里请求，
 * 用 Electron net.fetch（走 Chromium 网络栈与系统代理）。令牌只回到 main，由 DesktopStore 加密保存。
 */
import { net } from 'electron';
import { z } from 'zod';

const envelope = z.object({ code: z.number(), message: z.string().optional(), data: z.unknown() });

/** 后端地址：http(s)、去掉末尾斜杠 */
export function normalizeApiUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Web 后端地址必须是 http(s)');
  return u.toString().replace(/\/+$/, '');
}

async function post(apiUrl: string, path: string, body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await net.fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`连不上 Web 后端 ${apiUrl}：${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let parsed: z.infer<typeof envelope>;
  try {
    parsed = envelope.parse(JSON.parse(text));
  } catch {
    throw new Error(`Web 后端返回了无法识别的响应（HTTP ${res.status}）`);
  }
  if (parsed.code !== 0) throw new Error(parsed.message ?? `请求失败（${parsed.code}）`);
  return parsed.data;
}

export async function sendCode(apiUrl: string, email: string): Promise<{ devCode?: string }> {
  const data = z
    .object({ code: z.string().optional() })
    .parse(await post(apiUrl, '/auth/send-code', { email }));
  return data.code ? { devCode: data.code } : {};
}

export async function verifyCode(apiUrl: string, email: string, code: string): Promise<string> {
  return z.object({ token: z.string() }).parse(await post(apiUrl, '/auth/verify-code', { email, code })).token;
}
