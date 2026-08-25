export type ConversationEventType =
  | 'token'
  | 'reasoning' // 模型思考过程增量（推理型模型才有；落 messages 表，但不回放给模型）
  | 'message'
  | 'tool_start'
  | 'tool_end'
  | 'plan_update'
  | 'control_request'
  | 'result'
  | 'media_update' // 媒体生成卡片状态变更（不落 messages 表，仅经 Redis Stream 推流）
  | 'canvas_patch' // 画布节点/边增量变更（画布模块专用，不落 messages 表，仅经 Redis Stream 推流）
  | 'token_usage' // 单次模型调用 token 用量（画布模块专用，不落 messages 表，仅经 Redis Stream 推流）
  | 'messages_cleared' // 会话记录与 agent 上下文被清空（画布模块专用；各端据此清空本地对话投影）
  | 'error';

export interface ConversationEvent {
  seq: string; // Redis Stream id（发布时由 XADD 生成）
  conversationId: string;
  type: ConversationEventType;
  payload: unknown;
  ts: number;
}
