/**
 * desktop 的工具注册表（对应 backend 的 tool-registry.provider）：agent-host 启动时登记一次，
 * 模式按工具名勾选，resolveMode 按 requires 对照本环境能力过滤。
 *
 * 业务服务（Web 账号、后台任务服务、技能库）在这里闭包捕获；每轮运行期的对象（工作区 / 运行目录 /
 * 权限档位 / 本轮 MCP server）经 ToolCreateContext.host 传入。内置工具（文件工具 / write_todos /
 * ask_user）不在此列（决策 4）。
 */
import { join } from 'node:path';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { MEDIA_GENERATION_PROMPT } from '@agent-test/agent-core/media/media-prompt';
import type { RuntimeServer } from '@agent-test/agent-core/mcp/mcp-types';
import type { Capability, RuntimeEnvironment } from '@agent-test/agent-core/modes/capabilities';
import {
  shareFactory,
  type ToolCreateContext,
  type ToolDescriptor,
  ToolRegistry,
} from '@agent-test/agent-core/modes/tool-registry';
import type { WorkspacePermission } from '../../shared/workspace';
import type { BackgroundService } from '../background/background-service';
import {
  type CanvasRunContext,
  createBoundCanvasTools,
  createCreateCanvasTool,
  createListCanvasesTool,
  createOpenCanvasTool,
  CREATE_CANVAS_TOOL,
  DESKTOP_CANVAS_PROMPT,
  LIST_CANVASES_TOOL,
  OPEN_CANVAS_TOOL,
} from '../canvas/canvas-tools';
import { backgroundPrompt, createBackgroundTools, RUN_IN_BACKGROUND_TOOL } from '../background/background-tools';
import { createPreviewPageTool, PREVIEW_PAGE_TOOL } from '../preview/preview-page.tool';
import { createSaveSkillTool, SAVE_SKILL_TOOL } from '../skills/save-skill.tool';
import type { SkillStore } from '../skills/skill-store';
import { ffmpegBinaries } from '../video/ffmpeg-paths';
import {
  CHECK_VIDEO_PROJECT_TOOL,
  checkVideoProjectTool,
  CREATE_VIDEO_PROJECT_TOOL,
  createVideoProjectTool,
  VIDEO_PROJECT_PROMPT,
} from '../video/video-tools';
import type { WebApi } from '../web-media/web-api';
import { createSyncMediaTool, createWebMediaTools, SYNC_MEDIA_TOOL } from '../web-media/web-media';

/** 每轮运行期传给工具工厂的宿主对象 */
export interface DesktopToolHost {
  workspaceDir: string;
  runtimeDir: string;
  permission: WorkspacePermission;
  /** 本轮装配进来的 MCP server（watch_until 只能轮询这些） */
  mcpServers: RuntimeServer[];
  /** 画布上下文：登录了 Web 账号才有（capability canvas 缺失时画布工具不会被实例化） */
  canvas: CanvasRunContext | null;
}

export type DesktopRegistry = ToolRegistry<DesktopToolHost>;
type Ctx = ToolCreateContext<DesktopToolHost>;
type Entry = Omit<ToolDescriptor<DesktopToolHost>, 'create'>;

export interface DesktopRegistryDeps {
  /** 登录了 Web 账号才有；没有时媒体描述符照样登记，由 capability 缺失把它们降级 */
  webApi: WebApi | null;
  /** 后台任务服务（与 RunService 互相引用，装配顺序靠后，所以用 getter） */
  background: () => BackgroundService | null;
  skills: SkillStore;
  skillsChanged: () => void;
}

/** 本环境的能力集（运行期按会话权限算；设置页目录按默认档位 ask 算） */
export function desktopCapabilities(opts: {
  permission: WorkspacePermission;
  webApi: WebApi | null;
  background: BackgroundService | null;
}): Set<Capability> {
  const caps = new Set<Capability>(['workspace']);
  if (opts.permission !== 'read_only') caps.add('workspace_write');
  if (opts.webApi) caps.add('media_api');
  // 画布在 Web 账号下：登录了才能看；只读档位只能看、不能改
  if (opts.webApi) caps.add('canvas');
  if (opts.webApi && opts.permission !== 'read_only') caps.add('canvas_write');
  if (opts.background) caps.add('background');
  return caps;
}

