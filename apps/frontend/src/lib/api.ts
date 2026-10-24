import { signOut } from "next-auth/react";

import { safeNextPath } from "@/lib/safe-next";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3101";

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

let redirectingToLogin = false;

/**
 * 后端 401（缺 token / JWT 过期或验签失败）：next-auth 会话还在但 backendToken 已不可用，
 * middleware 仍当已登录放行，只能由这里兜底——清掉会话再整页跳 /login，带上当前页作 next。
 * 并发请求可能同时 401，只跳一次。
 */
function redirectToLogin() {
  if (redirectingToLogin || typeof window === "undefined") return;
  redirectingToLogin = true;
  const { pathname, search } = window.location;
  const next = safeNextPath(pathname + search);
  const target = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  void signOut({ redirect: false }).finally(() => {
    window.location.href = target;
  });
}

/** 统一请求：Authorization header 由 middleware 注入；解析 {code,message,data}。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // 经 ngrok 隧道时跳过 free 版浏览器拦截页，避免接口返回 HTML
      "ngrok-skip-browser-warning": "1",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) redirectToLogin();
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
  /** 用户重命名的标题；null = 未命名（界面回退显示 goal） */
  title: string | null;
  status: string;
  messages: ConversationMessage[];
  /** 会话累计 token（顶栏徽标基底；运行期由 token_usage 事件覆盖） */
  totalTokens: number;
}

/** 侧栏列表项（GET /conversations，不含 messages）。 */
export interface ConversationListItem {
  id: string;
  goal: string;
  /** 用户重命名的标题；null = 未命名（界面回退显示 goal） */
  title: string | null;
  status: string;
  createdAt: string;
  /** 置顶时刻；null = 未置顶 */
  pinnedAt: string | null;
}

/** 创建空会话（idle，不带首条消息、不触发运行）：先建会话再进入，首条消息走 appendMessage。 */
export function createEmptyConversation(
  model?: string,
  thinkingLevel?: string,
): Promise<{ conversationId: string }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ model, thinkingLevel }),
  });
}

export function listConversations(): Promise<ConversationListItem[]> {
  return request("/conversations");
}

/** 技能分类：内置（随系统发布）、GitHub 安装、用户手写。与后端 SkillKind 对应。 */
export type SkillKind = "builtin" | "github" | "custom";

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

/** Spark 会话的 token 用量报表：总计 + 按模型 + 按轮（一轮 = 一条用户消息）。 */
export function getConversationTokenUsage(id: string): Promise<TokenReport> {
  return request(`/conversations/${id}/token-usage`);
}

/**
 * 在已有会话里追加一条用户消息，触发同 thread_id 续跑（多轮）。
 * attachmentVersionIds：随消息发出的上传附件（uploadAttachment 返回的 versionId）；带附件时 content 可为空。
 */
export function appendMessage(
  id: string,
  content: string,
  model?: string,
  thinkingLevel?: string,
  attachmentVersionIds?: string[],
): Promise<{ conversationId: string }> {
  return request(`/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, model, thinkingLevel, attachmentVersionIds }),
  });
}

/** 附件类型：生成只有 image / video，上传多一个 audio（只当生成素材引用）。 */
export type AttachmentType = "image" | "video" | "audio";

/** 用户消息里的一个附件（后端存进 message.content.attachments，CDN 地址可直接展示）。 */
export interface MessageAttachment {
  versionId: string;
  type: AttachmentType;
  url: string;
  filename: string;
  contentType: string;
}

/** 上传成功的返回：暂存（staged）资产，随下一条消息的 attachmentVersionIds 发出时才转正。 */
export interface UploadedAttachment extends MessageAttachment {
  generationId: string;
  size: number;
}

/**
 * 上传一个附件：文件二进制原样作请求体，经同源路由 /api/uploads/:id 流式转给后端，
 * 后端再按 aigc 预签名地址 PUT 到 GCS。用 XHR 而不是 fetch：要上传进度（fetch 拿不到）。
 * 不走 /api-backend：那条路径的 middleware 会把 >10MB 的请求体截断（见路由文件注释）。
 */
export function uploadAttachment(
  conversationId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/uploads/${encodeURIComponent(conversationId)}?filename=${encodeURIComponent(file.name)}`,
    );
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) redirectToLogin();
      let body: ApiEnvelope<UploadedAttachment>;
      try {
        body = JSON.parse(xhr.responseText) as ApiEnvelope<UploadedAttachment>;
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
        return;
      }
      if (body.code !== 0) {
        reject(new Error(body.message || `Upload failed (${xhr.status})`));
        return;
      }
      resolve(body.data);
    };
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** 主动停止当前运行（幂等；stopped 表示本次是否实际停掉了什么）。 */
export function stopConversation(id: string): Promise<{ stopped: boolean }> {
  return request(`/conversations/${id}/stop`, { method: "POST" });
}

