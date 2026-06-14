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
  CONVERSATION_NOT_FOUND: { code: 10001, message: 'Conversation not found' },
  CONVERSATION_GOAL_EMPTY: {
    code: 10002,
    message: 'Conversation goal cannot be empty',
  },
  CONVERSATION_BUSY: {
    code: 10003,
    message: 'Conversation is busy processing, please try again later',
  },
  COMMAND_NOT_FOUND: {
    code: 10004,
    message: 'Unknown command, please use / to view available commands',
  },
  AGENT_RUN_FAILED: { code: 20001, message: 'Agent execution failed' },
  PASSKEY_CHALLENGE_EXPIRED: {
    code: 30001,
    message: 'Challenge expired, please try again',
  },
  PASSKEY_VERIFY_FAILED: {
    code: 30002,
    message: 'Passkey verification failed',
  },
  PASSKEY_NOT_FOUND: {
    code: 30003,
    message: 'Passkey not found, please register first',
  },
  VERIFY_CODE_EXPIRED: {
    code: 30004,
    message: 'Verification code expired, please request a new one',
  },
  VERIFY_CODE_INVALID: { code: 30005, message: 'Invalid verification code' },
  VERIFY_CODE_TOO_FREQUENT: {
    code: 30006,
    message:
      'Verification code requested too frequently, please try again later',
  },
  RESEND_CONFIG_MISSING: {
    code: 30007,
    message: 'Email service API key is not configured',
  },
  INTERNAL_ERROR: {
    code: 50000,
    message: 'System is busy, please try again later',
  },
  SKILL_INSTALL_NOT_FOUND: {
    code: 40001,
    message: 'Skill source repository does not exist or the path is invalid',
  },
  SKILL_INSTALL_INVALID: { code: 40002, message: 'Skill verification failed' },
  SKILL_INSTALL_PATH_TRAVERSAL: {
    code: 40003,
    message: 'Tarball contains illegal path, decompression rejected',
  },
  SKILL_INSTALL_TOO_LARGE: {
    code: 40004,
    message: 'Skill directory exceeds 20MB size limit',
  },
  SKILL_NOT_FOUND: { code: 40005, message: 'Skill not found' },
  SANDBOX_NOT_FOUND: {
    code: 40006,
    message: 'Session sandbox does not exist or has been reclaimed',
  },
  INVALID_PATH: {
    code: 40007,
    message:
      'Path contains illegal characters (.. or absolute paths are not allowed)',
  },
  MEDIA_GENERATION_NOT_FOUND: {
    code: 60001,
    message: 'Media generation record does not exist',
  },
  MEDIA_VERSION_NOT_FOUND: {
    code: 60002,
    message: 'Media version does not exist',
  },
  MEDIA_ASSET_NOT_READY: {
    code: 60003,
    message: 'Media asset generation is not yet complete',
  },
  MEDIA_REF_INVALID: {
    code: 60004,
    message:
      'Invalid reference image (must be a successfully generated image version belonging to yourself)',
  },
} as const satisfies Record<string, ErrorDef>;
