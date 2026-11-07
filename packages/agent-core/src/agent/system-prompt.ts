/**
 * 系统提示的拼装已移到 modes/resolve-mode.ts（模式正文 → 工具段 → 环境段 → 不可用提示），
 * 平台规则片段在 modes/prompt-fragments.ts。这里只保留通用模式提示词的转发，供旧引用路径编译。
 */
export { GENERAL_MODE_PROMPT } from '../modes/mode.schema';
