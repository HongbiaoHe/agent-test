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
  const body = (await res.json()) as ApiEnvelope<T>;
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
): Promise<{ conversationId: string }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ goal }),
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
): Promise<{ conversationId: string }> {
  return request(`/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
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
