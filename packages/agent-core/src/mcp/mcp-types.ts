/** 工具权限三档：允许（直接执行）/ 需审批（走 HITL interruptOn）/ 禁用（不注入）。 */
export type ToolPermission = 'allow' | 'ask' | 'deny';

export const TOOL_PERMISSIONS: readonly ToolPermission[] = [
  'allow',
  'ask',
  'deny',
];

export type McpServerStatus =
  | 'disconnected'
  | 'connected'
  | 'needs_auth'
  | 'error';

/** MCP Apps 规范的工具可见性：model = 进模型工具表；app = 可被 App（iframe）调用。 */
export type ToolVisibility = 'model' | 'app';

/**
 * tools/list 的一条快照（McpServer.tools 存的就是它的数组）。
 * 原始 inputSchema 留着给设置页展示 / App 调用；modelSchema 是清洗后喂给模型的版本，
 * null = 清洗不了（不兼容），这个工具不注入 agent。
 */
export interface McpToolSnapshot {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  modelSchema: Record<string, unknown> | null;
  incompatibleReason?: string;
  readOnly: boolean;
  destructive: boolean;
  /** MCP App 的 UI 资源（ui://…）；没有 = 普通工具 */
  uiResourceUri?: string;
  visibility: ToolVisibility[];
}

/** initialize 返回的 serverInfo 里我们关心的部分。 */
export interface McpServerInfo {
  name: string;
  title?: string;
  version?: string;
  websiteUrl?: string;
  description?: string;
  iconUrl?: string;
}

/**
 * MCP 工具结果里交给前端渲染 App 卡片的部分（随 tool_end 落库，刷新可重建）。
 * toolResult 是完整的 CallToolResult（含 structuredContent / _meta），只给 UI，不进模型上下文。
 */
export interface McpAppArtifact {
  serverId: string;
  serverName: string;
  toolName: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown>;
}

/** token 失效且刷新失败时，工具结果里带这个，前端渲染「重新连接」卡片。 */
export interface McpAuthRequiredArtifact {
  serverId: string;
  serverName: string;
}

export interface McpToolArtifact {
  mcpApp?: McpAppArtifact;
  mcpAuthRequired?: McpAuthRequiredArtifact;
}

/** 工具的生效权限：用户覆盖优先；没设则只读工具默认允许、其余默认需审批。 */
export function effectivePermission(
  tool: Pick<McpToolSnapshot, 'name' | 'readOnly'>,
  overrides: Record<string, ToolPermission> | null | undefined,
): ToolPermission {
  return overrides?.[tool.name] ?? (tool.readOnly ? 'allow' : 'ask');
}

/** 运行期给 agent 装配工具用的连接器快照（只含已启用、已连接的）。 */
export interface RuntimeServer {
  id: string;
  slug: string;
  name: string;
  instructions: string | null;
  tools: McpToolSnapshot[];
  permissions: Record<string, ToolPermission>;
}

/** token 失效且无法刷新：调用方转成「需要重新连接」。 */
export class McpAuthRequiredError extends Error {
  constructor(
    readonly serverId: string,
    readonly serverName: string,
  ) {
    super(`${serverName} needs to be reconnected`);
  }
}
