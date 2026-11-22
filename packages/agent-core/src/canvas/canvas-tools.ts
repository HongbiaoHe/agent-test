import { isAIMessage, isBaseMessage } from '@langchain/core/messages';
import {
  tool,
  type StructuredToolInterface,
  type ToolRunnableConfig,
} from '@langchain/core/tools';
import {
  CANVAS_NODE_TYPES,
  clampNodeLabel,
  collectGenerationInputs,
  collectVideoSources,
  isCanvasNodeType,
  isInFlight,
  isUploadNodeType,
  resolveNodeIdIn,
  shortNodeId,
  UPLOAD_NODE_ASSET,
  uploadNodeTypeFor,
  type ApplyOpResult,
  type CanvasEdgeDto,
  type CanvasIoType,
  type CanvasNodeDto,
  type CanvasOpInput,
} from '@agent-test/canvas-schema';
import { z } from 'zod';
import { mediaParamsSchema } from '../media/media-tools';

/**
 * 画布操作工具（服务端画布 agent 与 desktop 本机 agent 共用）。工具名、入参、说明、校验与批内排序都在这里；
 * 「怎么落到画布上」由宿主注入的执行端（CanvasToolBackend）决定：
 *  - web 后端：直接调 CanvasService / MediaService（同进程）；
 *  - desktop：经 web 后端的画布 agent 接口（带运行锁）。
 * 画布状态不靠查询工具，由 canvas-state-middleware 在画布变化时自动注入。
 * ask_user 不在这里：各宿主有自己的提问工具。
 */

/** 生成节点的模型与档位 */
export interface CanvasNodeConfig {
  channel: string;
  model: string;
  params: Record<string, string>;
}

export type CanvasReferenceCounts = Record<CanvasIoType, number>;

/** 给生成节点设模型前的严格校验结果（服务端 AigcService.prepareNodeConfig） */
export type CanvasNodeConfigResult =
  | { ok: true; config: CanvasNodeConfig; dropped: CanvasReferenceCounts }
  | { ok: false; issues: unknown[] };

/** 工具要的那部分画布快照 */
export interface CanvasToolSnapshot {
  nodes: CanvasNodeDto[];
  edges: CanvasEdgeDto[];
  /** 测试模式：开启时生成走占位素材（真实生成不能引用占位素材） */
  mockMedia: boolean;
}

/** 画布工具的执行端：一个实例只对应一块画布 */
export interface CanvasToolBackend {
  snapshot(): Promise<CanvasToolSnapshot>;
  /**
   * 可选：把模型给的节点 id（短 id 或完整 id）解析成完整 id，解析不到 / 有歧义返回 null。
   * 不提供就按快照里的节点解析（多拉一次快照）；服务端只查 id 列，更省。
   */
  resolveNodeId?(id: string): Promise<string | null>;
  /** 以 agent 身份提交一次结构变更 */
  applyOp(op: CanvasOpInput): Promise<ApplyOpResult>;
  /** 用户在对话里发的附件（上传版本）；不是本人 / 不是上传 / 不存在 → null */
  findUploadedAsset(versionId: string): Promise<{
    generationId: string;
    type: CanvasIoType;
    filename: string;
  } | null>;
  prepareNodeConfig(
    type: 'image' | 'video',
    req: {
      model?: string;
      channel?: string;
      params?: Record<string, string>;
      referenceCounts: CanvasReferenceCounts;
    },
  ): Promise<CanvasNodeConfigResult>;
  /** 发起一次生成；业务拒绝（引用非法、测试模式被禁用等）返回 { error }，不抛 */
  createGeneration(input: {
    type: 'image' | 'video';
    prompt: string;
    referenceVersionIds?: string[];
    config: Partial<CanvasNodeConfig>;
  }): Promise<{ generationId: string } | { error: unknown }>;
  /** 发起一次视频拼接（同上，业务拒绝返回 { error }） */
  createConcat(
    sourceVersionIds: string[],
  ): Promise<{ generationId: string } | { error: unknown }>;
  /** 生图 / 生视频模型目录（同 list_media_models） */
  modelCatalog(type: 'image' | 'video'): Promise<unknown>;
}

/**
 * 取当前画布的执行端。服务端一个 agent 恒对应一块画布；desktop 的对话要先绑定画布——
 * 没绑定时返回一句给模型的说明（工具原样回给它），而不是抛错废掉一整轮。
 */
export type CanvasBackendResolver = () => Promise<CanvasToolBackend | string>;

/** 全部画布工具名 */
export const CANVAS_TOOL_NAMES = [
  'add_node',
  'add_nodes',
  'update_node',
  'update_nodes',
  'connect_nodes',
  'delete_node',
  'clear_canvas',
  'list_media_models',
  'set_node_model',
  'generate_media_node',
  'merge_video_node',
  'set_clip_order',
] as const;

/** 有破坏性（删）或要花钱（生成）的工具：需要审批时就审这些 */
export const CANVAS_SENSITIVE_TOOLS = [
  'clear_canvas',
  'delete_node',
  'generate_media_node',
  'merge_video_node',
] as const;

/** 只读工具：只读权限下仍可挂 */
export const CANVAS_READONLY_TOOLS = ['list_media_models'] as const;

/** 已下线的节点类型 → 该改用什么。老会话的 checkpoint 里存着模型当初用过的这些值。 */
const RETIRED_NODE_TYPES: Record<string, string> = {
  text: 'text 节点已下线：提示词直接写在 image_gen / video_gen 自己的 prompt 参数上，不需要单独的文本节点，也不需要连线',
};

