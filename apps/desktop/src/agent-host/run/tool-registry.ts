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
import { backgroundPrompt, createBackgroundTools, RUN_IN_BACKGROUND_TOOL } from '../background/background-tools';
import { createPreviewPageTool, PREVIEW_PAGE_TOOL } from '../preview/preview-page.tool';
import { createSaveSkillTool, SAVE_SKILL_TOOL } from '../skills/save-skill.tool';
import type { SkillStore } from '../skills/skill-store';
import type { WebApi } from '../web-media/web-api';
import { createSyncMediaTool, createWebMediaTools, SYNC_MEDIA_TOOL } from '../web-media/web-media';

/** 每轮运行期传给工具工厂的宿主对象 */
export interface DesktopToolHost {
  workspaceDir: string;
  runtimeDir: string;
  permission: WorkspacePermission;
  /** 本轮装配进来的 MCP server（watch_until 只能轮询这些） */
  mcpServers: RuntimeServer[];
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
    ...shareFactory<DesktopToolHost>(backgroundFactory, BACKGROUND_ENTRIES),
    {
      name: PREVIEW_PAGE_TOOL,
      title: '预览网页',
      description: '为工作区里的 HTML 产物或本机端口弹出可交互预览窗口',
      requires: ['workspace'],
      create: (ctx) => createPreviewPageTool({ workspaceDir: ctx.host.workspaceDir }),
    },
  ]);
}
