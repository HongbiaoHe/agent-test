export interface ErrorDef {
  code: number;
  message: string;
}

/**
 * 业务错误集中定义，按域分段：
 * 1xxxx 会话域 / 2xxxx agent 域 / 3xxxx 认证域(passkey) / 4xxxx 技能与沙箱域 / 5xxxx 系统域 / 6xxxx 媒体生成域 / 7xxxx 画布域 / 11xxxx 设计域
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
  SKILL_NAME_TAKEN: {
    code: 40014,
    message:
      'A skill with this name already exists, please choose another name',
  },
  SKILL_NOT_EDITABLE: {
    code: 40015,
    message: 'Only skills you wrote yourself can be edited',
  },
  SANDBOX_NOT_FOUND: {
    code: 40006,
    message: 'Session sandbox does not exist or has been reclaimed',
  },
  SANDBOX_NOT_RUNNING: {
    code: 40008,
    message: 'Sandbox is not running; desktop unavailable',
  },
  SANDBOX_PROVIDER_NOT_CONFIGURED: {
    code: 40009,
    message: 'This sandbox provider is not configured on the server',
  },
  SANDBOX_NETWORK_UNSUPPORTED: {
    code: 40010,
    message:
      "Outbound network on this Daytona account is managed by Daytona (Tier 1–2) and can't be limited per sandbox. Use E2B for outbound limits.",
  },
  SANDBOX_SIZE_UNSUPPORTED: {
    code: 40016,
    message:
      'The current sandbox provider does not support switching sandbox size',
  },
  SANDBOX_SIZE_INVALID: {
    code: 40017,
    message: 'Unknown sandbox size, or it is already the current size',
  },
  SANDBOX_MIGRATION_BLOCKED: {
    code: 40018,
    message:
      'An agent run or background task is still active; wait for it to finish (or stop it) before switching sandbox size',
  },
  SANDBOX_EXCLUDES_INVALID: {
    code: 40020,
    message: 'Invalid exclusion list (paths must be inside the workspace)',
  },
  SANDBOX_INVENTORY_UNAVAILABLE: {
    code: 40021,
    message: 'Could not reach your sandbox to list its files; try again',
  },
  SANDBOX_MIGRATING: {
    code: 40019,
    message:
      'Your sandbox is being migrated to a new size; try again when it finishes',
  },
  PREVIEW_SANDBOX_NOT_RUNNING: {
    code: 40011,
    message:
      'Sandbox is not running; start the service in a conversation, then open the preview again',
  },
  PREVIEW_NOT_FOUND: {
    code: 40013,
    message: 'Preview not found or expired',
  },
  PREVIEW_PORT_NOT_ALLOWED: {
    code: 40012,
    message:
      'This port is reserved by the sandbox provider and cannot be previewed',
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
      'Invalid reference (must be a generated or uploaded image/video/audio version belonging to yourself)',
  },
  MEDIA_UPLOAD_UNSUPPORTED: {
    code: 60005,
    message:
      'Unsupported file type (allowed: JPEG/PNG/WebP images, MP4/MOV videos, MP3/WAV/M4A audio)',
  },
  MEDIA_UPLOAD_TOO_LARGE: {
    code: 60006,
    message: 'File too large (images ≤ 20MB, videos ≤ 200MB, audio ≤ 50MB)',
  },
  MEDIA_UPLOAD_FAILED: {
    code: 60007,
    message: 'File upload failed, please try again',
  },
  MEDIA_NOT_REGENERABLE: {
    code: 60009,
    message: 'Uploaded files cannot be regenerated',
  },
  MEDIA_REF_MOCK: {
    code: 60010,
    message:
      'Real generation cannot use mock (simulated) outputs as references: generate those upstream nodes for real first',
  },
  MEDIA_ATTACHMENT_INVALID: {
    code: 60008,
    message:
      'Invalid attachment (must be a file uploaded to this conversation and not yet sent)',
  },
  CANVAS_NOT_FOUND: { code: 70001, message: 'Canvas session not found' },
  CANVAS_GOAL_EMPTY: { code: 70002, message: 'Canvas goal cannot be empty' },
  CANVAS_BUSY: {
    code: 70003,
    message: 'Canvas agent is running, structural edits are locked',
  },
  CANVAS_CONFLICT: {
    code: 70004,
    message: 'Canvas has changed since your last sync, please reload',
  },
  CANVAS_NODE_NOT_FOUND: { code: 70005, message: 'Canvas node not found' },
  CANVAS_TITLE_EMPTY: { code: 70006, message: 'Canvas title cannot be empty' },
  CANVAS_EDGE_INVALID: {
    code: 70007,
    message:
      'Invalid connection (target node does not accept this source output type)',
  },
  CANVAS_PROMPT_REQUIRED: {
    code: 70008,
    message: 'This generation node has no prompt: write one on the node first',
  },
  CANVAS_SKILL_NOT_FOUND: { code: 70009, message: 'Canvas skill not found' },
  CANVAS_SKILL_BUILTIN: {
    code: 70010,
    message: 'Built-in skills cannot be deleted or disabled',
  },
  CANVAS_MOCK_DISABLED: {
    code: 70012,
    message:
      'Mock mode is disabled in this environment: turn Mock off on this canvas to generate',
  },
  CANVAS_UPSTREAM_NOT_READY: {
    code: 70013,
    message:
      'An upstream node has no output yet and is not generating: generate it first',
  },
  CANVAS_UPLOAD_TYPE_MISMATCH: {
    code: 70011,
    message:
      'This file does not fit the node (image upload nodes take images, video upload nodes take videos, audio upload nodes take audio)',
  },
  MCP_SERVER_NOT_FOUND: { code: 80001, message: 'MCP connector not found' },
  MCP_INVALID_URL: {
    code: 80002,
    message: 'Connector URL must be https (http is only allowed for localhost)',
  },
  MCP_SERVER_EXISTS: {
    code: 80003,
    message: 'A connector with this URL already exists',
  },
  MCP_PRESET_NOT_FOUND: { code: 80004, message: 'Unknown connector preset' },
  MCP_TOOL_NOT_FOUND: {
    code: 80005,
    message: 'Tool not found on this connector — try refreshing its tools',
  },
  MCP_TOOL_NOT_ALLOWED: {
    code: 80006,
    message: 'This tool is disabled or not callable from the app',
  },
  MCP_TOOL_NEEDS_CONFIRM: {
    code: 80007,
    message: 'This tool requires your confirmation before it runs',
  },
  MCP_AUTH_REQUIRED: {
    code: 80008,
    message: 'The connector needs to be reconnected',
  },
  MCP_OAUTH_STATE_INVALID: {
    code: 80009,
    message: 'Authorization expired or was already used, please try again',
  },
  MCP_REQUEST_FAILED: { code: 80010, message: 'MCP server request failed' },
  BACKGROUND_TASK_NOT_FOUND: {
    code: 90001,
    message: 'Background task not found',
  },
  // 设计域（design 模块，11xxxx）
  DESIGN_NOT_FOUND: { code: 110001, message: 'Design not found' },
  DESIGN_OP_INVALID: { code: 110002, message: 'Invalid design operation' },
  DESIGN_CONFLICT: {
    code: 110003,
    message: 'Design changed concurrently, please retry',
  },
  DESIGN_BUSY: {
    code: 110004,
    message:
      'The design agent is already running, wait for it or stop it first',
  },
  DESIGN_LAYER_LOCKED: {
    code: 110005,
    message:
      'This image layer is generating: its image source is locked until it finishes',
  },
  DESIGN_UPLOAD_INVALID: {
    code: 110006,
    message: 'Only PNG / JPEG / WebP images up to 20MB are supported',
  },
  DESIGN_NO_IMAGE_MODEL: {
    code: 110007,
    message: 'No image model with transparent background is available',
  },
  DESIGN_LAYER_NOT_IMAGE: {
    code: 110008,
    message: 'Only image layers can be generated',
  },
  DESIGN_DECOMPOSE_UNAVAILABLE: {
    code: 110009,
    message: 'Layer decomposition is not configured (BYTEPLUS_ARK_API_KEY)',
  },
} as const satisfies Record<string, ErrorDef>;
