export type ConversationEventType =
  | 'token'
  | 'message'
  | 'tool_start'
  | 'tool_end'
  | 'plan_update'
  | 'control_request'
  | 'result'
  | 'media_update' // 媒体生成卡片状态变更（不落 messages 表，仅经 Redis Stream 推流）
  | 'canvas_patch' // 画布节点/边增量变更（画布模块专用，不落 messages 表，仅经 Redis Stream 推流）
  | 'token_usage' // 单次模型调用 token 用量（画布模块专用，不落 messages 表，仅经 Redis Stream 推流）
  | 'error';

export interface ConversationEvent {
  seq: string; // Redis Stream id（发布时由 XADD 生成）
  conversationId: string;
  type: ConversationEventType;
  payload: unknown;
  ts: number;
}
