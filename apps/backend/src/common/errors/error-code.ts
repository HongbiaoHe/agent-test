export interface ErrorDef {
  code: number;
  message: string;
}

/**
 * 业务错误集中定义，按域分段：
 * 1xxxx 会话域 / 2xxxx agent 域 / 5xxxx 系统域
 * 新增业务错误只需往这里加一条。
 */
export const ErrorCodes = {
  CONVERSATION_NOT_FOUND: { code: 10001, message: '会话不存在' },
  CONVERSATION_GOAL_EMPTY: { code: 10002, message: '会话目标不能为空' },
  AGENT_RUN_FAILED: { code: 20001, message: 'Agent 执行失败' },
  INTERNAL_ERROR: { code: 50000, message: '系统繁忙，请稍后重试' },
} as const satisfies Record<string, ErrorDef>;
