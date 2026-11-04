import {
  DEFAULT_DESIGN_MODEL,
  DESIGN_MODEL_IDS,
} from '@agent-test/design-schema';
import { createDeepAgent, StateBackend } from 'deepagents';
import {
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from 'langchain';
import { initChatModel } from 'langchain/chat_models/universal';
import { thinkingModelParams } from '../../agent/thinking-level';
import { buildDesignSystemPrompt } from './design.prompt';
import { buildPreviewInjection } from './preview-injection';

/** render_preview / inspect_layers 的图补成用户消息（原因见 preview-injection.ts）。 */
const previewInjectionMiddleware = createMiddleware({
  name: 'designPreviewInjectionMiddleware',
  beforeModel: (state) => buildPreviewInjection(state),
});

/**
 * 设计 agent 装配。与主 agent、画布 agent 完全独立（独立提示词 / 工具 / 模型白名单 / 队列）。
 *
 * 不接 checkpointer：每轮由 processor 从 DesignMessage 重放历史（deepagents 跑完一轮 state 为空，
 * 同 thread 续跑本来也拿不到上文）。也不设 interruptOn：问题 10 定的是全自动，
 * 防失控靠单次运行生图上限 + 调用次数中间件 + 停止按钮。
 */
export function resolveDesignModel(model?: string | null): string {
  const ids: readonly string[] = DESIGN_MODEL_IDS;
  return model && ids.includes(model) ? model : DEFAULT_DESIGN_MODEL;
}

export async function buildDesignAgent(opts: {
  model?: string | null;
  tools: unknown[];
  /** 配了 BytePlus key：初始生成走「整图 + 拆层」，复刻 / 拆分直接拆原图 */
  seedream: boolean;
}) {
  const name = resolveDesignModel(opts.model);
  // includeThoughts：让 Gemini 把思考正文随响应返回，对话面板逐段展示（auto 档不改思考深度）
  const model = await initChatModel(name, {
    modelProvider: 'google-genai',
    ...thinkingModelParams(name, 'auto'),
  });
  return createDeepAgent({
    model,
    systemPrompt: buildDesignSystemPrompt({ seedream: opts.seedream }),
    // createDeepAgent 的 tools 参数是 StructuredTool 的联合，工具由 createDesignTools 产出（同画布写法）
    tools: opts.tools as never[],
    backend: new StateBackend(),
    middleware: [
      modelCallLimitMiddleware({ threadLimit: 80, exitBehavior: 'end' }),
      toolCallLimitMiddleware({ threadLimit: 200, exitBehavior: 'continue' }),
      previewInjectionMiddleware,
    ],
  });
}
