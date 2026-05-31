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
  CONVERSATION_BUSY: { code: 10003, message: '会话正在处理中，请稍后再发送' },
  COMMAND_NOT_FOUND: { code: 10004, message: '未知命令，请用 / 查看可用命令' },
  AGENT_RUN_FAILED: { code: 20001, message: 'Agent 执行失败' },
  PASSKEY_CHALLENGE_EXPIRED: { code: 30001, message: '挑战已过期，请重试' },
  PASSKEY_VERIFY_FAILED: { code: 30002, message: 'Passkey 验证失败' },
  PASSKEY_NOT_FOUND: { code: 30003, message: '未找到该 Passkey，请先注册' },
  INTERNAL_ERROR: { code: 50000, message: '系统繁忙，请稍后重试' },
} as const satisfies Record<string, ErrorDef>;