/** 置顶 / 取消置顶。 */
export function setConversationPinned(
  id: string,
  pinned: boolean,
): Promise<{ id: string; pinnedAt: string | null }> {
  return request(`/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ pinned }),
  });
}

/** 重命名会话；空串 = 清除自定义标题，回退显示首条消息。 */
export function renameConversation(
  id: string,
  title: string,
): Promise<{ id: string; title: string | null }> {
  return request(`/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** 删除会话（后端软删除；运行中的会先停止）。 */
export function deleteConversation(id: string): Promise<{ deleted: true }> {
  return request(`/conversations/${id}`, { method: "DELETE" });
}

// ——— 沙箱状态 ———

/** GET /sandbox/status（user 级只读，不唤醒停机沙箱）。 */
export interface SandboxStatus {
  exists: boolean;
  /** 沙箱提供方（用户在 /settings/sandbox 的选择，未选则为服务端默认） */
  provider?: SandboxProviderName;
  /** 当前提供方是否支持图形桌面（E2B 不支持） */
  desktopSupported?: boolean;
  id?: string;
  state?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  autoStopMinutes?: number | null;
  autoDeleteMinutes?: number | null;
  /** 规格：vCPU 数 / 内存 MB / 磁盘 GB（取不到为 null，如 E2B 不报磁盘） */
  cpuCount?: number | null;
  memoryMB?: number | null;
  diskGB?: number | null;
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

/** 主动开机：停机的拉起、没有的新建，返回开机后的状态（E2B 秒级，Daytona 可能要几十秒）。 */
export function startSandbox(): Promise<SandboxStatus> {
  return request("/sandbox/start", { method: "POST" });
}

export type SandboxProviderName = "daytona" | "e2b";

/** 沙箱生命周期：闲置停机/暂停分钟数；停机后自动删除分钟数（-1 = 永不，仅 Daytona）。 */
export interface SandboxLifecycle {
  idleMinutes: number;
  autoDeleteMinutes: number;
}

/** 出站网络：open 全放行 / allowlist 仅白名单 / blocked 全禁止。 */
export type SandboxEgressMode = "open" | "allowlist" | "blocked";

/** 沙箱网络设置。publicTraffic = 端口公网地址免鉴权（仅 E2B，创建时生效）。 */
export interface SandboxNetwork {
  egress: SandboxEgressMode;
  allowList: string[];
  publicTraffic: boolean;
}

/** GET/PATCH /sandbox/settings：沙箱设置（/settings/sandbox 页面用）。 */
export interface SandboxSettings {
  /** 实际生效的提供方 */
  current: SandboxProviderName;
  /** 用户显式选择；null = 跟随服务端默认 */
  preference: SandboxProviderName | null;
  /** 服务端默认（env SANDBOX_PROVIDER） */
  default: SandboxProviderName;
  providers: {
    name: SandboxProviderName;
    configured: boolean;
    desktopSupported: boolean;
    supportsAutoDelete: boolean;
    /** 能按沙箱设置出站规则（Daytona Tier 1–2 不能：出站由 Daytona 组织策略决定） */
    supportsEgressControl: boolean;
    /** 出站白名单支持域名（Daytona 只支持 IP/CIDR） */
    supportsDomainAllowList: boolean;
    /** 可配置端口公网地址免鉴权（仅 E2B） */
    supportsPublicTrafficToggle: boolean;
  }[];
  lifecycle: SandboxLifecycle;
  lifecycleDefaults: SandboxLifecycle;
  network: SandboxNetwork;
  networkDefaults: SandboxNetwork;
  /** 现有沙箱端口公网地址是否免鉴权（实际值；入站设置只在创建时生效）。无沙箱为 null */
  currentPublicTraffic: boolean | null;
  /** 仅改了出站设置的 PATCH 返回：applied 已生效 / pending 下次运行时同步 / failed 应用失败 */
  egressSync?: "applied" | "pending" | "failed";
}

/** PATCH 局部更新：未传字段保持不变；provider 传 null = 跟随服务端默认。 */
export interface SandboxSettingsPatch {
  provider?: SandboxProviderName | null;
  idleMinutes?: number;
  autoDeleteMinutes?: number;
  egressMode?: SandboxEgressMode;
  /** 整体替换白名单 */
  allowList?: string[];
  publicTraffic?: boolean;
}

export function fetchSandboxSettings(): Promise<SandboxSettings> {
  return request("/sandbox/settings");
}

export function updateSandboxSettings(patch: SandboxSettingsPatch): Promise<SandboxSettings> {
  return request("/sandbox/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** POST /sandbox/desktop：启动图形桌面（幂等），返回 noVNC iframe 地址。 */
export function startSandboxDesktop(): Promise<{ url: string }> {
  return request<{ url: string }>("/sandbox/desktop", { method: "POST" });
}

/** DELETE /sandbox/desktop：停止图形桌面（Dialog 关闭时 fire-and-forget）。 */
export function stopSandboxDesktop(): Promise<void> {
  return request<void>("/sandbox/desktop", { method: "DELETE" });
}

/** 工作区目录树的一层子项（GET /sandbox/dir，按目录懒加载）。 */
export interface SandboxDirEntry {
  name: string;
  /** 相对工作区根的虚拟路径（点目录时回传以列下一层；点文件时传给 /sandbox/file） */
  path: string;
  isDir: boolean;
  size: number;
}

/** GET /sandbox/dir?path=：列出某目录直接子项（path 缺省=根）。 */
export function fetchSandboxDir(
  path = "",
): Promise<{ entries: SandboxDirEntry[] }> {
  return request(
    `/sandbox/dir${path ? `?path=${encodeURIComponent(path)}` : ""}`,
  );
}

/** 单个文件的预览负载（GET /sandbox/file）：文本/图片/不可预览二进制三态。 */
export type SandboxFilePreview =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; dataUrl: string; mimeType: string }
  | { kind: "binary"; size: number };

/** GET /sandbox/file?path=：读取单个文件用于预览。 */
export function fetchSandboxFile(path: string): Promise<SandboxFilePreview> {
  return request(`/sandbox/file?path=${encodeURIComponent(path)}`);
}

/**
 * GET /sandbox/file/raw：文件原始字节 URL，直接给 <video>/<audio> src 或下载链接用。
 * 走同源反代（/api-backend），middleware 从登录 session 注入 Authorization，无需手动带 token。
 * download=true → 后端返回 attachment，浏览器直接保存。
 */
export function sandboxFileRawUrl(path: string, download = false): string {
  return `${API_BASE}/sandbox/file/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

/** 预览签发结果：id 用于重置 / 心跳，url 直接作 iframe src。 */
export interface PreviewGrant {
  id: string;
  url: string;
}

/**
 * POST /preview/file：为工作区里的 HTML 入口签发静态网页预览地址。返回的是后端子域名
 * 反代的完整地址（p-<id>.<基域名>/<入口文件名>，与主站不同源），直接作 iframe src；
 * 页面里的相对引用 js/css 落在同一预览站点下。24 小时内重复打开同一页面拿到的是同一地址
 * （同一个源），页面的 localStorage 等存储得以保留。
 */
export function createFilePreview(path: string): Promise<PreviewGrant> {
  return request<PreviewGrant>("/preview/file", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/**
 * POST /preview/port：为沙箱里运行中的 web 服务签发预览地址。返回的是后端子域名反代的
 * 完整地址（p-<id>.<基域名>，与主站不同源），直接作 iframe src，不再拼 API_BASE。
 */
export function createPortPreview(
  port: number,
  path = "/",
): Promise<PreviewGrant> {
  return request<PreviewGrant>("/preview/port", {
    method: "POST",
    body: JSON.stringify({ port, path }),
  });
}

/** DELETE /preview/:id：重置预览——当前地址立即失效，下次打开换新地址（旧存储不再使用）。 */
export function revokePreview(id: string): Promise<{ revoked: true }> {
  return request<{ revoked: true }>(`/preview/${id}`, { method: "DELETE" });
}

/** POST /preview/:id/keepalive：预览弹窗打开期间的心跳，让沙箱别在用户操作中途停机。 */
export function keepAlivePreview(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/preview/${id}/keepalive`, { method: "POST" });
}

// ——— 生图/生视频/配音 媒体 ———

/** audio = 配音（generate_audio）；voice = 克隆音色（clone_voice，产物也是一段音频）。 */
export type MediaType = "image" | "video" | "audio" | "voice";
/** cancelled = 用户停止 / aigc 侧取消（与生成失败分开展示）。 */
export type MediaStatus = "queued" | "generating" | "done" | "failed" | "cancelled";

/** 一次生成尝试（版本）。重新生成在同一 generation 下叠新 version，旧版永不删除。 */
export interface MediaVersion {
  id: string;
  prompt: string;
  model: string;
  /** aigc 渠道；本地拼接产物为 null。 */
  channel: string | null;
  /** 实际提交的档位（aspect_ratio / resolution / duration / with_audio …）；拼接产物为 null。 */
  params: Record<string, string> | null;
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
  /** 用户上传的音频也是 audio（不会挂成卡片，卡片只渲染生成工具产出的 generationId） */
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
 * 先问来源：aigc 产物存的是 CDN 地址（公开、CORS 放行），直接从 CDN 取；
 * 只有本地文件的（拼接产物 / 未回填的历史版本）再走 asset 路由。
 * 取 CDN 时不带任何自定义头：CDN 的 preflight 不放行自定义头（如 ngrok-skip-browser-warning）。
 * asset 路由用 StreamableFile 原样返回二进制（不裹 {code,message,data}），
 * 故不能走 request() 的 JSON 解析路径——这里手动 fetch、带 Authorization、读 Blob。
 */
export async function fetchMediaAssetBlob(versionId: string): Promise<Blob> {
  const { url } = await request<{ url: string | null }>(
    `/media/versions/${versionId}/source`,
  );
  if (url) {
    const cdn = await fetch(url);
    if (!cdn.ok) throw new Error(`Failed to load asset (${cdn.status})`);
    return cdn.blob();
  }
  const res = await fetch(`${API_BASE}/media/versions/${versionId}/asset`, {
    headers: {
      "ngrok-skip-browser-warning": "1",
    },
  });
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw new Error(`Failed to load asset (${res.status})`);
  }
  return res.blob();
}

// ——— 画布工作流 ———

/**
 * 敏感操作审批模式（镜像后端 canvas.types）。
 * review：破坏性/消耗性操作暂停等确认；auto：全自动，不打断。
 */
export type CanvasApprovalMode = "review" | "auto";

export type CanvasNodeType =
  | "image_upload"
  | "image_gen"
  | "video_gen"
  | "video_concat";

/**
 * 节点端口上流动的资源类型（镜像后端 canvas.types）。
 * 没有 text——提示词是生成节点自己的 prompt 字段，不是端口上流动的资源。
 */
export type CanvasIoType = "image" | "video";

/**
 * 节点的一份输出（镜像后端 canvas.types）。content 语义随 type：
 * image/video → mediaVersionId；image_upload 破例存 assetPath。
 */
export interface CanvasNodeOutput {
  type: CanvasIoType;
  content: string;
}

export interface CanvasNodeDto {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  version: number;
  label: string | null;
  /** 生成节点的提示词（image_gen / video_gen 自己的字段）。 */
  prompt: string | null;
  assetPath: string | null;
  mediaGenerationId: string | null;
  /**
   * 生成节点选定的 aigc 渠道 / 模型别名 / 档位参数（image_gen、video_gen 专有）。
   * 三者都为空 = 用该类型的默认模型（GET /aigc/models 返回的 default）。
   */
  mediaChannel: string | null;
  mediaModel: string | null;
  mediaParams: Record<string, string> | null;
  mediaVersionId: string | null;
  mediaStatus: string | null;
  /** 可供下游消费的输出（服务端派生）。⚠️ patch 里生成节点的这项恒为空，见 canvas-state 的 upsertNode */
  outputs: CanvasNodeOutput[];
}

export interface CanvasEdgeDto {
  id: string;
  source: string;
  target: string;
}

export interface CanvasSnapshot {
  id: string;
  title: string;
  status: string;
  model: string | null;
  /** 思考深度档位（auto|off|on|low|medium|high）；null = 跟随模型默认。 */
  thinkingLevel: string | null;
  /** 敏感操作审批模式（后端已归一化，恒有值） */
  approvalMode: CanvasApprovalMode;
  revision: number;
  /** 会话累计 token（后端 run 聚合的持久化口径；实时增量由 token_usage 事件覆盖） */
  totalTokens: number;
  /** 「加入对话」圈定的节点 id；非空时 agent 只看这些节点，空数组 = 整块画布 */
  focusNodeIds: string[];
  nodes: CanvasNodeDto[];
  edges: CanvasEdgeDto[];
}

export interface CanvasListItem {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  /** 置顶时刻；null = 未置顶（列表里置顶的排在前面） */
  pinnedAt: string | null;
}

export interface CanvasMessage {
  id: string;
  role: string;
  type: string;
  content: unknown;
  seq: number;
}

/** 画布结构变更 op（用户空闲期编辑；agent 侧走工具，不经此）。 */
export type CanvasOpInput =
  | {
      op: "add_node";
      type: CanvasNodeType;
      x?: number;
      y?: number;
      label?: string;
      text?: string;
      prompt?: string;
      assetPath?: string;
    }
  | {
      op: "update_node";
      nodeId: string;
      label?: string;
      text?: string;
      prompt?: string;
      /** 生成节点的模型选择（面板上改模型/档位时走这三个字段） */
      mediaChannel?: string;
      mediaModel?: string;
      mediaParams?: Record<string, string>;
    }
  | { op: "remove_node"; nodeId: string }
  | { op: "add_edge"; source: string; target: string }
  | { op: "remove_edge"; edgeId: string };

export function createCanvas(input: {
  goal?: string;
  title?: string;
  model?: string;
  thinkingLevel?: string;
}): Promise<{ sessionId: string }> {
  return request("/canvas", { method: "POST", body: JSON.stringify(input) });
}

/** 画布列表（cursor 分页）：cursor 传上一页 nextCursor；nextCursor=null 表示没有更多。 */
export function listCanvases(
  cursor?: string,
): Promise<{ items: CanvasListItem[]; nextCursor: string | null }> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(`/canvas${q}`);
}

export function renameCanvas(
  id: string,
  title: string,
): Promise<{ id: string; title: string }> {
  return request(`/canvas/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** 画布列表置顶 / 取消置顶（不改「最近更新」时间）。 */
export function setCanvasPinned(
  id: string,
  pinned: boolean,
): Promise<{ id: string; title: string; pinnedAt: string | null }> {
  return request(`/canvas/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ pinned }),
  });
}

