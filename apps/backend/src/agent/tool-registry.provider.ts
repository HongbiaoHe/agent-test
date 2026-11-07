import { getWeatherDescriptor } from '@agent-test/agent-core/agent/tools/get-weather.tool';
import type { RuntimeServer } from '@agent-test/agent-core/mcp/mcp-types';
import { MEDIA_GENERATION_PROMPT } from '@agent-test/agent-core/media/media-prompt';
import type {
  Capability,
  RuntimeEnvironment,
} from '@agent-test/agent-core/modes/capabilities';
import {
  shareFactory,
  type ToolCreateContext,
  type ToolDescriptor,
  ToolRegistry,
} from '@agent-test/agent-core/modes/tool-registry';
import type { Provider } from '@nestjs/common';
import {
  backgroundPrompt,
  createBackgroundTools,
} from '../background/background.tools';
import { BackgroundService } from '../background/background.service';
import { createSyncMediaTool } from '../media/media-sandbox.tool';
import { createMediaTools } from '../media/media.tools';
import { MediaService } from '../media/media.service';
import {
  ATTACHMENTS_SECTION,
  SANDBOX_SYSTEM_PROMPT_BLOCK,
  SEND_EMAIL_SECTION,
} from './backend-prompt';
import type { GuardedSandbox } from './guarded-sandbox';
import { createPreviewPageTool } from './tools/preview-page.tool';
import { sendEmailTool } from './tools/send-email.tool';

/**
 * backend 的工具注册表：把本进程能提供的代码工具登记成描述符（名字 / 说明 / 所需能力 /
 * 构造闭包 / 审批 / 提示段），模式按名勾选，resolveMode 按运行环境的 capability 过滤。
 * 业务服务（MediaService / BackgroundService）在这里闭包捕获；本轮的运行期对象（沙箱、
 * MCP server 清单）经 ToolCreateContext.host 传入。
 */

/** 本轮运行期对象（instantiateTools 的 ctx.host）。 */
export interface BackendHost {
  sandbox: GuardedSandbox | null;
  mcpServers: RuntimeServer[];
}

export const TOOL_REGISTRY = Symbol('TOOL_REGISTRY');

type Ctx = ToolCreateContext<BackendHost>;

/** 沙箱相关工具的 create：resolve 阶段已按 capability 过滤，这里只是类型收窄的最后防线。 */
function requireSandbox(ctx: Ctx): GuardedSandbox {
  if (!ctx.host.sandbox) throw new Error('本轮没有沙箱，无法构造沙箱工具');
  return ctx.host.sandbox;
}

const MEDIA_TOOL_ENTRIES: Omit<ToolDescriptor<BackendHost>, 'create'>[] = [
  {
    name: 'list_media_models',
    title: '媒体模型目录',
    description: '列出可用的生图 / 生视频 / 配音模型及其参数取值',
  },
  {
    name: 'generate_image',
    title: '生成图片',
    description: '按提示词生成图片，支持引用已有素材做图生图',
  },
  {
    name: 'generate_video',
    title: '生成视频',
    description: '按提示词生成视频，支持参考图 / 首帧 / 参考视频',
  },
  {
    name: 'generate_audio',
    title: '配音',
    description: '语音合成，可用克隆音色',
  },
  {
    name: 'clone_voice',
    title: '克隆音色',
    description: '用用户上传的录音克隆一个音色',
  },
].map((e) => ({
  ...e,
  requires: ['media_api'] as const,
  promptSection: MEDIA_GENERATION_PROMPT,
}));

/** 后台任务说明段随后台工具一起出现（没勾就没有）；有沙箱才提 run_in_background。 */
const backgroundSection = (env: RuntimeEnvironment) =>
  backgroundPrompt(env.capabilities.has('sandbox')).trim();

