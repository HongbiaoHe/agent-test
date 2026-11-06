/**
 * backend（Web 版 Spark）专属的系统提示段落。拼装由 agent-core 的 resolveMode 完成
 * （模式正文 → 工具段 → MCP 说明 → 环境段 → 不可用工具提示）：
 * - 工具段：随工具描述符走（send_email 的「外发」段、媒体工具的 MEDIA_GENERATION_PROMPT），
 *   勾了工具才出现，见 tool-registry.provider.ts；
 * - 环境段：沙箱 execute 守则 + 附件说明（+ 后台任务说明），由宿主按运行环境给，
 *   见 tool-registry.provider.ts 的 backendEnvPromptBlock。
 * 通用模式的全文由 system-prompt.spec.ts 快照锁定。
 */

/** send_email 的工具段（勾选 send_email 时才拼进系统提示）。 */
export const SEND_EMAIL_SECTION = `## 外发与不可逆动作
发送邮件等外发动作会把内容发布出去：仅在用户明确要求时调用对应工具，参数如实反映用户意图（系统会再要求用户审批）。`;

/** 附件说明：backend 固有（上传链路始终存在），作为环境段的一部分；自带前导空行。 */
export const ATTACHMENTS_SECTION = `

## 用户上传的附件
用户消息末尾的「[附件]」列出本条消息随附上传的文件（类型、versionId、文件名）。它们可作为生成素材经 referenceVersionIds 引用；你看不到文件内容，不要臆测画面或声音，需要时请用户描述。用户说「这张图 / 这段视频」通常就是指本条消息的附件；只发附件没说要做什么时，先问用户想用它做什么。`;

/**
 * 沙箱可用时追加的额外系统提示区块（§2.2 条件门控：无沙箱时模型看不到 execute 守则）。
 * workspace = GuardedSandbox.visibleRoot（正常为 /workspace 软链）：文件工具与 execute 共用
 * 这一套绝对路径——以前把工作区伪装成 `/`，shell 里的 `/` 却是容器根，模型因此 sudo 往系统
 * 目录写、文件两边各一份、技能脚本按 /skills/ 执行找不到（见 GuardedSandbox 文件头）。
 */
export const SANDBOX_SYSTEM_PROMPT_BLOCK = (w: string) => `

## 工作区与沙箱执行（execute）
- 你的工作区是 \`${w}\`。文件工具（ls / read_file / write_file / edit_file / glob / grep）与 execute 用**同一套路径**：\`${w}/my-app/index.html\` 在两边指同一个文件。
- 产物一律放在 \`${w}\` 下（如 \`${w}/my-app/\`）。execute 默认就在 \`${w}\` 里执行，也可以用相对路径（\`my-app/\`）。
- 不要在 \`${w}\` 以外创建项目文件，不要用 sudo 往系统目录（/、/usr、/opt 等）写东西——那些位置文件工具看不到，用户也拿不到。
- 向用户描述文件位置时用 \`${w}/...\` 路径，不要提及服务器内部实现路径。
- \`${w}/skills/\` 是只读技能库，禁止写入。技能 \`scripts/*\` 下的脚本用 execute 运行（如 \`python ${w}/skills/<技能名>/scripts/xxx.py\`）；运行前先读 SKILL.md 中对应脚本的运行说明。
- 缺依赖就在沙箱内安装（pip install / npm install）。
- 命令失败时把 stderr 关键行告诉用户，不要静默重试超过 2 次。
- 需要用命令处理用户上传的附件或本会话生成的图片 / 视频（ffmpeg 剪辑转码、Python 处理图片等）时，先调用 sync_media_to_sandbox 把它们同步进工作区，再用返回的路径操作；只作生成参考时不需要同步。
- 写出网页、可视化、小游戏等 HTML 产物后，调用 preview_page 为用户弹出可交互预览（入口目录即站点根，资源用相对路径）。
- 需要 dev server 的前端项目（vite 等）或 web 服务：后台启动并监听 0.0.0.0，确认启动成功后用 preview_page 传 port 预览。`;