/** 触发类工具：同一条 AI 消息里一起调用时要按依赖顺序落地（见 createCanvasTools 的 inBatch）。 */
const TRIGGER_TOOLS = new Set(['generate_media_node', 'merge_video_node']);

/** 批内下游等上游落地的上限：上游被拒绝执行（审批里点了取消）时不至于一直挂着。 */
const BATCH_WAIT_MS = 15_000;

/** 同一条 AI 消息里的一批工具调用（各调用的参数是模型给的原值，节点 id 可能是短 id） */
interface ToolCallBatch {
  /** 同批所有调用算出同一个 key（各调用的 id 拼起来），换一批（哪怕节点相同）就是新 key */
  key: string;
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
}

/**
 * 这次工具调用所在的那一批：ToolNode 把当前 state 放在 config.state 里传给工具，
 * 最后一条消息就是发起这批调用的 AI 消息。拿不到（单测直调、非图内调用）返回 null。
 */
function toolCallBatch(config: unknown): ToolCallBatch | null {
  if (typeof config !== 'object' || config === null || !('state' in config)) {
    return null;
  }
  const { state } = config;
  if (
    typeof state !== 'object' ||
    state === null ||
    !('messages' in state) ||
    !Array.isArray(state.messages)
  ) {
    return null;
  }
  const last: unknown = state.messages.at(-1);
  if (!isBaseMessage(last) || !isAIMessage(last)) return null;
  const calls = last.tool_calls ?? [];
  return { key: calls.map((c) => c.id ?? c.name).join('|'), calls };
}

/** 本次调用自己的 tool call id（ToolNode 放在 config.toolCallId / config.toolCall.id） */
function ownToolCallId(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return null;
  if ('toolCallId' in config && typeof config.toolCallId === 'string') {
    return config.toolCallId;
  }
  if (
    'toolCall' in config &&
    typeof config.toolCall === 'object' &&
    config.toolCall !== null &&
    'id' in config.toolCall &&
    typeof config.toolCall.id === 'string'
  ) {
    return config.toolCall.id;
  }
  return null;
}

/**
 * 这次调用所在的那一批触发：同一条 AI 消息里所有 generate_media_node / merge_video_node
 * 的 nodeId。不到两个触发调用时返回 null（无需排序）。
 */
function triggerBatch(
  config: unknown,
): { key: string; nodeIds: string[] } | null {
  const batch = toolCallBatch(config);
  if (!batch) return null;
  const calls = batch.calls.filter((c) => TRIGGER_TOOLS.has(c.name));
  if (calls.length < 2) return null;
  const nodeIds = calls
    .map((c): unknown => c.args.nodeId)
    .filter((id): id is string => typeof id === 'string');
  return { key: batch.key, nodeIds };
}

/** 报错里点名节点：短 id + 标题（与注入的画布状态同一写法，模型能直接拿去用）。 */
function describeNodes(
  nodes: readonly { id: string; label: string | null; type: string }[],
): string {
  return nodes
    .map((n) => `${shortNodeId(n.id)}「${n.label ?? n.type}」`)
    .join('、');
}

/**
 * 画布暂时不能操作（desktop 对话没绑定画布、画布正被别人编辑拿不到运行锁…）：执行端抛它，
 * 由 canvasTool 把 message 原样回给模型，而不是抛错废掉一整轮。
 */
export class CanvasUnavailableError extends Error {}

/**
 * 构造画布操作工具。所有结构变更经执行端的 applyOp（服务端是唯一写入口：事务 + op 日志 + 广播
 * canvas_patch），生成 / 拼接经执行端异步发起。
 */