export function getCanvasSnapshot(id: string): Promise<CanvasSnapshot> {
  return request(`/canvas/${id}`);
}

export function getCanvasMessages(id: string): Promise<CanvasMessage[]> {
  return request(`/canvas/${id}/messages`);
}

/**
 * token 用量报表（镜像后端 agent/token-usage，画布与 Spark 对话共用）。
 * 口径：cacheRead / cacheCreation 都是 input 的子集（provider 的 input_tokens 已含缓存部分），
 * 所以缓存命中率 = cacheRead / input。
 */
export interface TokenTotals {
  /** 模型调用次数 */
  calls: number;
  input: number;
  output: number;
  /** 思考 token = total − input − output（Gemini 只把思考记进 total；DeepSeek 恒为 0） */
  reasoning: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TokenModelUsage extends TokenTotals {
  model: string;
}

export interface TokenCall {
  id: string;
  model: string;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
  at: string;
}

/** 一轮的用量（Spark 的一轮 = 一条用户消息；画布另带 run 状态与请求模型）。 */
export interface TokenRun {
  runId: string;
  goal: string;
  startedAt: string;
  endedAt: string | null;
  /** 运行状态（仅画布有 Run 记录） */
  status?: string;
  totals: TokenTotals;
  byModel: TokenModelUsage[];
  calls: TokenCall[];
}

export interface TokenReport {
  totals: TokenTotals;
  byModel: TokenModelUsage[];
  /** 按轮倒序（最新一轮在前） */
  runs: TokenRun[];
}

// 画布侧沿用的旧名（类型本体即上面的共用定义）
export type CanvasTokenTotals = TokenTotals;
export type CanvasTokenModelUsage = TokenModelUsage;
export type CanvasTokenCall = TokenCall;

export interface CanvasTokenRun extends TokenRun {
  /** 本轮请求的模型；真实调用模型见 byModel / calls */
  requestedModel: string | null;
  status: string;
}

export interface CanvasTokenReport extends TokenReport {
  runs: CanvasTokenRun[];
}

export function getCanvasTokenUsage(id: string): Promise<CanvasTokenReport> {
  return request(`/canvas/${id}/token-usage`);
}

/**
 * 清空会话记录与 agent 上下文（DELETE /canvas/:id/messages）。
 * 节点/连线与 token 统计保留；运行期后端会拒绝（CANVAS_BUSY）。
 */
export function clearCanvasMessages(id: string): Promise<{ cleared: true }> {
  return request(`/canvas/${id}/messages`, { method: "DELETE" });
}

/**
 * 手动作废当前任务计划（DELETE /canvas/:id/plan）。
 * 计划面板随之消失，后续对话不再受这份计划影响（提示词注入与历史重放都会跳过它）。
 */
export function clearCanvasPlan(id: string): Promise<{ cleared: true }> {
  return request(`/canvas/${id}/plan`, { method: "DELETE" });
}

export function appendCanvasMessage(
  id: string,
  content: string,
  model?: string,
  thinkingLevel?: string,
  approvalMode?: string,
): Promise<{ sessionId: string }> {
  return request(`/canvas/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, model, thinkingLevel, approvalMode }),
  });
}

/**
 * 设置 /（传空数组）清空「加入对话」的节点圈选。会话级持续生效，不随单条消息。
 * 之后注入给 agent 的画布状态只列这些节点，直到用户取消。
 */
export function setCanvasFocus(
  id: string,
  nodeIds: string[],
): Promise<{ focusNodeIds: string[] }> {
  return request(`/canvas/${id}/focus`, {
    method: "POST",
    body: JSON.stringify({ nodeIds }),
  });
}

export function stopCanvas(id: string): Promise<{ stopped: boolean }> {
  return request(`/canvas/${id}/stop`, { method: "POST" });
}

/**
 * 一次原子结构变更（镜像后端 CanvasPatch）：既是 canvas_patch 事件的 payload，
 * 也是 applyCanvasOp 的返回内容——新建节点时要从这里取服务端分配的 id 来接线。
 */
export type CanvasPatch =
  | { op: "add_node"; node: CanvasNodeDto; revision: number }
  | { op: "update_node"; node: CanvasNodeDto; revision: number }
  | { op: "move_node"; nodeId: string; x: number; y: number }
  | { op: "remove_node"; nodeId: string; revision: number }
  | { op: "add_edge"; edge: CanvasEdgeDto; revision: number }
  | { op: "remove_edge"; edgeId: string; revision: number }
  | { op: "clear"; revision: number };

/**
 * 手动触发 video_concat 节点的拼接。素材按入边顺序取（与卡片预览顺序同源），
 * 产出一个 MediaVersion——之后的状态/资产与生成节点走同一条路。
 */
/**
 * aigc 能力目录（镜像后端 aigc/aigc.types 的 AigcCatalog）。
 * 模型清单与档位取值一律以本接口为准，前端不硬编码——后台随时会加减模型。
 */
export interface AigcParamOption {
  label: string;
  value: string;
}

export interface AigcModelParam {
  param_type: string;
  label?: string;
  /** required 必传 / optional 可不传 / derived 服务端推导（不是入参，不渲染） */
  input?: string;
  /** select 或缺省 = 从 options 里选；range 是连续区间（当前只出现在音频维度） */
  value_type?: string;
  options: AigcParamOption[];
}

/**
 * 档位间的联动规则（aigc 目录原样透出）：`when` 全部命中时，`forbid` 的维度不能传，
 * `allow` 的维度只能取其中的值。`when` 里也会引用 derived 维度（有没有参考图等）。
 */
export interface AigcConstraint {
  when: Record<string, string[]>;
  allow?: Record<string, string[]>;
  forbid?: string[];
}

export interface AigcModel {
  model_alias: string;
  identifier?: string;
  display_name?: string;
  type: string;
  image_input_number: number;
  params: AigcModelParam[];
  constraints: AigcConstraint[];
  /** 视频模型的参考图以什么 role 提交（我方按模型名单推出，见后端 videoRefRole） */
  ref_role?: "reference" | "first_frame" | "last_frame";
}

export interface AigcChannelModels {
  channel: string;
  models: AigcModel[];
}

/** 一次生成的模型选择：渠道 + 模型别名 + 档位（键是 param_type，值是 options[].value）。 */
export interface AigcMediaConfig {
  channel: string;
  model: string;
  params: Record<string, string>;
}

export interface AigcCatalog {
  type: "image" | "video";
  channels: AigcChannelModels[];
  /** 默认模型（目录第一个 + 各必填维度第一个取值）；目录为空时为 null */
  default: AigcMediaConfig | null;
}

/** 可选模型清单（经本服务转发 aigc 的 GET /channels，前端不直连 aigc）。 */
export function listAigcModels(type: "image" | "video"): Promise<AigcCatalog> {
  return request(`/aigc/models?type=${type}`);
}

/**
 * 手动触发某个 image_gen / video_gen 节点的生成（卡片面板上的 Generate）。
 * 用节点上选定的模型；提示词与参考图由服务端按入边收集。
 */
export function generateCanvasNode(
  id: string,
  nodeId: string,
): Promise<{ generationId: string }> {
  return request(`/canvas/${id}/nodes/${nodeId}/generate`, { method: "POST" });
}

export function mergeCanvasVideoNode(
  id: string,
  nodeId: string,
): Promise<{ generationId: string }> {
  return request(`/canvas/${id}/nodes/${nodeId}/merge`, { method: "POST" });
}

/** 用户结构编辑：带 baseRevision 做乐观并发；运行期后端拒绝（CANVAS_BUSY）。 */
export function applyCanvasOp(
  id: string,
  op: CanvasOpInput,
  baseRevision: number,
): Promise<{ revision: number; patch: CanvasPatch }> {
  return request(`/canvas/${id}/ops`, {
    method: "POST",
    body: JSON.stringify({ op, baseRevision }),
  });
}

/** 节点位置更新（LWW）。 */
export function moveCanvasNode(
  id: string,
  nodeId: string,
  x: number,
  y: number,
): Promise<void> {
  return request(`/canvas/${id}/nodes/${nodeId}/move`, {
    method: "POST",
    body: JSON.stringify({ x, y }),
  });
}

// ——— 画布技能（canvas agent 专用，与主 agent 的 /skills 分开） ———

/** 画布技能列表条目（GET /canvas-skills）。builtin 不能删除、不能停用。 */
export interface CanvasSkillInfo {
  name: string;
  description: string;
  kind: "builtin" | "user";
  enabled: boolean;
  /** 用户技能的最后修改时间（ISO）；内置为 null */
  updatedAt: string | null;
}

/** 画布技能详情：文件路径列表 + SKILL.md 原文 */
export interface CanvasSkillDetail extends CanvasSkillInfo {
  files: string[];
  content: string;
}

export function listCanvasSkills(): Promise<CanvasSkillInfo[]> {
  return request("/canvas-skills");
}

export function getCanvasSkill(name: string): Promise<CanvasSkillDetail> {
  return request(`/canvas-skills/${encodeURIComponent(name)}`);
}

export function setCanvasSkillEnabled(
  name: string,
  enabled: boolean,
): Promise<{ name: string; enabled: boolean }> {
  return request(`/canvas-skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteCanvasSkill(name: string): Promise<unknown> {
  return request(`/canvas-skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
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

/** 技能详情（GET /skills/:name）：文件路径列表 + SKILL.md 原文 + 去掉 frontmatter 的正文。 */
export interface SkillDetail extends SkillInfo {
  files: string[];
  skillMd: string;
  body: string;
}

/** 手写技能的表单内容：说明写进 frontmatter，正文是 SKILL.md 的 Markdown 主体。 */
export interface CustomSkillInput {
  description: string;
  body: string;
}

/** 新建手写技能（名字被内置 / 已有技能占用时后端拒绝）。 */
export function createCustomSkill(
  input: CustomSkillInput & { name: string },
): Promise<SkillInfo> {
  return request("/skills/custom", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 修改手写技能的说明与正文（名字不可改）。 */
export function updateCustomSkill(
  name: string,
  input: CustomSkillInput,
): Promise<SkillInfo> {
  return request(`/skills/custom/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
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

/** 已注册 passkey。transports 为逗号拼接串可为 null；providerName 由后端解析。 */
export interface MyPasskey {
  id: string;
  createdAt: string;
  transports: string | null;
  /** 后端按 aaguid 解析出的来源名，如 "iCloud 钥匙串"；兜底 "云同步 passkey" / "设备 passkey" / "Passkey"。 */
  providerName: string;
  /** "singleDevice" | "multiDevice" | null */
  deviceType: string | null;
  backedUp: boolean;
  /** 最后一次用此 passkey 登录的时间；从未使用为 null。 */
  lastUsedAt: string | null;
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

// ——— OTP Verification Code ———

export function sendOtpCode(email: string): Promise<{ success: boolean; code?: string }> {
  return request("/auth/send-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}
