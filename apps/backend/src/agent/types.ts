export type ConversationEventType =
  | 'token'
  | 'message'
  | 'tool_start'
  | 'tool_end'
  | 'plan_update'
  | 'control_request'
  | 'result'
  | 'error';

export interface ConversationEvent {
  seq: string; // Redis Stream id（发布时由 XADD 生成）
  conversationId: string;
  type: ConversationEventType;
  payload: unknown;
  ts: number;
}