/** 媒体工具名 → 设置页展示用的标题 / 说明（工具定义本身在 core media-tools.ts） */
const MEDIA_ENTRIES: Entry[] = [
  { name: 'list_media_models', title: '查询媒体模型', description: '列出生图 / 生视频 / 配音可用的模型与参数' },
  { name: 'generate_image', title: '生图', description: '调用 Web 账号的生成服务出图' },
  { name: 'generate_video', title: '生视频', description: '调用 Web 账号的生成服务出视频' },
  { name: 'generate_audio', title: '配音', description: '文字转语音（TTS）' },
  { name: 'clone_voice', title: '克隆音色', description: '用参考音频克隆一个可用于配音的音色' },
].map((e) => ({ ...e, requires: ['media_api'] as const, promptSection: MEDIA_GENERATION_PROMPT }));

/** 画布结构 / 生成工具（定义在 core canvas-tools.ts，与 Web 画布 agent 共用）：改画布要 canvas_write */
const CANVAS_ENTRIES: Entry[] = [
  { name: 'add_node', title: '画布：加节点', description: '在当前画布上新建一个节点' },
  { name: 'add_nodes', title: '画布：批量加节点', description: '一次新建多个节点' },
  { name: 'update_node', title: '画布：改节点', description: '修改节点标题 / 提示词或移动位置' },
  { name: 'update_nodes', title: '画布：批量改节点', description: '一次修改 / 移动多个节点' },
  { name: 'connect_nodes', title: '画布：连线', description: '连接两个节点（上游作参考素材）' },
  { name: 'delete_node', title: '画布：删节点', description: '删除一个节点（询问权限要确认）' },
  { name: 'clear_canvas', title: '画布：清空', description: '删除全部节点与连线（询问权限要确认）' },
  { name: 'set_node_model', title: '画布：设模型', description: '给生成节点设模型与档位' },
  { name: 'generate_media_node', title: '画布：生成', description: '触发生成节点出图 / 出视频（询问权限要确认）' },
  { name: 'merge_video_node', title: '画布：拼接', description: '触发视频拼接节点（询问权限要确认）' },
  { name: 'set_clip_order', title: '画布：拼接顺序', description: '调整拼接节点的成片顺序' },
].map((e) => ({ ...e, requires: ['canvas', 'canvas_write'] as const, promptSection: DESKTOP_CANVAS_PROMPT }));

/** 后台任务说明段随后台工具一起出现（没勾就没有）；可写工作区才提 run_in_background。 */
const backgroundSection = (env: RuntimeEnvironment): string =>
  backgroundPrompt(env.capabilities.has('workspace_write')).trim();

const BACKGROUND_ENTRIES: Entry[] = [
  {
    name: 'watch_until',
    title: '后台轮询',
    description: '反复调用一个「始终允许」的只读 MCP 工具，直到某字段到达目标值再唤醒',
    requires: ['background'],
    promptSection: backgroundSection,
  },
  {
    name: RUN_IN_BACKGROUND_TOOL,
    title: '后台命令',
    description: '在工作区后台跑超过 120 秒的长命令（询问权限要审批；只读权限不可用）',
    requires: ['background', 'workspace_write'],
    promptSection: backgroundSection,
  },
  {
    name: 'schedule_wakeup',
    title: '定时唤醒',
    description: '过一段时间带着备注唤醒 agent 继续',
    requires: ['background'],
    promptSection: backgroundSection,
  },
  {
    name: 'cancel_background_task',
    title: '取消后台任务',
    description: '取消本会话的某个后台任务',
    requires: ['background'],
    promptSection: backgroundSection,
  },
];

