/**
 * main / agent-host 产生、会显示给用户的文案：IPC / RPC 报错（renderer 里进 toast）、
 * 对话里的命令结果与提示、OAuth 回调页。给模型看的提示词 / 工具描述 / 工具结果不在这里。
 */
export const errors = {
  store: {
    keychainUnavailable: '系统钥匙串不可用，无法安全保存密钥',
  },
  workspace: {
    notAbsolute: '工作区必须是绝对路径',
    singleQuote: "工作区路径不能包含单引号（'）",
    notDirectory: '工作区不是目录：{{dir}}',
    dirNotFound: '目录不存在：{{dir}}',
    outside: '路径不在工作区内：{{path}}',
    notFile: '不是文件：{{path}}',
  },
  fetch: {
    failed: '读取失败：HTTP {{status}}',
  },
  web: {
    invalidUrl: 'Web 后端地址必须是 http(s)',
    unreachable: '连不上 Web 后端 {{url}}：{{error}}',
    badResponse: 'Web 后端返回了无法识别的响应（HTTP {{status}}）',
    badResponseDetail: 'Web 后端 {{method}} {{path}} 返回无法识别的响应（HTTP {{status}}）：{{body}}',
    requestFailed: '请求失败（{{code}}）',
    uploadFailed: '上传到 Web 后端失败：{{error}}',
    sessionExpired: 'Web 账号登录已过期，请在 Spark 设置里重新登录',
    notSignedIn: '还没有登录 Web 账号：在设置里登录后才能使用生图 / 生视频 / 配音',
  },
  conversation: {
    notFound: '会话不存在：{{id}}',
    workspaceLocked: '会话已经开始，不能再更换工作目录；请新建会话',
    interrupted: '运行中断：应用在运行中退出或 agent 进程崩溃，请重新发送。',
    busyModeSwitch: '会话正在运行或等待审批，结束后再切换模式',
  },
  modes: {
    notFound: '模式不存在：{{id}}',
    unknownPlaceholder: '提示词里有未知的占位符：{{ids}}（只能引用 platform.* 片段）',
  },
  run: {
    busy: '这个会话正在运行，请先等它结束或点停止',
    emptyMessage: '消息不能为空',
    noPendingApproval: '当前没有待审批的操作',
    skillSyncFailed: '⚠️ 技能同步到工作区失败，本轮不使用技能：{{error}}',
  },
  attachments: {
    notFile: '不是文件：{{path}}',
    readFailed: '读取附件失败：{{path}}',
    tooLarge: '附件超过 50MB：{{name}}',
  },
  skills: {
    notFound: '技能不存在：{{name}}',
    alreadyExists: '已经有名为 {{name}} 的技能',
    noSkillMd: '所选文件夹里没有 SKILL.md：{{folder}}',
    invalid: '技能 {{name}} 校验失败：{{errors}}',
    fileTooLarge: '文件过大（>512KB）：{{path}}',
    dirTooLarge: '技能目录总大小超过 20MB',
    bodyTooLong: '正文超过 100000 字符',
    fromGithub: '{{name}} 是从 GitHub 安装的技能，不能覆盖；换个名字',
    badFilePath: '附带文件路径不合法：{{path}}',
    skillMdInFiles: 'SKILL.md 由 description 与正文生成，不要放进附带文件',
    extraFileTooLarge: '附带文件过大（>512KB）：{{path}}',
    builtinName: '{{name}} 是内置技能的名字，换一个',
    builtinDisable: '内置技能不能停用',
    builtinRemove: '内置技能不能删除',
    /** `/skills add` 命令在对话里的结果 */
    installed_other: '已安装 {{count}} 个技能：',
    installedHint: '输入 `/技能名 需求` 即可使用。',
    installFailed: '安装失败：{{error}}',
  },
  github: {
    missingRepo: '缺少要安装的仓库，例如 /skills add anthropics/skills',
    githubOnly: '目前只支持 GitHub 仓库：{{host}}',
    badRepoUrl: '无法识别的仓库地址：{{target}}',
    badRepo: '无法识别的仓库：{{target}}（写法如 owner/repo）',
    dotPath: '路径不能包含 . 或 ..',
    downloadFailed: '下载失败（HTTP {{status}}）：{{repo}}@{{ref}}',
    repoNotFound: '找不到仓库或分支：{{repo}}',
    repoNotFoundDefault: '找不到仓库或分支：{{repo}}（试过 main / master）',
    unsafePath: '压缩包里有越界路径：{{path}}',
    tooLarge: '仓库内容超过 50MB，请用 --skill 或子路径缩小范围',
    noSkillMd: '在 {{location}} 里没有找到 SKILL.md',
    noNamedSkill: '仓库里没有名为 {{names}} 的技能',
    tooMany_other: '仓库里有 {{count}} 个技能，请用 --skill <名字> 指定要装哪些',
  },
  mcp: {
    invalidUrl: '连接器地址无效',
    httpsRequired: '连接器地址必须是 https（本机地址可以用 http）',
    unknownPreset: '没有这个推荐连接器：{{key}}',
    authExpired: '授权已过期或无效，请回到 Spark 重新连接',
    authCorrupted: '授权状态损坏，请回到 Spark 重新连接',
    toolNotFound: '工具不存在：{{name}}',
    toolNotAllowed: '这个工具不允许由卡片调用：{{name}}',
    needsConfirm: '调用 {{name}} 需要先经你确认',
    noAppContent: '连接器没有返回卡片内容',
    serverNotFound: '连接器不存在：{{id}}',
  },
  /** MCP OAuth 回调页（浏览器里显示） */
  oauth: {
    missingParams: '回调缺少 code 或 state',
    incomplete: '授权未完成',
    done: '授权完成',
    connected: '{{name}} 已连接，可以回到 Spark 继续。',
    failed: '授权失败',
  },
  background: {
    notFound: '后台任务不存在：{{id}}',
  },
} as const;
