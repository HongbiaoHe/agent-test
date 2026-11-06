import { z } from 'zod';

/**
 * Agent 模式：用户私有的一份装配配置——完整系统提示 + 勾选的代码工具 / MCP server / 技能 +
 * 可选的默认模型。web（Prisma AgentMode）与 desktop（SQLite agent_mode）各存各的，共用这份 schema
 * 做校验与收窄。没有内置模式：会话的 modeId 为空 = 「通用模式」（全部工具 / server / 技能，
 * 提示词为 GENERAL_MODE_PROMPT）。
 */

const trimmed = z.string().transform((s) => s.trim());

/** 用户可编辑的字段（web 的 DTO 与 desktop 的 RPC 参数都从这里派生）。 */
export const AgentModeInputSchema = z.object({
  name: trimmed.pipe(z.string().min(1).max(100)),
  /** 完整系统提示正文；平台规则用 {{platform.xxx}} 占位符引用（见 prompt-fragments.ts） */
  systemPrompt: z.string().min(1).max(100_000),
  /** 勾选的代码工具名（ToolRegistry 里的 name）；内置工具（文件工具 / write_todos / ask_user）不在此列 */
  toolNames: z.array(z.string().min(1)).default([]),
  /** 勾选的 MCP server id（RuntimeServer.id） */
  mcpServerIds: z.array(z.string().min(1)).default([]),
  /** 勾选的技能名（用户已装 / 宿主内置） */
  skillNames: z.array(z.string().min(1)).default([]),
  /** 新建会话时回填的默认模型 / 思考档位；只在创建时生效，之后以会话自己的值为准 */
  defaultModel: z.string().nullable().default(null),
  defaultThinkingLevel: z.string().nullable().default(null),
});
export type AgentModeInput = z.output<typeof AgentModeInputSchema>;

export const AgentModeSchema = AgentModeInputSchema.extend({
  id: z.string().min(1),
});
export type AgentMode = z.output<typeof AgentModeSchema>;

/**
 * 用户对通用模式的覆盖（每个用户一份）。通用模式的工具 / 连接器 / 技能恒为「全部，含以后新增」，
 * 不可勾选；能改的只有提示词与新建会话时回填的默认模型 / 思考档位。
 * systemPrompt 为 null = 用 core 的 GENERAL_MODE_PROMPT（「恢复默认」即把它置回 null）。
 */
export const GeneralModeSettingsSchema = z.object({
  systemPrompt: z.string().min(1).max(100_000).nullable().default(null),
  defaultModel: z.string().nullable().default(null),
  defaultThinkingLevel: z.string().nullable().default(null),
});
export type GeneralModeSettings = z.output<typeof GeneralModeSettingsSchema>;

/**
 * 通用模式（modeId 为空）的默认提示词：身份一句 + 平台片段占位符。用户「从通用复制」新建模式时
 * 拿到的就是这段文本，可以自由增删。
 */
export const GENERAL_MODE_PROMPT = `你是 Spark：一个带技能库（skills）与虚拟文件系统的任务执行助手，在多轮对话中为用户完成内容创作与自动化任务。你的回复以 Markdown 呈现给用户；工具调用过程用户可见，无需复述。

{{platform.language}}

{{platform.slash_command}}

{{platform.skill_loading}}

{{platform.injection_guard}}`;
