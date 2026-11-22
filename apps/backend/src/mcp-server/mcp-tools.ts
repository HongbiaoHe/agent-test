import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { createCanvasTools as createSharedCanvasTools } from '@agent-test/agent-core/canvas/canvas-tools';
import { CANVAS_LOCK_RENEW_MS } from '@agent-test/canvas-schema';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import type { McpCanvasService } from './mcp-canvas.service';
import {
  WAIT_ACCEPT_MAX_S,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
} from './mcp-canvas.service';
import { toPublicError } from './mcp-errors';
import type { McpPrincipal } from './mcp-grant.service';
import type { McpScope } from './mcp-server.config';

/**
 * 每个请求按令牌的 scope 装一个 McpServer（无状态）：没授权的工具根本不注册，模型看不到也就不会去撞权限错误。
 *
 * 画布工具的名字 / 入参 / 行为全部复用 agent-core（与服务端画布 agent、desktop 本机 agent 同一份），
 * 这里只做三件事：入参加 canvasId、写操作前上隐式锁、按 MCP 的调用方式改写描述。
 */

/** 共享画布工具各属哪个 scope；新增共享工具没登记时按 canvas:write 处理（单测会提醒补上） */
export const SHARED_TOOL_SCOPES: Record<string, McpScope> = {
  list_media_models: 'canvas:read',
  add_node: 'canvas:write',
  add_nodes: 'canvas:write',
  update_node: 'canvas:write',
  update_nodes: 'canvas:write',
  connect_nodes: 'canvas:write',
  delete_node: 'canvas:write',
  set_node_model: 'canvas:write',
  set_clip_order: 'canvas:write',
  clear_canvas: 'canvas:write',
  generate_media_node: 'media:generate',
  merge_video_node: 'media:generate',
};

const DESTRUCTIVE = new Set(['delete_node', 'clear_canvas']);
const OPEN_WORLD = new Set(['generate_media_node', 'merge_video_node']);

/**
 * 共享描述是写给「一条 AI 消息里并行发多个工具调用」的画布 agent 的；MCP 下每次调用是独立请求、
 * 没有「同一步」的概念，相关说法要换掉，附件的来源也换成 import_asset。
 */
const DESCRIPTION_REWRITES: [RegExp, string][] = [
  [/（同一步里按调用先后）/g, '（请逐条调用、等上一条返回再连下一条）'],
  [
    /同一步里一起调用的 generate_media_node[^。]*。/g,
    '有依赖的多个节点请按上下游顺序逐个调用（上游触发后立即返回 queued，即可接着触发下游）。',
  ],
  [
    /可与上游的 generate_media_node 在同一步里一起调用（自动按依赖排序）。/g,
    '',
  ],
  [/上游既没在同一步触发、之前也没触发过/g, '上游之前没触发过'],
  [/用户在对话里发的附件/g, '外部素材（先用 import_asset 导入）'],
  [/（取自用户消息的「\[附件\]」清单）/g, '（取自 import_asset 的返回值）'],
  [/此操作有破坏性，会先请用户确认再执行。/g, '此操作有破坏性，不可撤销。'],
];

/**
 * 批量工具（add_nodes / update_nodes / set_clip_order）每次最多几项。实测 add_nodes 每个节点 2.5~10ms
 * （画布越大越慢），不设上限时单次调用能跑过 60 秒锁 TTL 与主站反代的 30 秒超时；500 项约 1~5 秒。
 */
export const MCP_BATCH_MAX = 500;

const MCP_NOTE = `\n\n[MCP] 必须传 canvasId。节点 id 用 get_canvas 列出的 6 位短 id 或完整 id。批量参数每次最多 ${MCP_BATCH_MAX} 项，更多请分批调用。`;

export function adaptDescription(description: string): string {
  let d = description;
  for (const [re, to] of DESCRIPTION_REWRITES) d = d.replace(re, to);
  return d + MCP_NOTE;
}

function annotationsFor(name: string, scope: McpScope): ToolAnnotations {
  if (scope === 'canvas:read') {
    return { readOnlyHint: true, openWorldHint: false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE.has(name),
    openWorldHint: OPEN_WORLD.has(name),
  };
}

const text = (s: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(isError ? { isError: true } : {}),
});
const json = (v: unknown): CallToolResult => text(JSON.stringify(v));

/**
 * 业务拒绝（画布不存在 / 正忙 / 下载失败…）回一句话给模型；其它异常记日志、只回通用说法
 * （交给 SDK 兜的话会把异常原文——含服务端文件路径与源码行——发给第三方）。
 * 调用被取消（signal 已中止）不是故障：直接回「已取消」，不记错误日志。
 */