export function buildDesktopRegistry(deps: DesktopRegistryDeps): DesktopRegistry {
  const requireWeb = (): WebApi => {
    if (!deps.webApi) throw new Error('media_api 能力缺失时不应实例化媒体工具');
    return deps.webApi;
  };
  const requireCanvas = (ctx: Ctx): CanvasRunContext => {
    if (!ctx.host.canvas) throw new Error('canvas 能力缺失时不应实例化画布工具');
    return ctx.host.canvas;
  };
  const requireBackground = (): BackgroundService => {
    const bg = deps.background();
    if (!bg) throw new Error('background 能力缺失时不应实例化后台任务工具');
    return bg;
  };
  const backgroundFactory = (ctx: Ctx): StructuredToolInterface[] =>
    createBackgroundTools(requireBackground(), {
      conversationId: ctx.conversationId,
      workspaceDir: ctx.host.workspaceDir,
      logDir: join(ctx.host.runtimeDir, 'bg'),
      permission: ctx.host.permission,
      mcpServers: ctx.host.mcpServers,
    });

  return new ToolRegistry<DesktopToolHost>().registerAll([
    {
      name: SAVE_SKILL_TOOL,
      title: '保存技能',
      description: '把 agent 写好的技能存进本机技能库（任何权限档位都要用户确认）',
      create: () => createSaveSkillTool(deps.skills, deps.skillsChanged),
      // 保存技能会改变之后所有对话的行为：任何权限档位都要用户确认
      interruptOn: true,
    },
    ...shareFactory<DesktopToolHost>(
      (ctx) => [...createWebMediaTools(requireWeb(), ctx.conversationId)],
      MEDIA_ENTRIES,
    ),
    {
      name: SYNC_MEDIA_TOOL,
      title: '媒体下载进工作区',
      description: '把本会话的附件 / 生成产物下载到工作区 media/ 目录供命令处理',
      requires: ['media_api', 'workspace_write'],
      create: (ctx) => createSyncMediaTool(requireWeb(), ctx.conversationId, ctx.host.workspaceDir),
    },
    ...shareFactory<DesktopToolHost>((ctx) => createBoundCanvasTools(requireCanvas(ctx)), CANVAS_ENTRIES),
    {
      name: LIST_CANVASES_TOOL,
      title: '画布：列出',
      description: '列出 Web 账号下的画布',
      requires: ['canvas'],
      promptSection: DESKTOP_CANVAS_PROMPT,
      create: (ctx) => createListCanvasesTool(requireCanvas(ctx)),
    },
    {
      name: OPEN_CANVAS_TOOL,
      title: '画布：打开',
      description: '打开一块已有画布作为当前对话的画布',
      requires: ['canvas'],
      promptSection: DESKTOP_CANVAS_PROMPT,
      create: (ctx) => createOpenCanvasTool(requireCanvas(ctx)),
    },
    {
      name: CREATE_CANVAS_TOOL,
      title: '画布：新建',
      description: '新建一块画布作为当前对话的画布',
      requires: ['canvas', 'canvas_write'],
      promptSection: DESKTOP_CANVAS_PROMPT,
      create: (ctx) => createCreateCanvasTool(requireCanvas(ctx)),
    },
    ...shareFactory<DesktopToolHost>(backgroundFactory, BACKGROUND_ENTRIES),
    {
      name: PREVIEW_PAGE_TOOL,
      title: '预览网页',
      description: '为工作区里的 HTML 产物或本机端口弹出可交互预览窗口',
      requires: ['workspace'],
      create: (ctx) => createPreviewPageTool({ workspaceDir: ctx.host.workspaceDir }),
    },
    {
      name: CREATE_VIDEO_PROJECT_TOOL,
      title: '新建剪辑工程',
      description: '把生成的视频 / 图片 / 音频或工作区文件拼成可在剪辑器里编辑、导出的工程（引用 versionId 需登录 Web 账号）',
      requires: ['workspace_write'],
      promptSection: VIDEO_PROJECT_PROMPT,
      create: (ctx) =>
        createVideoProjectTool({
          conversationId: ctx.conversationId,
          workspaceDir: ctx.host.workspaceDir,
          webApi: deps.webApi,
          ffprobe: () => ffmpegBinaries().ffprobe,
        }),
    },
    {
      name: CHECK_VIDEO_PROJECT_TOOL,
      title: '检查剪辑工程',
      description: '只读校验剪辑工程：格式问题、缺失素材、成片总时长',
      requires: ['workspace'],
      promptSection: VIDEO_PROJECT_PROMPT,
      create: (ctx) => checkVideoProjectTool({ workspaceDir: ctx.host.workspaceDir }),
    },
  ]);
}
