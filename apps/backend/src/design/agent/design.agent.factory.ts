import { buildAgent } from '@agent-test/agent-core/agent/agent.factory';
import {
  DEFAULT_DESIGN_MODEL,
  DESIGN_MODEL_IDS,
} from '@agent-test/design-schema';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { StateBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { buildDesignSystemPrompt } from './design.prompt';
import { buildPreviewInjection } from './preview-injection';

/** render_preview / inspect_layers 的图补成用户消息（原因见 preview-injection.ts）。 */
const previewInjectionMiddleware = createMiddleware({
  name: 'designPreviewInjectionMiddleware',
  beforeModel: (state) => buildPreviewInjection(state),
});

/**
 * 设计 agent 装配：走 agent-core 的 buildAgent（与 Spark 同一套中间件链与工具入参自愈），
 * 只换掉设计专属的部分（独立提示词 / 工具 / 模型白名单 / 预览图注入中间件）。
 *
 * 不接 checkpointer：每轮由 processor 从 DesignMessage 重放历史（deepagents 跑完一轮 state 为空，
 * 同 thread 续跑本来也拿不到上文）。也不挂技能、不要 ask_user、不设审批：问题 10 定的是全自动，
 * 防失控靠单次运行生图上限 + 调用次数守护 + 停止按钮。
 */
export function resolveDesignModel(model?: string | null): string {
  const ids: readonly string[] = DESIGN_MODEL_IDS;
  return model && ids.includes(model) ? model : DEFAULT_DESIGN_MODEL;
}

export async function buildDesignAgent(opts: {
  model?: string | null;
  tools: readonly StructuredToolInterface[];
  /** 配了 BytePlus key：初始生成走「整图 + 拆层」，复刻 / 拆分直接拆原图 */
  seedream: boolean;
}) {
  return buildAgent({
    systemPrompt: buildDesignSystemPrompt({ seedream: opts.seedream }),
    tools: opts.tools,
    backend: new StateBackend(),
    // 设计白名单全是裸 gemini 名：buildAgent 按 google-genai 装配，思考档位 auto（includeThoughts，
    // 对话面板逐段展示思考）
    model: resolveDesignModel(opts.model),
    askUser: false,
    guardrails: { modelCallLimit: 80, toolCallLimit: 200 },
    middleware: [previewInjectionMiddleware],
  });
}
