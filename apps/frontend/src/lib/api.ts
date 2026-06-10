import { getSession } from "next-auth/react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3101";

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 统一请求：从 next-auth session 取 backendToken 带 Authorization；解析 {code,message,data}。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = (await getSession()) as { backendToken?: string } | null;
  const token = session?.backendToken;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // 经 ngrok 隧道时跳过 free 版浏览器拦截页，避免接口返回 HTML
      "ngrok-skip-browser-warning": "1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  // 后端正常返回 {code,message,data} JSON；但 5xx / 网关错误可能回纯文本或 HTML，
  // 直接 res.json() 会抛 "Unexpected token ..." 这种晦涩报错，故先按文本读、再尝试解析，
  // 解析失败时退化成带状态码的清晰错误，便于 UI 直接展示。
  const text = await res.text();
  let body: ApiEnvelope<T>;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new Error(`请求失败 (${res.status})`);
  }
  if (body.code !== 0) {
    throw new Error(body.message || `请求失败 (${res.status})`);
  }
  return body.data;
}

export interface ConversationMessage {
  id: string;
  role: string;
  type: string;
  content: unknown;
  seq: number;
}

export interface Conversation {
  id: string;
  goal: string;
  status: string;
  messages: ConversationMessage[];
}

/** 侧栏列表项（GET /conversations，不含 messages）。 */
export interface ConversationListItem {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
}

export function createConversation(
  goal: string,
  model?: string,
): Promise<{ conversationId: string }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ goal, model }),
  });
}

export function listConversations(): Promise<ConversationListItem[]> {
  return request("/conversations");
}

/** /command 可用命令（供输入框 `/` 自动补全）。 */
export interface CommandInfo {
  name: string;
  description: string;
  domain: string;
}

export function listCommands(): Promise<CommandInfo[]> {
  return request("/commands");
}

export function getConversation(id: string): Promise<Conversation> {
  return request(`/conversations/${id}`);
}

/** 在已有会话里追加一条用户消息，触发同 thread_id 续跑（多轮）。 */
export function appendMessage(
  id: string,
  content: string,
  model?: string,
): Promise<{ conversationId: string }> {
  return request(`/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, model }),
  });
}

// ——— Skills 技能管理 ———

/** 技能注册表条目（GET /skills）。source==='builtin' 为内置（不可启停/删除）。 */
export interface SkillInfo {
  name: string;
  description: string;
  domain: string;
  source: "builtin" | string;
  enabled: boolean;
}

/** 从 GitHub 安装技能的入参。path 指向仓库内含 SKILL.md 的子目录；ref 可选（分支/标签/commit）。 */
export interface InstallSkillInput {
  repo: string;
  path: string;
  ref?: string;
}

export function listSkills(): Promise<SkillInfo[]> {
  return request("/skills");
}

export function installSkill(input: InstallSkillInput): Promise<SkillInfo> {
  return request("/skills/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function toggleSkill(
  name: string,
  enabled: boolean,
): Promise<SkillInfo> {
  return request(`/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteSkill(name: string): Promise<unknown> {
  return request(`/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// ——— Passkey / WebAuthn（后端 @simplewebauthn 完成校验后签发 token）———
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

// rpId/origin 按当前访问域名带上，使 passkey 在 localhost 与隧道域名下都自动正确
function rp() {
  return { rpId: window.location.hostname, origin: window.location.origin };
}

export function passkeyRegisterOptions(
  email: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return request("/auth/passkey/register/options", {
    method: "POST",
    body: JSON.stringify({ email, ...rp() }),
  });
}

export function passkeyRegisterVerify(
  email: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: boolean; token: string; email: string }> {
  return request("/auth/passkey/register/verify", {
    method: "POST",
    body: JSON.stringify({ email, response, ...rp() }),
  });
}

export function passkeyLoginOptions(email: string): Promise<{
  flowId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request("/auth/passkey/login/options", {
    method: "POST",
    body: JSON.stringify({ email, ...rp() }),
  });
}

export function passkeyLoginVerify(
  flowId: string,
  response: AuthenticationResponseJSON,
): Promise<{ token: string; email: string }> {
  return request("/auth/passkey/login/verify", {
    method: "POST",
    body: JSON.stringify({ flowId, response, ...rp() }),
  });
}