const BACKGROUND_TOOL_ENTRIES: Omit<ToolDescriptor<BackendHost>, 'create'>[] = [
  {
    name: 'watch_until',
    title: '后台轮询',
    description: '在后台反复调用一个只读 MCP 工具，直到某字段到达目标值再唤醒',
    requires: ['background'],
    promptSection: backgroundSection,
  },
  {
    name: 'schedule_wakeup',
    title: '定时唤醒',
    description: '过一段时间带着备注唤醒 agent',
    requires: ['background'],
    promptSection: backgroundSection,
  },
  {
    name: 'cancel_background_task',
    title: '取消后台任务',
    description: '按 taskId 取消一个后台任务',
    requires: ['background'],
    promptSection: backgroundSection,
  },
  {
    name: 'run_in_background',
    title: '后台运行命令',
    description: '在沙箱后台跑超过一分钟的长命令，结束后唤醒',
    requires: ['background', 'sandbox'],
    promptSection: backgroundSection,
  },
];

export function buildBackendRegistry(deps: {
  media: MediaService;
  background: BackgroundService;
}): ToolRegistry<BackendHost> {
  const registry = new ToolRegistry<BackendHost>();
  registry.register({
    name: 'send_email',
    title: '发送邮件',
    description: '发送邮件（演示工具；外发动作，执行前需用户审批）',
    requires: ['email'],
    create: () => sendEmailTool,
    interruptOn: true,
    promptSection: SEND_EMAIL_SECTION,
  });
  registry.registerAll(
    shareFactory<BackendHost>(
      // createMediaTools 返回只读元组，shareFactory 收可变数组
      (ctx) => [
        ...createMediaTools(deps.media, {
          conversationId: ctx.conversationId,
          userId: ctx.userId,
        }),
      ],
      MEDIA_TOOL_ENTRIES,
    ),
  );
  registry.register({
    name: 'preview_page',
    title: '网页预览',
    description: '为用户弹出沙箱工作区里网页 / 运行中服务的可交互预览',
    requires: ['sandbox'],
    create: (ctx) => createPreviewPageTool(requireSandbox(ctx)),
  });
  registry.register({
    name: 'sync_media_to_sandbox',
    title: '媒体同步进沙箱',
    description: '把本会话的附件 / 生成的图片视频写进沙箱工作区，供命令处理',
    requires: ['sandbox', 'media_api'],
    create: (ctx) =>
      createSyncMediaTool(deps.media, requireSandbox(ctx), {
        conversationId: ctx.conversationId,
        userId: ctx.userId,
      }),
  });
  registry.registerAll(
    shareFactory<BackendHost>(
      (ctx) =>
        createBackgroundTools(deps.background, {
          conversationId: ctx.conversationId,
          userId: ctx.userId,
          sandbox: ctx.host.sandbox,
          mcpServers: ctx.host.mcpServers,
        }),
      BACKGROUND_TOOL_ENTRIES,
    ),
  );
  registry.register(getWeatherDescriptor);
  return registry;
}

/** 沙箱带来的能力；media_api / email / background 是 backend 固有的。 */
const SANDBOX_CAPABILITIES: readonly Capability[] = [
  'sandbox',
  'workspace',
  'workspace_write',
];

/** 按本轮沙箱有无描述运行环境（worker 与模式预览共用同一口径）。 */
export function backendEnvironment(
  sandbox: Pick<GuardedSandbox, 'visibleRoot' | 'skillsDir'> | null,
): RuntimeEnvironment {
  return {
    capabilities: new Set<Capability>([
      ...(sandbox ? SANDBOX_CAPABILITIES : []),
      'media_api',
      'email',
      'background',
    ]),
    workspace: sandbox?.visibleRoot,
    skillsDir: sandbox?.skillsDir ?? '/skills',
  };
}

/**
 * 环境段（resolveMode 的 envPromptBlock）：沙箱守则（有沙箱时）+ 附件说明。
 * 后台任务说明不在这里：它是后台工具的 promptSection，随勾选走。
 */
export function backendEnvPromptBlock(workspace: string | undefined): string {
  return (
    (workspace ? SANDBOX_SYSTEM_PROMPT_BLOCK(workspace) : '') +
    ATTACHMENTS_SECTION
  );
}

export const toolRegistryProvider: Provider = {
  provide: TOOL_REGISTRY,
  useFactory: (media: MediaService, background: BackgroundService) =>
    buildBackendRegistry({ media, background }),
  inject: [MediaService, BackgroundService],
};
