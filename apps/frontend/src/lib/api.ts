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
    throw new Error(`Request failed (${res.status})`);
  }
  if (body.code !== 0) {
    throw new Error(body.message || `Request failed (${res.status})`);
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

/** 创建空会话（idle，不带首条消息、不触发运行）：先建会话再进入，首条消息走 appendMessage。 */
export function createEmptyConversation(
  model?: string,
): Promise<{ conversationId: string }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

export function listConversations(): Promise<ConversationListItem[]> {
  return request("/conversations");
}

/** 技能分类：内置（随系统发布）或 GitHub 安装。与后端 SkillKind 对应。 */
export type SkillKind = "builtin" | "github";

/** /command 可用命令（供输入框 `/` 自动补全）。 */
export interface CommandInfo {
  name: string;
  description: string;
  kind: SkillKind;
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

/** 主动停止当前运行（幂等；stopped 表示本次是否实际停掉了什么）。 */
export function stopConversation(id: string): Promise<{ stopped: boolean }> {
  return request(`/conversations/${id}/stop`, { method: "POST" });
}

// ——— 沙箱状态 ———

/** GET /sandbox/status（user 级只读，不唤醒停机沙箱）。 */
export interface SandboxStatus {
  exists: boolean;
  id?: string;
  state?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  autoStopMinutes?: number | null;
  autoDeleteMinutes?: number | null;
  /** 仅 includeFiles 且 started 时返回；其余为 null */
  files?: { path: string }[] | null;
}

/**
 * includeFiles=false（心跳轮询用）只查状态，不连沙箱——连沙箱（GET by id）会刷新
 * Daytona 活动事件导致永不自动停机；文件列表仅详情面板打开时传 true 拉取。
 */
export function fetchSandboxStatus(includeFiles = false): Promise<SandboxStatus> {
  return request(`/sandbox/status${includeFiles ? "?files=1" : ""}`);
}

// ——— 生图/生视频 媒体 ———

export type MediaType = "image" | "video";
export type MediaStatus = "queued" | "generating" | "done" | "failed";

/** 一次生成尝试（版本）。重新生成在同一 generation 下叠新 version，旧版永不删除。 */
export interface MediaVersion {
  id: string;
  prompt: string;
  model: string;
  status: MediaStatus;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  /** 此版本引用的图片版本 id（图生图/视频首帧）。无引用时为 []（后端已归一）。 */
  referenceVersionIds: string[];
}

/** 一个生成位 = 对话里的一张媒体卡片。versions 按 createdAt desc（versions[0] 为最新版）。 */
export interface MediaGeneration {
  id: string;
  type: MediaType;
  createdAt: string;
  versions: MediaVersion[];
}

/** 列出会话下全部生成位（含全部版本，desc）。卡片状态的唯一数据源。 */
export function listConversationMedia(
  conversationId: string,
): Promise<MediaGeneration[]> {
  return request(`/conversations/${conversationId}/media`);
}

/**
 * 重新生成：同 generation 叠新版本。前端总是回传当前看到的 prompt（即使未改动，语义一致）。
 * referenceVersionIds 可选：卡片重生成时沿用当前版本的参考图，行为可预期；缺省时后端继承上一版。
 */
export function regenerateMedia(
  generationId: string,
  prompt?: string,
  referenceVersionIds?: string[],
): Promise<{ generationId: string; versionId: string }> {
  return request(`/media/generations/${generationId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ prompt, referenceVersionIds }),
  });
}

/**
 * 取某版本资产的二进制 Blob（图片/视频）。
 * 注意：asset 路由用 StreamableFile 原样返回二进制（不裹 {code,message,data}），
 * 故不能走 request() 的 JSON 解析路径——这里手动 fetch、带 Authorization、读 Blob。
 */
export async function fetchMediaAssetBlob(versionId: string): Promise<Blob> {
  const session = (await getSession()) as { backendToken?: string } | null;
  const token = session?.backendToken;
  const res = await fetch(`${API_BASE}/media/versions/${versionId}/asset`, {
    headers: {
      "ngrok-skip-browser-warning": "1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load asset (${res.status})`);
  }
  return res.blob();
}

// ——— Skills 技能管理 ———

/** 技能注册表条目（GET /skills）。kind==='builtin' 为内置（不可启停/删除）。 */
export interface SkillInfo {
  name: string;
  description: string;
  kind: SkillKind;
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

/** 技能详情（GET /skills/:name）：文件路径列表 + SKILL.md 原文。 */
export interface SkillDetail extends SkillInfo {
  files: string[];
  skillMd: string;
}

export function getSkillDetail(name: string): Promise<SkillDetail> {
  return request(`/skills/${encodeURIComponent(name)}`);
}

/** 解析 install 落库的 source 串（github:owner/repo#path@ref），供"更新"按钮重装同源。 */
export function parseGithubSource(source: string): InstallSkillInput | null {
  const m = /^github:([^#]+)#([^@]+)@(.+)$/.exec(source);
  if (!m) return null;
  return { repo: m[1], path: m[2], ref: m[3] };
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

// ——— 当前用户（/users/me）———

/** 已注册 passkey（transports 为逗号拼接串，可为 null，前端自行 split）。 */
export interface MyPasskey {
  id: string;
  createdAt: string;
  transports: string | null;
}

export interface MeInfo {
  email: string;
  createdAt: string;
  tenantName: string;
  passkeys: MyPasskey[];
}

export function getMe(): Promise<MeInfo> {
  return request("/users/me");
}

/** 登录态添加 passkey：身份取自 JWT，只传 rpId/origin。 */
export function myPasskeyOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return request("/users/me/passkeys/options", {
    method: "POST",
    body: JSON.stringify(rp()),
  });
}

export function myPasskeyVerify(
  response: RegistrationResponseJSON,
): Promise<MyPasskey> {
  return request("/users/me/passkeys/verify", {
    method: "POST",
    body: JSON.stringify({ response, ...rp() }),
  });
}

export function deleteMyPasskey(id: string): Promise<{ deleted: string }> {
  return request(`/users/me/passkeys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