async function guarded(
  run: () => Promise<CallToolResult>,
  signal?: AbortSignal,
) {
  try {
    return await run();
  } catch (e) {
    if (signal?.aborted) {
      return text(JSON.stringify({ error: CANCELLED_MESSAGE }), true);
    }
    const pub = toPublicError(e);
    if (pub instanceof BusinessException) {
      return text(JSON.stringify({ error: pub.getResponse() }), true);
    }
    return text(JSON.stringify({ error: pub.message }), true);
  }
}

const CANCELLED_MESSAGE = '调用已取消';

/**
 * 写操作执行期间按 CANVAS_LOCK_RENEW_MS 续锁：锁只在调用开始时申请一次，一次调用若跑过 60 秒 TTL，
 * 别的 agent / 网页用户就能在它还在写的时候插进来。续不上（已被别人接手）就由下一次写入报 CANVAS_BUSY。
 */
async function withLockRenewal<T>(
  renew: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    renew().catch(() => undefined);
  }, CANVAS_LOCK_RENEW_MS);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

/** 共享 schema 里的数组参数加上 MCP_BATCH_MAX 上限（只影响 MCP，画布内置 agent 不变） */
function capArrays(schema: z.ZodObject<z.ZodRawShape>): z.ZodRawShape {
  const capped: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field instanceof z.ZodArray) capped[key] = field.max(MCP_BATCH_MAX);
  }
  return capped;
}

const canvasId = z
  .string()
  .min(1)
  .describe('画布 id（list_canvases / create_canvas 返回）');

/** 只取元数据用的一份共享工具（执行端恒不可用，绝不会被调用） */
const SHARED_TEMPLATE = createSharedCanvasTools(() =>
  Promise.resolve('template'),
);

/** 让用户看着 agent 干活：开始操作一块画布时先在预览里打开它（画布页实时同步每一次改动） */
const PREVIEW_HINT =
  '开始操作一块画布时（create_canvas 之后，或选定已有画布、第一次改它之前），先用你能用的预览面板 / 浏览器打开它的 canvasUrl，让用户实时看到你的每一步改动；同一块画布只需打开一次。没有预览能力就把 canvasUrl 发给用户。打开后若显示登录页，请用户在该页登录。';

const INSTRUCTIONS = [
  '这是一个可视化 AI 生成画布：节点是图片 / 视频的上传或生成步骤，连线表示上游素材流向下游。',
  '工作方式：先 list_canvases 或 create_canvas 拿到 canvasId，再 get_canvas 看现状（含放置安全区），然后增删改节点与连线。',
  PREVIEW_HINT,
  `生成是异步的：generate_media_node / merge_video_node 返回 generationId 后，用 wait_for_generations 等结果（单次最多等 ${WAIT_MAX_S} 秒，没完再调）。`,
  '相互依赖的调用请逐个进行、等上一个返回再调下一个。画布被别人占用时会返回 CANVAS_BUSY，稍后重试即可。',
].join('\n');

/**
 * @param abort 这次 HTTP 请求的中止信号（连接断开 / 客户端发来取消通知，见 McpServerHttp）。
 * 无状态部署下 SDK 自己的 extra.signal 收不到客户端的取消，两个一起听。
 */
