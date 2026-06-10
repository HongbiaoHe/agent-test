export interface ErrorDef {
  code: number;
  message: string;
}

/**
 * 业务错误集中定义，按域分段：
 * 1xxxx 会话域 / 2xxxx agent 域 / 3xxxx 认证域(passkey) / 4xxxx 技能与沙箱域 / 5xxxx 系统域 / 6xxxx 媒体生成域
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
  SKILL_INSTALL_NOT_FOUND: { code: 40001, message: '技能源仓库不存在或路径无效' },
  SKILL_INSTALL_INVALID: { code: 40002, message: '技能校验失败' },
  SKILL_INSTALL_PATH_TRAVERSAL: { code: 40003, message: 'tarball 含非法路径，拒绝解压' },
  SKILL_INSTALL_TOO_LARGE: { code: 40004, message: '技能目录超出 20MB 大小限制' },
  SKILL_NOT_FOUND: { code: 40005, message: '技能不存在' },
  SANDBOX_NOT_FOUND: { code: 40006, message: '会话沙箱不存在或已回收' },
  INVALID_PATH: { code: 40007, message: '路径含非法字符（不允许 .. 或绝对路径）' },
  MEDIA_GENERATION_NOT_FOUND: { code: 60001, message: '媒体生成记录不存在' },
  MEDIA_VERSION_NOT_FOUND: { code: 60002, message: '媒体版本不存在' },
  MEDIA_ASSET_NOT_READY: { code: 60003, message: '媒体资产尚未生成完成' },
  MEDIA_REF_INVALID: { code: 60004, message: '参考图无效（需为本人已生成完成的图片版本）' },
} as const satisfies Record<string, ErrorDef>;