export function createCanvasTools(
  resolve: CanvasBackendResolver,
): StructuredToolInterface[] {
  // 注：不提供 get_canvas 工具——画布状态（节点/连线/安全区）由 canvas-state-middleware 自动注入对话，
  // agent 直接读消息即可。
  const backend = async (): Promise<CanvasToolBackend> => {
    const b = await resolve();
    if (typeof b === 'string') throw new CanvasUnavailableError(b);
    return b;
  };

  /**
   * 画布工具的统一包装（签名同 tool）：入参类型按 schema 推出；执行端不可用时回一句话给模型，
   * 而不是抛错废掉一整轮。
   */
  function canvasTool<S extends z.ZodObject<z.ZodRawShape>>(
    run: (args: z.infer<S>, config: ToolRunnableConfig) => Promise<string>,
    fields: { name: string; description: string; schema: S },
  ) {
    return tool(async (args: z.infer<S>, config: ToolRunnableConfig) => {
      try {
        return await run(args, config);
      } catch (e) {
        if (e instanceof CanvasUnavailableError) {
          return JSON.stringify({ error: e.message });
        }
        throw e;
      }
    }, fields);
  }

  /**
   * 解析模型给的节点 id。注入的画布状态里用的是短 id（完整 cuid 后 6 位，省 token），
   * 而 add_node 的返回值是完整 id —— 模型两种都可能回传，统一在这里反解成完整 id。
   * 解析不到（不存在 / 后缀有歧义）返回 null，各工具据此回一条明确错误给模型。
   */
  const resolveId = async (id: string): Promise<string | null> => {
    const b = await backend();
    if (b.resolveNodeId) return b.resolveNodeId(id);
    return resolveNodeIdIn(
      (await b.snapshot()).nodes.map((n) => n.id),
      id,
    );
  };

  /**
   * 同一批触发里各节点「已落地」的信号（key = 批 key + 完整节点 id）。
   * 落地 = 这次调用跑完了（成功挂上新版本，或报错不触发），下游据此再去收集参考。
   */
  const landed = new Map<string, { done: Promise<void>; land: () => void }>();
  const landing = (key: string) => {
    let signal = landed.get(key);
    if (!signal) {
      let land = () => {};
      const done = new Promise<void>((resolve) => (land = resolve));
      signal = { done, land };
      landed.set(key, signal);
    }
    return signal;
  };

  /**
   * 包住 connect_nodes：同一条 AI 消息里指向**同一个节点**的多条连线，按它们在消息里的先后依次落库。
   *
   * 入边顺序就是拼接顺序（也是参考素材编号）。这些调用是并行执行的，谁先进 applyOp 的串行队列
   * 不可控——实测 agent 按 镜1、镜2、镜3 写的连线落成了 镜2、镜3、镜1。所以每条连线先等同批里
   * 排在它前面、且终点相同的那一条落地，再自己落库。
   */
  async function inConnectOrder(
    config: unknown,
    targetId: string,
    run: () => Promise<string>,
  ): Promise<string> {
    const batch = toolCallBatch(config);
    const callId = ownToolCallId(config);
    if (!batch || !callId) return run();
    try {
      const connects = batch.calls.filter((c) => c.name === 'connect_nodes');
      const mine = connects.findIndex((c) => c.id === callId);
      const target = mine > 0 ? await resolveId(targetId) : null;
      let prevId: string | undefined;
      for (const c of connects.slice(0, Math.max(mine, 0)).reverse()) {
        const t = c.args.targetId;
        if (
          typeof t === 'string' &&
          target &&
          (await resolveId(t)) === target
        ) {
          prevId = c.id;
          break;
        }
      }
      if (prevId)
        await waitLanded([landing(`${batch.key}:call:${prevId}`).done]);
      return await run();
    } finally {
      landing(`${batch.key}:call:${callId}`).land();
    }
  }

  /** 等这些落地信号（最多 BATCH_WAIT_MS，前一个调用被拒绝执行时不至于一直挂着） */
  async function waitLanded(signals: Promise<void>[]): Promise<void> {
    if (signals.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(signals),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BATCH_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * 包住触发类工具：同一条 AI 消息里一起调用的生成 / 拼接，在这里排成依赖顺序。
   *
   * 这些调用是并行执行的（每个 tool call 一个任务），下游可能先于上游跑到——那时上游还没挂上
   * 这次的新版本：没生成过会被当成缺上游拒掉，生成过的会拿到上一版当参考（「全部重新生成」时
   * 引用旧图）。所以下游先等**同批里的直接上游**落地，再照常收集；更上游的由上游自己去等，链式成序。
   */
  async function inBatch(
    config: unknown,
    nodeId: string,
    run: () => Promise<string>,
  ): Promise<string> {
    const batch = triggerBatch(config);
    const full = batch ? await resolveId(nodeId) : null;
    if (!batch || !full) return run();
    try {
      const siblings = new Set(
        (await Promise.all(batch.nodeIds.map(resolveId))).filter(
          (id): id is string => !!id && id !== full,
        ),
      );
      const snap = await (await backend()).snapshot();
      const upstream = snap.edges
        .filter((e) => e.target === full && siblings.has(e.source))
        .map((e) => landing(`${batch.key}:${e.source}`).done);
      await waitLanded(upstream);
      return await run();
    } finally {
      landing(`${batch.key}:${full}`).land();
    }
  }

  const addNodeSchema = z.object({
    // 刻意用 z.string() 而不是 z.enum：枚举由 zod 拒会抛异常（见 addOneNode 注释），
    // 取值范围写在 description 里，模型读的是这个
    type: z
      .string()
      .optional()
      .describe(
        '节点类型（必填）：image_upload 上传图片 / video_upload 上传视频 / audio_upload 上传音频 / image_gen 生图 / video_gen 生视频 / video_concat 视频拼接',
      ),
    label: z
      .string()
      .optional()
      .describe('节点标题（可选；挂附件时缺省用文件名）'),
    prompt: z
      .string()
      .optional()
      .describe('生成提示词（image_gen / video_gen 专有）'),
    model: z
      .string()
      .optional()
      .describe(
        '生成节点专有：模型别名（list_media_models 返回的 model，也认展示名）；不传 = 默认模型',
      ),
    channel: z
      .string()
      .optional()
      .describe('生成节点专有：渠道（同名模型出现在多个渠道时才需要指定）'),
    params: mediaParamsSchema,
    versionId: z
      .string()
      .optional()
      .describe(
        '上传节点专有：用户附件的 versionId（「[附件]」清单里那个），类型须与节点一致',
      ),
    x: z.number().optional(),
    y: z.number().optional(),
  });

  /** 建一个节点，回给模型的结果对象（成功：nodeId/revision；不合法：error…）。add_node / add_nodes 共用。 */
  async function addOneNode({
    type,
    label,
    prompt,
    versionId,
    model,
    channel,
    params,
    x,
    y,
  }: z.infer<typeof addNodeSchema>): Promise<Record<string, unknown>> {
    // type 的校验**整个**放在这儿而不是交给 zod 枚举：让 zod 直接拒的话，报错会以一大坨
    // 带堆栈的异常进对话历史、废掉一整轮；这里返回一句话，模型下一步就能补上——
    // 与本文件其它工具报「节点不存在」是同一套做法。
    //
    // 三种情况分开报，因为模型需要的下一步动作不同：
    //  - 漏传（实测漏过一次，只给了 label/prompt/x/y）→ 告诉它取值范围
    //  - 已下线的类型（老会话的 checkpoint 里存着 add_node type:"text" 的调用记录，
    //    模型很可能照着自己的历史再来一次）→ 告诉它现在该怎么做，而不只是"非法"
    //  - 其余非法值 → 取值范围
    if (!type) {
      return {
        error: `缺少必填参数 type，取值：${CANVAS_NODE_TYPES.join(' | ')}`,
      };
    }
    if (RETIRED_NODE_TYPES[type]) {
      return { error: RETIRED_NODE_TYPES[type] };
    }
    if (!isCanvasNodeType(type)) {
      return {
        error: `未知的 type "${type}"，取值：${CANVAS_NODE_TYPES.join(' | ')}`,
      };
    }
    // 上传节点挂用户在对话里发的附件：只认本画布、本人、已随消息发出的上传版本，
    // 且附件类型要与节点类型一致（报错里直接给出该用哪种节点，模型下一步就能改对）
    let mediaGenerationId: string | undefined;
    let defaultLabel: string | undefined;
    if (versionId) {
      if (!isUploadNodeType(type)) {
        return {
          error:
            'versionId 只用于上传节点（image_upload / video_upload / audio_upload）',
        };
      }
      const asset = await (await backend()).findUploadedAsset(versionId);
      if (!asset) {
        return {
          error: '找不到这个附件：versionId 必须取自用户消息里的「[附件]」清单',
          versionId,
        };
      }
      if (asset.type !== UPLOAD_NODE_ASSET[type]) {
        return {
          error: `这个附件是 ${asset.type}，要用 ${uploadNodeTypeFor(asset.type)} 节点`,
          versionId,
        };
      }
      mediaGenerationId = asset.generationId;
      // 文件名最长 255，标题上限 191：截断，免得节点因标题超长建不出来
      defaultLabel = clampNodeLabel(asset.filename);
    }
    // 生成节点建时就定好模型与档位（同 set_node_model 的严格校验），不合法一个节点都不建——
    // 先建成默认再改，用户会先看到一张 1:1 / 默认模型的卡片，且 agent 常常忘了回头改。
    // 刚建的节点还没有入边，参考素材按 0 算；之后连上参考图若触发约束，生成时按原规则收窄。
    let config:
      | { channel: string; model: string; params: Record<string, string> }
      | undefined;
    if (model !== undefined || channel !== undefined || params !== undefined) {
      if (type !== 'image_gen' && type !== 'video_gen') {
        return {
          error: 'model / channel / params 只用于 image_gen / video_gen',
        };
      }
      const r = await (
        await backend()
      ).prepareNodeConfig(type === 'video_gen' ? 'video' : 'image', {
        model,
        channel,
        params,
        referenceCounts: { image: 0, video: 0, audio: 0 },
      });
      if (!r.ok) {
        return {
          error: 'invalid_params',
          issues: r.issues,
          hint: '节点未创建。按 issues 修正后重新调用 add_node；完整的模型与档位表可调用 list_media_models',
        };
      }
      config = r.config;
    }
    const r = await (
      await backend()
    ).applyOp({
      op: 'add_node',
      type,
      label: label ?? defaultLabel,
      prompt,
      mediaGenerationId,
      mediaChannel: config?.channel,
      mediaModel: config?.model,
      mediaParams: config?.params,
      x,
      y,
    });
    const node = 'node' in r.patch ? r.patch.node : null;
    // 回短 id：与注入的画布状态同一套写法，模型不必在两种 id 之间切换
    return {
      nodeId: node ? shortNodeId(node.id) : undefined,
      revision: r.revision,
      ...(config ? { model: config.model, params: config.params } : {}),
    };
  }

  const addNode = canvasTool(
    async (args) => JSON.stringify(await addOneNode(args)),
    {
      name: 'add_node',
      description:
        '在画布上新建一个节点。type：image_upload / video_upload / audio_upload(用户上传的图片 / 视频 / 音频) | image_gen(生图) | video_gen(生视频) | video_concat(把多段上游视频按顺序拼成一条)。生成节点的提示词直接写在它自己的 prompt 参数里，模型与档位用 model / params 在建节点时一并定好（不传就是默认模型的默认档位）；不合法时返回 error=invalid_params 与 issues，节点不会被创建，按 issues 修正后重试。要把用户在对话里发的附件放上画布：建对应类型的上传节点并传 versionId（取自用户消息的「[附件]」清单）；不传 versionId 的上传节点是空的，等用户自己在卡片上传文件。x/y 为画布坐标（按工作流从左到右布局，纵向错开避免重叠）。返回 nodeId。要建 2 个及以上节点用 add_nodes。',
      schema: addNodeSchema,
    },
  );

  /**
   * 批量版 add_node：理由同 update_nodes（并行工具调用每个都带一份完整 state，实测并行建 5 个
   * 节点派了 5 个 Send）。逐条串行建，每条的校验与 add_node 完全一致；某条不合法 / 失败只影响它自己，
   * results 与 nodes 一一对应（同序），模型按位置取各自的 nodeId 去连线。
   */
  const addNodes = canvasTool(
    async ({ nodes }) => {
      const results: Record<string, unknown>[] = [];
      for (const n of nodes) {
        try {
          results.push(await addOneNode(n));
        } catch (e) {
          results.push({ error: e instanceof Error ? e.message : String(e) });
        }
      }
      const created = results.filter((r) => r.nodeId).length;
      return JSON.stringify({
        ok: created === nodes.length,
        created,
        results,
      });
    },
    {
      name: 'add_nodes',
      description:
        '一次新建**多个**节点。每项参数与 add_node 完全相同（type 必填，生成节点带 prompt / model / params，上传节点可带 versionId，x/y 坐标）。返回 results 与传入顺序一一对应：成功项带 nodeId，失败项带 error（该项未创建，其余照常创建）。建 2 个及以上节点时用它，不要并行发多个 add_node。',
      schema: z.object({
        nodes: z.array(addNodeSchema).min(1).describe('每个要建的节点一项'),
      }),
    },
  );

  const nodeUpdateSchema = z.object({
    nodeId: z.string(),
    label: z.string().optional(),
    prompt: z
      .string()
      .optional()
      .describe('生成提示词（image_gen / video_gen 专有）'),
    x: z.number().optional().describe('新的画布 x 坐标'),
    y: z.number().optional().describe('新的画布 y 坐标'),
  });

  const updateNode = canvasTool(
    async ({ nodeId, label, prompt, x, y }) => {
      const full = await resolveId(nodeId);
      if (!full) return JSON.stringify({ error: '节点不存在', nodeId });
      const r = await (
        await backend()
      ).applyOp({
        op: 'update_node',
        nodeId: full,
        label,
        prompt,
        x,
        y,
      });
      return JSON.stringify({ ok: true, revision: r.revision });
    },
    {
      name: 'update_node',
      description:
        '修改**单个**已存在节点的 label / prompt，或移动它的位置 x/y（放入安全区避免重叠）。prompt 就是该生成节点本次要用的提示词——换提示词直接改它，不需要别的节点。要改/挪多个节点用 update_nodes。',
      schema: nodeUpdateSchema,
    },
  );

  /**
   * 批量版 update_node。并行发多个 update_node 时，LangChain 给每个工具调用派一个 Send、
   * 每个 Send 都带整份 state（全部消息）：实测重排 49 个节点时单份 checkpoint 49MB、
   * 历史里还多出 49 对工具调用/结果。批量只派一个 Send、只留一对。
   * 逐条串行落库（applyOp 本就按会话串行），某条失败不影响其余，结果逐条回报。
   */
  const updateNodes = canvasTool(
    async ({ updates }) => {
      let revision: number | undefined;
      const failed: { nodeId: string; error: string }[] = [];
      for (const { nodeId, label, prompt, x, y } of updates) {
        const full = await resolveId(nodeId);
        if (!full) {
          failed.push({ nodeId, error: '节点不存在' });
          continue;
        }
        try {
          const r = await (
            await backend()
          ).applyOp({
            op: 'update_node',
            nodeId: full,
            label,
            prompt,
            x,
            y,
          });
          revision = r.revision;
        } catch (e) {
          failed.push({
            nodeId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return JSON.stringify({
        ok: failed.length === 0,
        updated: updates.length - failed.length,
        ...(failed.length ? { failed } : {}),
        ...(revision !== undefined ? { revision } : {}),
      });
    },
    {
      name: 'update_nodes',
      description:
        '一次修改/移动**多个**已存在节点（重排布局、批量改 label 或 prompt）。每项字段同 update_node，只传要改的字段。改 2 个及以上节点时用它，不要并行发多个 update_node。',
      schema: z.object({
        updates: z
          .array(nodeUpdateSchema)
          .min(1)
          .describe('每个要改的节点一项'),
      }),
    },
  );

  const connectNodes = canvasTool(
    async ({ sourceId, targetId }, config) =>
      inConnectOrder(config, targetId, async () => {
        const [source, target] = await Promise.all([
          resolveId(sourceId),
          resolveId(targetId),
        ]);
        if (!source || !target) {
          return JSON.stringify({
            error: '节点不存在',
            ...(source ? {} : { sourceId }),
            ...(target ? {} : { targetId }),
          });
        }
        const r = await (
          await backend()
        ).applyOp({
          op: 'add_edge',
          source,
          target,
        });
        const edge = 'edge' in r.patch ? r.patch.edge : null;
        return JSON.stringify({ edgeId: edge?.id, revision: r.revision });
      }),
    {
      name: 'connect_nodes',
      description:
        '用有向连线连接两个节点（sourceId → targetId，表示 source 是 target 的上游输入）。连向同一节点的多条线按连接先后排序（同一步里按调用先后）：拼接节点的顺序就是成片顺序，生成节点的顺序就是参考素材编号，所以要按叙事顺序连。入边只提供**参考素材**——提示词是生成节点自己的 prompt 字段，不靠连线。类型契约：image_upload / video_upload / audio_upload 分别输出 image / video / audio；image_gen 接受 image 输出 image；video_gen 接受 image/video/audio 输出 video（各类型能用几个看节点所选模型，超出的不会提交）；video_concat 只吃 video。上传节点没有输入端口，任何指向它的连线都会被拒绝。',
      schema: z.object({ sourceId: z.string(), targetId: z.string() }),
    },
  );

  const deleteNode = canvasTool(
    async ({ nodeId }) => {
      const full = await resolveId(nodeId);
      if (!full) return JSON.stringify({ error: '节点不存在', nodeId });
      const r = await (
        await backend()
      ).applyOp({
        op: 'remove_node',
        nodeId: full,
      });
      return JSON.stringify({ ok: true, revision: r.revision });
    },
    {
      name: 'delete_node',
      description: '删除一个节点（会级联删除它的相关连线）。',
      schema: z.object({ nodeId: z.string() }),
    },
  );

  const generateMediaNode = canvasTool(
    async ({ nodeId }, config) =>
      inBatch(config, nodeId, async () => {
        const full = await resolveId(nodeId);
        const snap = await (await backend()).snapshot();
        const node = full ? snap.nodes.find((n) => n.id === full) : undefined;
        if (!node) {
          return JSON.stringify({ error: '节点不存在', nodeId });
        }
        if (node.type !== 'image_gen' && node.type !== 'video_gen') {
          return JSON.stringify({
            error: '只有 image_gen / video_gen 节点可触发生成',
            type: node.type,
          });
        }
        // 提示词是节点自己的字段；入边只提供参考素材（契约见 canvas.types 的 CANVAS_NODE_IO）。
        // 与用户手动触发（CanvasService.generateMediaNode）共用同一段收集逻辑。
        const prompt = node.prompt?.trim() ?? '';
        if (!prompt) {
          return JSON.stringify({
            error:
              '该节点还没有提示词：先用 update_node 把 prompt 写到这个节点上，再触发生成',
          });
        }
        const inputs = collectGenerationInputs(snap.nodes, snap.edges, node.id);
        const { referenceVersionIds } = inputs;
        // 上游既没产物、也没在生成：点名让模型先触发它们（在生成的上游会被等待，不用管）
        if (inputs.missingInputs.length > 0) {
          return JSON.stringify({
            error: `上游 ${describeNodes(inputs.missingInputs)} 还没有产物、也没在生成：生成 / 拼接节点先触发它们，上传节点需用户先上传文件，再触发本节点`,
          });
        }

        // 真实生成不能拿测试模式的占位素材当参考（MediaService 也会拒，这里先点名是哪几个上游，
        // 模型下一步就知道要先真实生成它们）
        if (!snap.mockMedia) {
          const mockUpstream = snap.edges
            .filter((e) => e.target === node.id)
            .map((e) => snap.nodes.find((n) => n.id === e.source))
            .filter(
              (n): n is NonNullable<typeof n> =>
                !!n && n.mediaMock && (n.outputs.length > 0 || isInFlight(n)),
            );
          if (mockUpstream.length > 0) {
            return JSON.stringify({
              error: `上游 ${describeNodes(mockUpstream)} 是测试模式产出的占位素材，真实生成不能引用：先对它们真实生成，再触发本节点`,
            });
          }
        }

        const type = node.type === 'video_gen' ? 'video' : 'image';
        const created = await (
          await backend()
        ).createGeneration({
          type,
          prompt,
          referenceVersionIds: referenceVersionIds.length
            ? referenceVersionIds
            : undefined,
          // 模型取节点上选定的那份（用户在卡片面板里选的，或 agent 用 set_node_model 设的）；
          // 没选就回落该类型默认模型。
          config: {
            channel: node.mediaChannel ?? undefined,
            model: node.mediaModel ?? undefined,
            params: node.mediaParams ?? undefined,
          },
        });
        // 业务拒绝（如环境禁用了测试模式、引用非法）回一句话给模型，而不是抛异常废掉一整轮
        if ('error' in created) return JSON.stringify({ error: created.error });
        const { generationId } = created;
        // 回填 generationId：快照/前端据此显示生成状态与资产
        await (
          await backend()
        ).applyOp({
          op: 'update_node',
          nodeId: node.id,
          mediaGenerationId: generationId,
        });
        return JSON.stringify({
          generationId,
          status: 'queued',
          references: referenceVersionIds.length,
          // 其中还在生成的上游：本节点会等它们出结果再开始，不用重复触发
          pendingInputs: inputs.pendingInputs,
        });
      }),
    {
      name: 'generate_media_node',
      description:
        '触发某个 image_gen / video_gen 节点的实际生成（异步）。提示词取**该节点自己的 prompt 字段**（用 add_node / update_node 写上去），没写就会报错；模型与档位取节点上设好的那份（要换用 set_node_model，没设过用默认模型）；参考素材取自入边上游的图片 / 视频 / 音频（生成的与上传的都算，按入边顺序；超出所选模型上限的不会提交）。上游还在排队 / 生成中也可以直接触发：本节点会等它们出结果再开始（数量见返回值 pendingInputs）。同一步里一起调用的 generate_media_node / merge_video_node 会自动按连线依赖排序，所以整条多层工作流可以在一步里全部触发；上游既没在同一步触发、之前也没触发过（或失败了）会报错。触发后立即返回 queued，卡片状态自动更新，不要重复触发同一节点。',
      schema: z.object({ nodeId: z.string() }),
    },
  );

  const listMediaModels = canvasTool(
    async ({ type }) =>
      JSON.stringify(await (await backend()).modelCatalog(type)),
    {
      name: 'list_media_models',
      description:
        '查询当前可用的生图 / 生视频模型及每个模型支持的档位（画幅比例、清晰度、时长、音频等可选值，参考图 / 参考视频 / 参考音频数量上限，参数之间的约束规则 rules，用途提示 hint）。' +
        '给节点换模型或改档位（set_node_model）前用它确认模型名与可选值。目录可能随时增减模型，以本工具返回为准。',
      schema: z.object({
        type: z.enum(['image', 'video']).describe('image 生图 / video 生视频'),
      }),
    },
  );

  /**
   * 给生成节点设模型与档位——与用户在卡片面板上选模型是同一件事（同样落 update_node 的三个字段），
   * 只是 agent 传的值要先过一遍严格校验：模型名、档位取值、约束规则不合法就回 issues 让它改，
   * 不像生成时那样静默收窄（静默改写会让「用户说要 16:9」变成别的比例而没人知道）。
   */
  const setNodeModel = canvasTool(
    async ({ nodeId, model, channel, params }) => {
      const full = await resolveId(nodeId);
      const snap = await (await backend()).snapshot();
      const node = full ? snap.nodes.find((n) => n.id === full) : undefined;
      if (!node) {
        return JSON.stringify({ error: '节点不存在', nodeId });
      }
      if (node.type !== 'image_gen' && node.type !== 'video_gen') {
        return JSON.stringify({
          error: '只有 image_gen / video_gen 节点有模型可设',
          type: node.type,
        });
      }
      const type = node.type === 'video_gen' ? 'video' : 'image';
      // 不传 model = 保持节点现有模型、只改档位（节点没设过就是默认模型）
      const r = await (
        await backend()
      ).prepareNodeConfig(type, {
        model: model ?? node.mediaModel ?? undefined,
        channel: model ? channel : (channel ?? node.mediaChannel ?? undefined),
        params,
        referenceCounts: collectGenerationInputs(
          snap.nodes,
          snap.edges,
          node.id,
        ).referenceCounts,
      });
      if (!r.ok) {
        return JSON.stringify({
          error: 'invalid_params',
          issues: r.issues,
          hint: '按 issues 修正后重新调用；完整的模型与档位表可调用 list_media_models',
        });
      }
      const rev = await (
        await backend()
      ).applyOp({
        op: 'update_node',
        nodeId: node.id,
        mediaChannel: r.config.channel,
        mediaModel: r.config.model,
        mediaParams: r.config.params,
      });
      const dropped = Object.entries(r.dropped).filter(([, n]) => n > 0);
      return JSON.stringify({
        ok: true,
        model: r.config.model,
        channel: r.config.channel,
        params: r.config.params,
        revision: rev.revision,
        // 这个模型收不下的上游素材（生成时不会提交）：照实告诉模型，由它决定要不要换
        ...(dropped.length
          ? { droppedInputs: Object.fromEntries(dropped) }
          : {}),
      });
    },
    {
      name: 'set_node_model',
      description:
        '给**已有的** image_gen / video_gen 节点改生成模型与档位（画幅比例、清晰度、时长、音频等），与用户在卡片上选模型等效；新建节点时直接用 add_node 的 model / params 定好，不必建完再改。' +
        '用户点名了模型或档位（如「换 seedance 2.0」「生成 16:9」）就用它改，不要让用户自己去卡片上改。' +
        '不传 model 表示保持节点当前模型、只改档位；params 只传要指定的维度，没传的必填项自动取第一个值。' +
        '不合法时返回 error=invalid_params 与 issues（含 allowed 可选值），按 issues 修正后重试。改完后需要出片再调 generate_media_node。',
      schema: z.object({
        nodeId: z.string(),
        model: z
          .string()
          .optional()
          .describe(
            '模型别名（list_media_models 返回的 model，也认展示名如 "Seedance 2.0"）；不传 = 保持节点当前模型',
          ),
        channel: z
          .string()
          .optional()
          .describe('渠道（同名模型出现在多个渠道时才需要指定）'),
        params: mediaParamsSchema,
      }),
    },
  );

  /**
   * 触发视频拼接。与 generate_media_node 同一套交互（异步、回填 generationId、卡片自己更新状态），
   * 区别是素材全部是**上游视频**、且不调模型（本地 ffmpeg，见 media/video-concat.ts）。
   */
  /** 拼接节点当前的顺序（= 成片顺序），写成「短 id「标题」」列表，回给模型核对 */
  const clipOrder = (snap: CanvasToolSnapshot, nodeId: string) =>
    snap.edges
      .filter((e) => e.target === nodeId)
      .map((e) => snap.nodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => `${shortNodeId(n.id)}「${n.label ?? n.type}」`);

  /** 按 order 重排拼接节点的入边；order 里有不是它上游的 id 就回错误文案、不改动 */
  const applyClipOrder = async (
    snap: CanvasToolSnapshot,
    nodeId: string,
    order: string[],
  ): Promise<string | null> => {
    const ids = await Promise.all(order.map(resolveId));
    const upstream = new Set(
      snap.edges.filter((e) => e.target === nodeId).map((e) => e.source),
    );
    const bad = order.filter((o, i) => {
      const id = ids[i];
      return !id || !upstream.has(id);
    });
    if (bad.length > 0) {
      return `这些不是该拼接节点的上游：${bad.join('、')}（当前上游：${clipOrder(snap, nodeId).join('、')}）`;
    }
    await (
      await backend()
    ).applyOp({
      op: 'reorder_inputs',
      nodeId,
      sourceIds: ids.filter((id): id is string => !!id),
    });
    return null;
  };

  const mergeVideoNode = canvasTool(
    async ({ nodeId, order }, config) =>
      inBatch(config, nodeId, async () => {
        const full = await resolveId(nodeId);
        let snap = await (await backend()).snapshot();
        const node = full ? snap.nodes.find((n) => n.id === full) : undefined;
        if (!node) {
          return JSON.stringify({ error: '节点不存在', nodeId });
        }
        if (node.type !== 'video_concat') {
          return JSON.stringify({
            error: '只有 video_concat 节点可触发拼接',
            type: node.type,
          });
        }
        // 先按声明的顺序重排，再按入边顺序拼
        if (order && order.length > 0) {
          const err = await applyClipOrder(snap, node.id, order);
          if (err) return JSON.stringify({ error: err });
          snap = await (await backend()).snapshot();
        }
        // 顺序 = 入边顺序，与用户在卡片上看到的预览顺序同源（见 collectVideoSources）
        const { sources, pendingSources, missingSources } = collectVideoSources(
          snap.nodes,
          snap.edges,
          node.id,
        );
        if (missingSources.length > 0) {
          return JSON.stringify({
            error: `上游视频 ${describeNodes(missingSources)} 还没有产物、也没在生成：生成 / 拼接节点先触发它们，上传节点需用户先上传文件，再触发拼接`,
          });
        }
        if (sources.length < 2) {
          return JSON.stringify({
            error:
              '拼接至少需要两段视频：请把多个 video_gen（或另一个 video_concat）节点连到它并触发它们',
            clips: sources.length,
          });
        }

        const created = await (await backend()).createConcat(sources);
        if ('error' in created) return JSON.stringify({ error: created.error });
        const { generationId } = created;
        await (
          await backend()
        ).applyOp({
          op: 'update_node',
          nodeId: node.id,
          mediaGenerationId: generationId,
        });
        return JSON.stringify({
          generationId,
          status: 'queued',
          clips: sources.length,
          // 实际拼接顺序（= 成片顺序），和预期不一致就用 set_clip_order 改后重拼
          order: clipOrder(snap, node.id),
          // 其中还在生成的片段：拼接会等它们都出结果再开始
          pendingClips: pendingSources,
        });
      }),
    {
      name: 'merge_video_node',
      description:
        '触发某个 video_concat 节点的视频拼接（异步）。把它的**上游视频按入边顺序**接成一条新视频；至少要两段。上游视频还在生成中也可以直接触发：会等它们都出结果再拼（数量见返回值 pendingClips）；可与上游的 generate_media_node 在同一步里一起调用（自动按依赖排序）。上游既没在同一步触发、之前也没触发过（或失败了）会报错。拼接不调用生成模型（本地完成），但产物与生成节点一样是一段视频，可继续连给下游使用。触发后立即返回 queued，卡片状态自动更新，不要重复触发同一节点。**入边顺序就是成片顺序**：触发前核对画布状态里该节点的 <拼接顺序>，与叙事顺序不一致时传 order 纠正（返回值 order 是实际拼接顺序）。',
      schema: z.object({
        nodeId: z.string(),
        order: z
          .array(z.string())
          .optional()
          .describe(
            '可选：按叙事顺序列出上游视频节点 id，先按它重排再拼；列出的排在最前，没列出的保持原顺序接在后面',
          ),
      }),
    },
  );

  const setClipOrder = canvasTool(
    async ({ nodeId, order }) => {
      const full = await resolveId(nodeId);
      const snap = await (await backend()).snapshot();
      const node = full ? snap.nodes.find((n) => n.id === full) : undefined;
      if (!node) return JSON.stringify({ error: '节点不存在', nodeId });
      if (node.type !== 'video_concat') {
        return JSON.stringify({
          error: '只有 video_concat 节点有拼接顺序',
          type: node.type,
        });
      }
      const err = await applyClipOrder(snap, node.id, order);
      if (err) return JSON.stringify({ error: err });
      return JSON.stringify({
        ok: true,
        order: clipOrder(await (await backend()).snapshot(), node.id),
      });
    },
    {
      name: 'set_clip_order',
      description:
        '调整某个 video_concat 节点的拼接顺序（= 成片顺序），不触发拼接。order 按叙事顺序列出上游视频节点 id：列出的排在最前，没列出的保持原顺序接在后面。已拼好的成片要按新顺序重新出片，改完再调 merge_video_node。用户说「把片尾挪到最后」「镜 2 和镜 3 换一下」时用它。',
      schema: z.object({
        nodeId: z.string(),
        order: z.array(z.string()).min(1),
      }),
    },
  );

  const clearCanvas = canvasTool(
    async () => {
      const r = await (await backend()).applyOp({ op: 'clear' });
      return JSON.stringify({ ok: true, cleared: true, revision: r.revision });
    },
    {
      name: 'clear_canvas',
      description:
        '清空整块画布：一次性删除全部节点与连线。用于"删除所有节点/推倒重来"，比逐个 delete_node 可靠高效。此操作有破坏性，会先请用户确认再执行。',
      schema: z.object({}),
    },
  );

  return [
    addNode,
    addNodes,
    updateNode,
    updateNodes,
    connectNodes,
    deleteNode,
    clearCanvas,
    listMediaModels,
    setNodeModel,
    generateMediaNode,
    mergeVideoNode,
    setClipOrder,
  ];
}