export function buildCanvasMcpServer(
  svc: McpCanvasService,
  p: McpPrincipal,
  abort?: AbortSignal,
): McpServer {
  const server = new McpServer(
    { name: 'agent-test-canvas', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const can = (s: McpScope) => p.scopes.includes(s);
  /** 这次调用的中止信号：SDK 自己的（连接关闭）+ 本次 HTTP 请求的（客户端取消通知，见 McpServerHttp） */
  const signalOf = (extra: { signal: AbortSignal }) =>
    abort ? AbortSignal.any([extra.signal, abort]) : extra.signal;

  if (can('canvas:read')) {
    server.registerTool(
      'list_canvases',
      {
        description:
          '列出当前账号的画布（置顶在前、按最近更新排序，每页 30 条）。返回 items（每项带 canvasUrl）与 nextCursor（有下一页时传回 cursor 继续取）。选定要改的画布后，先用预览打开它的 canvasUrl。',
        inputSchema: { cursor: z.string().optional() },
        annotations: annotationsFor('list_canvases', 'canvas:read'),
      },
      ({ cursor }) =>
        guarded(async () => json(await svc.listCanvases(p, cursor))),
    );
    server.registerTool(
      'get_canvas',
      {
        description:
          '读取画布现状：state 是节点 / 连线 / 生成状态 / 放置安全区的文本（与画布内置 agent 看到的相同），media 列出每个生成 / 上传节点最新一版的 generationId、状态与产物 URL，canvasUrl 是这块画布的网页地址。改画布前先读一次；还没在预览里打开这块画布的话，先打开 canvasUrl。',
        inputSchema: { canvasId },
        annotations: annotationsFor('get_canvas', 'canvas:read'),
      },
      ({ canvasId: id }) =>
        guarded(async () => json(await svc.getCanvas(p, id))),
    );
    server.registerTool(
      'wait_for_generations',
      {
        description: `等待若干生成 / 拼接任务出结果（最多等 timeoutSeconds 秒，上限 ${WAIT_MAX_S}）。全部结束（done / failed / paused）或超时即返回；done=false 表示还有没结束的，可以再调一次。产物只给 URL。`,
        inputSchema: {
          canvasId,
          generationIds: z
            .array(z.string().min(1))
            .min(1)
            .max(20)
            .describe(
              'generate_media_node / merge_video_node 返回的 generationId',
            ),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(WAIT_ACCEPT_MAX_S)
            .optional()
            .describe(
              `默认 ${WAIT_DEFAULT_S}；单次最多实际等 ${WAIT_MAX_S} 秒，传更大按 ${WAIT_MAX_S} 算`,
            ),
        },
        annotations: annotationsFor('wait_for_generations', 'canvas:read'),
      },
      ({ canvasId: id, generationIds, timeoutSeconds }, extra) => {
        const signal = signalOf(extra);
        return guarded(
          async () =>
            json(
              await svc.waitForGenerations(
                p,
                id,
                generationIds,
                timeoutSeconds ?? WAIT_DEFAULT_S,
                signal,
              ),
            ),
          signal,
        );
      },
    );
  }

  if (can('canvas:write')) {
    server.registerTool(
      'create_canvas',
      {
        description:
          '新建一块空画布，返回 canvasId（后续工具都要带）与 canvasUrl。建好后先用你的预览面板 / 浏览器打开 canvasUrl，让用户实时看到你在画布上的操作。',
        inputSchema: { title: z.string().max(200).optional() },
        annotations: annotationsFor('create_canvas', 'canvas:write'),
      },
      ({ title }) =>
        guarded(async () => json(await svc.createCanvas(p, title))),
    );
    server.registerTool(
      'import_asset',
      {
        description:
          '把一个公网 https 地址的图片 / 视频 / 音频导入为这块画布的素材（jpeg/png/webp、mp4/mov、mp3/wav/m4a；图片 ≤20MB、视频 ≤200MB、音频 ≤50MB）。返回 versionId 与应使用的上传节点类型 uploadNodeType，再用 add_node 建该类型节点并传 versionId 放上画布。本地文件请先自行托管成 URL。',
        inputSchema: {
          canvasId,
          url: z.string().url().describe('https 地址'),
          filename: z
            .string()
            .max(255)
            .optional()
            .describe('显示名，缺省取 URL 末段'),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      ({ canvasId: id, url, filename }, extra) => {
        const signal = signalOf(extra);
        return guarded(async () => {
          await svc.lockForWrite(p, id);
          return json(await svc.importAsset(p, id, url, filename, signal));
        }, signal);
      },
    );
  }

  for (const t of SHARED_TEMPLATE) {
    const scope = SHARED_TOOL_SCOPES[t.name] ?? 'canvas:write';
    if (!can(scope)) continue;
    if (!(t.schema instanceof z.ZodObject)) {
      throw new Error(`共享画布工具 ${t.name} 的 schema 不是 zod object`);
    }
    server.registerTool(
      t.name,
      {
        description: adaptDescription(t.description),
        inputSchema: t.schema.extend({ ...capArrays(t.schema), canvasId }),
        annotations: annotationsFor(t.name, scope),
      },
      ({ canvasId: rawId, ...args }, extra) => {
        // 调用被取消 / 连接断开时中止信号触发：批量工具据此停在当前项，不再继续写
        const signal = signalOf(extra);
        return guarded(async () => {
          // 共享 schema 是泛型 ZodObject，推不出 canvasId 的类型；SDK 已按 schema 校验过，这里再收窄一次
          const id = canvasId.parse(rawId);
          const invoke = async () => {
            const tool = svc.sharedTools(p, id).find((x) => x.name === t.name);
            if (!tool) throw new Error(`共享画布工具 ${t.name} 不存在`);
            const out: unknown = await tool.invoke(args, { signal });
            return text(typeof out === 'string' ? out : JSON.stringify(out));
          };
          if (scope === 'canvas:read') {
            await svc.assertAccess(p, id);
            return invoke();
          }
          await svc.lockForWrite(p, id);
          return withLockRenewal(() => svc.lockForWrite(p, id), invoke);
        }, signal);
      },
    );
  }

  return server;
}
