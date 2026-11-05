# Spark 桌面端设计

> 状态：**待确认**（未动代码）· 2026-11-05 · v3
> v3 改动：路径方案改为复用 GuardedSandbox（v2 的做法是 backend 已实测失败的）；抽取顺序改为先参数化后搬迁；补开发回路；工作目录定为 agent 专用目录；安全边界表述改正；拆成三个实施计划。
> 范围：新建 `apps/desktop`，在本机实现 Spark 对话 agent。本文只覆盖第一期（§1）。

## 0. 结论先行

| 决策 | 结论 |
|---|---|
| 外壳 | Electron + electron-vite，用 electron-builder 打包 |
| agent 跑在哪 | 本机：Electron `utilityProcess` 里的 agent-host 进程，不依赖公司后端 |
| 执行环境 | **只用本机**：deepagents `LocalShellBackend` 外面套现有的 `GuardedSandbox`（§6）。不接远端沙箱 |
| 模型 Key | 用户自己填，用 Electron `safeStorage` 加密后存本机 |
| 账号 / 登录 | 不需要 |
| 数据 | 和 Web 版**互相隔离**，存本机 SQLite。ID 用 UUID，表结构参照 Prisma |
| 代码复用 | 从 backend 抽出 `packages/agent-core`（§3）。运行编排在 desktop 里重写（§4） |
| 实施 | 拆成 3 个计划（§10）：A 抽取 agent-core → B 桌面端最小可用 → C 技能 + MCP + 附件 |

**没选的方案**
- **Tauri + Node sidecar**：要同时维护 Rust 和 Node 两套运行时，换来的只是安装包更小。
- **把 NestJS + MySQL + Redis 整套打包进桌面端**：相当于在用户电脑上部署一台服务器。
- **文件工具把工作区伪装成 `/`、shell 用相对路径**（v2 方案）：backend 2026-10-17 实测过，模型会往系统目录写、文件两边各一份、技能脚本找不到（`apps/backend/src/agent/guarded-sandbox.ts:10-14`）。

## 1. 范围

**第一期做**
- 对话 agent：流式输出、停止、`ask_user`、审批中断后续跑、选模型和思考档位、`/command`、计划延续（activePlan）
- 本机执行：用 `execute` 跑 shell，文件工具限制在工作区里读写
- 技能：从 `.tar.gz` 或文件夹安装、列表、启用/停用、对话中使用
- MCP 连接器：添加 server、OAuth 授权、工具调用、工具需审批
- 附件：选择本地文件，或拖进对话框

**第一期不做**
- 画布、海报设计、媒体生成（aigc 是内部服务）、配音、后台任务
- `preview_page` / 端口预览
- `send_email`：依赖服务端的 Resend Key
- MCP Apps 卡片：依赖 `preview-host`（`apps/backend/src/mcp/mcp-sandbox.ts:3`）
- 自动更新、抽取 `packages/ui`、与 Web 版同步
- 按命令前缀放行审批（第一期只有"信任此工作目录"的开关，见 §6）

## 2. 进程结构

```
main 进程        窗口 / 菜单、safeStorage 存 Key、文件选择框、拉起和重启 agent-host
   │  转交 MessagePort
   ├─ renderer   React 19 + Vite + TanStack Query + Tailwind v4 + shadcn
   │             nodeIntegration=false, contextIsolation=true, sandbox=true
   └─ agent-host (utilityProcess)
                 RunService（§4）、SQLite（唯一写入者）、checkpointer、
                 GuardedSandbox(LocalShellBackend)、MCP 客户端
```

- **renderer ↔ agent-host**：直接用 MessagePort 通信。消息格式用 zod 定义在 `packages/desktop-ipc` 里，两边共用类型，收到消息时也做运行时校验。
- **Key 怎么注入**：provider 包是从 env 里读 Key 的（`agent.factory.ts:150`）。main 进程用 `utilityProcess.fork(..., { env })` 把解密后的 `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY` 只传给 agent-host。用户改了 Key 就重启 agent-host（有运行中的任务时，等它结束或停止后再重启）。renderer 只知道"某个提供方配了 Key 没有"。
- **shell 子进程用空环境**：`LocalShellBackend` 的 `env` 不传就是空环境，`inheritEnv` 默认 `false`（`deepagents/dist/index.d.ts:1489-1502`）。我们只显式传 `PATH`、`HOME`、`LANG`、`TMPDIR`。**这只能防意外泄露**（比如命令输出 `env` 被发回模型、写进日志），不是安全隔离：同一用户的任何进程都能读到 agent-host 的环境和内存。真正的边界是 §6 的审批门和文件守卫。
- **流式事件**：复用 agent-core 的 `event-normalizer`，经 MessagePort 推给 renderer。

## 3. agent-core 抽取（`packages/agent-core`）

**顺序：先在 backend 里就地参数化，再搬干净的文件。** 这样 `send-email` 不用搬过去又搬回来，每一步都是可单独合并的 backend 重构。

**第 1 步：就地参数化 `buildAgent`（有逻辑改动，backend 内完成）**

1. **工具**：`buildAgent` 写死了 `sendEmailTool`（`agent.factory.ts:273-278`）和 `send_email: true`（`:290`）。改成由调用方经 `extraTools` / `extraInterruptOn` 传入；worker 传 `send_email`。
2. **系统提示词**：`BASE_SYSTEM_PROMPT` 里混着宿主专属段落（生图/生视频、配音、附件 versionId，`:47-60`）；沙箱区块写死了 `sync_media_to_sandbox` 和 `preview_page`（`:74-83`）。拆成**通用段**（留在 agent-core）和**宿主段**（新参数 `systemPromptSections`，调用方传入）。沙箱区块保留通用部分（工作区路径、技能库、相对路径、不要 sudo），宿主专属的行由调用方追加。
3. **`userId`**：`contextSchema` 要求必填（`:109-112`），保持不变，desktop 固定传 `'local'`。
4. **快照测试**：用现有 worker 的调用方式拼出完整提示词，快照锁住，保证 backend 的提示词逐字不变。
5. **MCP 类型拆分**：`RuntimeServer` 和 `McpAuthRequiredError` 是纯类型和纯 `Error` 子类（`mcp.service.ts:75-89`），移到 `mcp-types.ts`，解除 `mcp-agent-tools.ts:6-7` 对 `mcp.service` 的依赖。
6. **skill-installer 异常**：`skill-installer.ts:30` 的 `BusinessException` 改为 agent-core 自己的 `SkillInstallError`（带错误码），service 层转成 `BusinessException`。

每一小步 backend jest 全绿后单独提交。

**第 2 步：搬迁（不改逻辑）**

已用 grep 核实以下文件不依赖 Nest、Prisma、Redis（匹配 `@nestjs`、`@prisma`、`ioredis`、`bullmq` 和跨模块相对引用，0 命中）：
- `agent/`：`agent.factory.ts`、`guarded-sandbox.ts`（只依赖 `node:path` 和 type-only 的 `GuardableSandbox`，`:48-61`）、`models.ts`、`portable-content.ts`、`plan-injection.ts`、`thinking-level.ts`、`token-usage.ts`、`event-normalizer.ts`、`reasoning-parts.ts`、`types.ts`、`sandbox-providers/types.ts` 里的 `GuardableSandbox` 类型，以及 `tools/` 下的 `get-weather`、`ask-user`
- `skills/`：`skill-parser.ts`、`skill-files.ts`、`skill-installer.ts`（第 1 步改完后）
- `mcp/`：`mcp-client.ts`、`mcp-agent-tools.ts`（第 1 步改完后）、`mcp-naming.ts`、`mcp-result.ts`、`mcp-schema.ts`、`mcp-types.ts`、`mcp-crypto.ts`
- `conversations/message-content.ts`（`userMessageText`，worker 在用：`agent.processor.ts:23`）
- `commands/parse-command.ts`

spec 文件跟着搬。backend 原位置改成 re-export，调用方不动。不搬：`send-email`（留 backend）、`preview-page`（依赖 `preview/` 和 sandbox，`preview-page.tool.ts:3-4`）。

**包形态与开发回路**
- backend 没有 `"type"` 字段，`module: nodenext` 下按 **CommonJS** 输出，所以 agent-core 和 `design-schema` 一样出 CommonJS。
- 和 `design-schema` 一样构建到 `dist`、backend 吃 `dist`。但 `nest --watch` 不监听 `packages/`，所以 agent-core 配 `tsc --watch`，并接进 `scripts/dev.mjs` 和 `ecosystem.config.cjs`，改一行 backend 就能看到。
- jest：backend 的 jest `rootDir` 是 `src`，搬走的 spec 在 agent-core 里用自己的 jest 配置跑。

## 4. RunService（agent-host 的运行编排）

backend 的运行编排在 Nest worker 里（`apps/backend/src/worker/agent.processor.ts`），和 Prisma、BullMQ 绑在一起，不直接复用。desktop 参照它的步骤在 `apps/desktop/src/agent-host/run/` 重写一份。代价是两边有重复；以后要做同步时再考虑抽共用部分。

**接口**
```ts
startRun(conversationId: string, userMessage: UserMessageInput): void
resume(conversationId: string, decisions: HitlDecision[]): void
stop(conversationId: string): void
// 进度和结果经 MessagePort 以事件推出，不走返回值
```

**一轮的步骤**（对照 processor）：
1. 置 `status = running`；
2. 同步技能到工作区（§6）；
3. 从 `Message` 表重放历史，解析 `/command`；
4. 构造 activePlan；
5. 组装 MCP 工具和提示词；
6. 调 `buildAgent`；
7. 流式运行；
8. 消息、token 用量、审批写库；
9. 置为 `done` / `waiting_approval` / `failed` / `stopped`。

**并发与停止**：同一会话同时只跑一轮，第二次 `startRun` 直接拒绝。用 `AbortController` 中止。停止后正在执行的子进程会不会一起被杀，见 §9。

## 5. 数据

- **存储**：SQLite（better-sqlite3 + Drizzle），`app.getPath('userData')/spark.db`，只有 agent-host 写。schema 迁移用 Drizzle 生成的 SQL，随应用打包，启动时自动执行。
- **表**：`Conversation`、`Message`、`ConversationTokenUsage`、`Approval`、`Skill`、`McpServer`，字段对照 `apps/backend/prisma/schema.prisma` 的同名模型；去掉 `tenantId`、`userId`、`mcpAppContext`；主键 UUID。
- **历史与 checkpointer**：每轮从 `Message` 重放完整历史（同 `agent.processor.ts:191-192`）。checkpointer 只用于审批中断后的续跑，用 `@langchain/langgraph-checkpoint-sqlite`，和业务数据放同一个数据库文件。
- **附件**：发送时把文件**复制**到 `<工作区>/attachments/<conversationId>/`，消息里记录工作区路径。单个上限 50MB。重放时文件不在了，就在那条消息里标"附件已丢失"，跳过其内容，这一轮照常跑。

## 6. 工作区、路径、技能与安全

**工作区是 agent 专用目录，不是"用户的项目目录"。** 默认 `~/Spark`，可以在设置里换，但设置页要写明：这个目录由 Spark 管理，里面会有 `skills/` 和 `attachments/`。用户的项目放在工作区的子目录里（比如 `~/Spark/my-app/`）。没选"把用户任意目录当工作区"，是因为我们会往里写技能和附件，而且 `GuardedSandbox` 的技能目录写死在 `${visibleRoot}/skills`（`guarded-sandbox.ts:81-84`），改它没有收益。

**执行环境的组合**
```
GuardedSandbox(
  inner = LocalShellBackend({ rootDir: 工作区, virtualMode: false, timeout: 120, maxOutputBytes: 100_000, env: 白名单 }),
  workspaceRoot = 工作区真实路径,
  visibleRoot   = 工作区真实路径   // 不需要软链
)
```
- `GuardedSandbox` 接受任何 `GuardableSandbox`（`guarded-sandbox.ts:74-79`）。`LocalShellBackend` 有 `isRunning`、`close`，缺 `start`/`stop`（`index.d.ts:1560-1585`），desktop 写一个几行的适配类补上空实现。
- 文件工具与 `execute` 用**同一条真实路径**，和 backend 现状一致，backend 的沙箱提示词区块可以直接复用。
- 文件工具（ls/read/write/edit/glob/grep）被守卫硬限制在工作区内：`../` 和域外绝对路径返回 error（`guarded-sandbox.ts:16-21`）。
- `execute` 只做 cwd 锚定，**不隔离**，`cat /etc/passwd` 照样能跑（`guarded-sandbox.ts:25-28`）。所以：
  - `execute` 默认**每条都要审批**，走 `interruptOn`；
  - 设置里可对当前工作区选择"信任此目录"，之后不再审批；换工作区即失效。

**技能**
- 事实来源是 `Skill` 表 + `userData/skills/<名>/` 下的文件。
- 每轮开跑前把已启用的技能**同步**到 `<工作区>/skills/`：新增的复制、变更的覆盖、停用或删除的**从工作区删掉**。不是单纯复制，否则停用的技能会残留并继续被模型看到。
- `buildAgent` 的 `workspace` 传工作区真实路径，技能扫描目录即 `<工作区>/skills/`（`agent.factory.ts:281`），和 backend 一致。

**MCP OAuth**：系统浏览器打开授权页，回调到本机固定端口的 loopback 地址（如 `http://127.0.0.1:<port>/callback`）。token 用 `safeStorage` 加密后存 `McpServer` 表。MCP SDK 的 `OAuthClientProvider` 要为 desktop 另写一份（backend 那份绑了 Prisma 和 Redis）。

## 7. 界面（renderer）

- **页面**：会话列表 + 对话页（消息流、思考过程、工具调用、审批卡片、`ask_user` 卡片）；设置页（Key、默认模型、工作区、信任开关）；技能页；MCP 页。
- **样式**：设计 token 复制 `apps/frontend/src/app/globals.css` 的 token 部分，暗色模式同样用 `.dark`；组件用 shadcn CLI 初始化。
- 对话组件参照 `apps/frontend` 重写，不直接共用（它们绑了 Next.js 和 socket.io 的数据层）。

## 8. 出错处理

| 情况 | 处理 |
|---|---|
| 所选模型没配 Key | renderer 发送前拦下，引导去设置页 |
| 模型 4xx/5xx | 这一轮置 `failed`，对话里显示上游错误，不自动重试 |
| agent-host 崩溃 | main 拉起新进程；新进程**启动时**把所有 `status = running` 的会话改成 `failed`，并追加一条"运行中断"消息 |
| 等审批或 `ask_user` 时应用被关 | 会话停在 `waiting_approval`，中断态在 checkpointer 里，重开后可继续 |
| 命令超过 120 秒 | `LocalShellBackend` 终止命令，按超时返回给模型 |
| 工作区被删或没权限 | 开跑前检查，失败置 `failed` 并提示重选 |
| 附件丢失 | 见 §5 |
| 技能安装失败 | `SkillInstallError` 错误码映射成界面提示 |

## 9. 测试与待验证

**测试**
- **agent-core / backend**：第 1 步每一小步 backend jest 全绿；提示词快照测试。搬走的 spec 在 agent-core 跑，两边都要绿。跑 jest 前先切 Node 22，否则 jest 静默崩溃但退出码 0（假绿）。
- **agent-host**：`FakeListChatModel` 集成测试：发消息 → 调工具 → 审批 → 续跑 → 落库；另测崩溃恢复、附件丢失、技能同步会删除停用项。
- **桌面端**：Playwright `_electron` 冒烟：启动 → 填 Key → 发一条消息 → 审批一条命令。
- **所有改动**：`pnpm lint` 和 `tsc` 0 error。

**待验证**（计划 B 开工前先做最小实验）
1. `@langchain/langgraph-checkpoint-sqlite` 和 better-sqlite3 能否在 Electron utilityProcess 里跑（原生模块 rebuild、asarUnpack）。
2. 停止运行（abort）时，`LocalShellBackend` 正在执行的子进程会不会被杀掉；不会的话 RunService 自己记录并清理。
3. deepagents 技能中间件经 `GuardedSandbox(LocalShellBackend)` 能否扫到 `<工作区>/skills/`（和 backend 经 `GuardedSandbox(E2B)` 同一条路径，风险低）。

## 10. 实施拆分

| 计划 | 内容 | 完成标准 |
|---|---|---|
| **A. agent-core 抽取** | §3 全部。只碰 backend 和 `packages/` | backend 行为不变、jest 全绿、提示词快照一致；可单独合并 |
| **B. 桌面端最小可用** | Electron 壳、设置页（Key / 工作区 / 信任）、对话页、RunService、SQLite、GuardedSandbox(LocalShellBackend)、审批、崩溃恢复 | 能装、能填 Key、能对话、能审批执行一条命令 |
| **C. 技能 + MCP + 附件** | 技能安装与同步、MCP 添加/OAuth/工具审批、附件复制与丢失处理 | 各自的集成测试通过 |

A 不依赖桌面端，先做；B 依赖 A；C 依赖 B。

## 11. 依据

- v2 路径方案是 backend 已放弃的做法 → `apps/backend/src/agent/guarded-sandbox.ts:10-14`、`agent.factory.ts:66-69`
- GuardedSandbox 的守卫范围、execute 不隔离、构造签名、技能目录写死、只依赖 node:path → `guarded-sandbox.ts:4-8,16-28,48-61,74-84`
- `buildAgent` 写死 `sendEmailTool` 与 `send_email` 审批 → `agent.factory.ts:273-278,290`
- 提示词宿主专属段落 → `agent.factory.ts:47-60,74-83`；`contextSchema.userId` 必填 → `:109-112`；Key 从 env 读 → `:150`；技能扫描目录 → `:281`
- checkpointer 是 RedisSaver → `apps/backend/src/agent/checkpointer.provider.ts:5-20`
- 历史从 DB 重放、技能每轮同步、MCP 在 worker 组装、`userMessageText` 来自 conversations → `apps/backend/src/worker/agent.processor.ts:23,181,191-192,239-265`
- `mcp-agent-tools` 依赖 `mcp.service`；`RuntimeServer`/`McpAuthRequiredError` 是纯类型和纯类 → `apps/backend/src/mcp/mcp-agent-tools.ts:6-7`、`mcp.service.ts:1-18,75-89`
- `skill-installer` 依赖 `BusinessException` → `apps/backend/src/skills/skill-installer.ts:30`
- `preview-page` 依赖 preview 与 sandbox → `apps/backend/src/agent/tools/preview-page.tool.ts:3-4`
- backend 是 CommonJS（`package.json` 无 `"type"` 字段，已 grep 确认）；design-schema 构建 commonjs 到 dist → `packages/design-schema/tsconfig.json`、`package.json`；backend jest `rootDir: src` → `apps/backend/package.json`（`jest` 段）
- `LocalShellBackend` 选项与方法 → `apps/backend/node_modules/deepagents/dist/index.d.ts:1470-1502,1560-1585`
- 第 2 步清单不依赖 Nest/Prisma/Redis → grep 核实 0 命中（`guarded-sandbox.ts`、`message-content.ts` 为 v3 新增，前者已核 import，后者依子 agent 报告，未自行复核）
- §9 的 3 项 → 未验证

## 12. 实施记录（2026-11-05，与上文设计的差异以本节为准）

**已按设计落地**：agent-core 抽取（§3，先参数化后搬迁）、桌面端 Electron 壳 + agent-host + RunService、GuardedSandbox(本机) + execute 审批 / 信任开关、技能、MCP（含 OAuth loopback 回调）、附件复制与丢失标记、崩溃恢复、亮 / 暗主题。

**与设计不同的地方**

| 设计 | 实际 | 原因 |
|---|---|---|
| SQLite 用 better-sqlite3 + Drizzle；checkpointer 用 `@langchain/langgraph-checkpoint-sqlite` | 用 Node 内置 `node:sqlite`，手写迁移（`PRAGMA user_version`）+ zod 校验行；checkpointer 从 SqliteSaver（MIT）移植为 `NodeSqliteSaver`（`apps/desktop/src/agent-host/db/checkpointer.ts`） | better-sqlite3 12 编不过 Electron 45 的 V8（实测）；内置模块无原生依赖，测试直接在 Node 22 跑，打包无需 rebuild / asarUnpack |
| execute 用 `LocalShellBackend` | 文件工具委托 `FilesystemBackend`，execute 自写（独立进程组、120s 超时、10 万字节输出上限、环境变量白名单） | 停止运行时要能杀掉整棵进程树，`LocalShellBackend.execute` 不接 abort |
| 第 2 步搬 `skill-installer` | 不搬；桌面端只支持「从本地文件夹安装」，复用 `skill-parser` 校验 | installer 是 GitHub 下载安装，且 `assertSafeEntryPath` 被 backend 3 个模块按 `BusinessException` 语义使用，搬它要改这些调用方 |
| `packages/desktop-ipc` | 放在 `apps/desktop/src/shared/`（rpc.ts / desktop.ts） | 只有桌面端自己的 renderer 与 agent-host 用，不需要单独成包 |
| Electron 版本未定 | 45.2.0 | 45.2.2 发布不足 pnpm `minimumReleaseAge`，不加豁免 |

**设计里没有、实施中补上的**
- agent-host 重启前 main 先通知 renderer 丢弃旧端口（`AGENT_PORT_CLOSED_MESSAGE`），`setKey` 等新 agent-host 就绪才返回：否则改 Key 后发出的请求会落进已关闭的端口、无响应。
- 命令登记表 `running_process`（迁移 v2，`workspace/process-tracker.ts`）：agent-host 崩溃时命令进程组会成为孤儿，重启后按登记表清理；只在 `ps` 查到的命令行与登记完全一致时才杀，防 pid 复用误杀。
- 时间线按 tool_call id 去重：审批续跑时 LangGraph 会把同一 AIMessage 再推一次（Web 版同样会记两条 `tool_start`）。
- 回环地址（本机 MCP、OAuth 回调）一律不走代理。

**§9 待验证项结论**
1. better-sqlite3 在 Electron 45：**不可用** → 改 `node:sqlite`（见上）。
2. 停止时杀子进程：自写 execute 用进程组实现，单测与 e2e 均验证孙进程被杀。
3. 技能中间件经 `GuardedSandbox(本机)` 扫 `<工作区>/skills/`：e2e 中 `/magic-echo` 技能被正确加载并执行。

**测试**
- 单测：agent-core 142 / backend 809（+2 提示词快照）/ desktop 20（含 checkpointer 重启续跑、进程组清理、越界路径拒绝）。
- 真实模型：`apps/desktop/src/agent-host/run/run-service.live.test.ts`（`SPARK_LIVE_TEST=1`）。
- Electron e2e（`pnpm --filter desktop e2e`，需 `SPARK_E2E_GOOGLE_API_KEY`）：基础流程、技能 + 附件 + MCP、拒绝 / 停止 / 崩溃恢复；`SPARK_E2E_EXECUTABLE` 指向打包产物可对 `Spark.app` 跑同一套。

## 13. 第二期：对齐 Web（2026-11-05）

需求：对话 UI 与 Web 一致、token 统计、右上角工作区文件、每个会话自选目录与权限、MCP 按标准协议全量对齐（含 Apps 卡片）、内置 create-skills、开源技能命令安装。用户选定：UI 拷贝（不改 Web）、权限三档、MCP 全量、兼容 `npx skills add` 写法。

### 13.1 实现要点
- **对话 UI**：`apps/frontend` 的聊天组件、`thread.ts`、token 弹窗、文件树 / 预览、MCP 卡片、连接器页、技能页原样拷到 `apps/desktop/src/renderer/src`（同名同形 `lib/api.ts` 改走 agent-host RPC）。差异只在宿主侧：附件是本地路径、文件面板读本机目录、没有媒体 / 网页预览 / 后台任务卡片。拷来的 `thread.ts`、`mcp-app-card.tsx` 在 eslint 里放宽 4 条 type-checked 规则（跟随 Web 口径，`no-explicit-any` 仍为 error）。
- **会话工作区与权限**（迁移 v3）：`conversation.workspace_dir / permission`；只读 = backend 层直接拒写 / 改 / 执行（`ReadOnlyGuardedSandbox`），询问 = `execute / write_file / edit_file` 进 interruptOn，自动 = 不审批。目录只能在发第一条消息前改。
- **技能与附件移出工作区**：工作区可能是用户自己的项目，旧做法每轮 `rm -rf <工作区>/skills` 会误删。改放 `<userData>/runtime/<会话 id>/{skills,attachments}`，经 `CompositeBackend` 按真实绝对路径前缀路由到只读 `FilesystemBackend`（`workspace/workspace-backend.ts`）；agent-core 新增可选 `skillsDir`（缺省行为不变，backend 快照测试锁定）。
- **token 报表**：`ConversationRepo.tokenReport` 口径同 backend `tokenReport`（总计 / 按模型 / 按轮）。
- **MCP**（迁移 v4）：`mcp-store.ts` 逐项对照 backend McpService——推荐连接器、断开、server 自报信息、工具元数据、URL 只收 https（http 仅本机）、App 资源 / App 调工具（同样的 visibility / deny / confirmed 校验）/ App 上下文注入；进行中的 OAuth 授权加密落库，重启后恢复 loopback 监听；授权结果以 `mcp-oauth` 事件推给 renderer。
- **MCP Apps 沙箱**：main 注册特权协议 `spark-mcp://m-<sha256 前 16 位>`，每个连接器一个源，代理页与 CSP 构造同 Web（`main/mcp-sandbox.ts`）；preload 只注入主 frame，卡片拿不到 `window.desktop`。
- **技能**：内置技能放 `resources/skills`（打包经 extraResources，agent-host 读 `SPARK_BUILTIN_SKILLS`），不能停用 / 删除 / 同名覆盖；`/skills add …` 与技能页安装兼容 `npx skills add`（owner/repo、@skill、--skill、GitHub 链接），不经模型、直接拉 codeload tarball（只要普通文件与目录、拒 `..`、单文件 512KB、总量 50MB）；`create-skills` + `save_skill` 工具（任何档位都要审批）；文件夹导入不再复制软链。

### 13.2 测试中发现并修复
- `parseMcpApp` 每次折叠都新建对象 → 模型继续输出时 `McpAppCard` 的 effect 反复拆建 bridge、iframe 不停重载、卡片停在握手（e2e 稳定复现，已在桌面端用 WeakMap 缓存修复）。**Web 同一段代码有同样问题，未改 Web。**
- 同一毫秒内多次 `ui/update-model-context` 时 App 上下文淘汰顺序不确定 → `at` 严格递增。

### 13.3 验证
- desktop：tsc（node / web）+ eslint 0 error；vitest 37 passed（+5 条真实模型 / 网络：三档权限、目录隔离、`/skills add`、`/create-skills` 审批保存）；Playwright 6 passed（开发构建与打包产物各一轮）。
- agent-core jest 142 passed；backend jest 809 passed、快照 2 passed、tsc 0 error；`apps/frontend` 0 改动。

## 14. 后台任务（2026-11-05）

对齐 Web 的 4 个工具：`watch_until`、`run_in_background`、`schedule_wakeup`、`cancel_background_task`。名称、参数、说明、限额（每会话 5 个进行中）、`<task-notification>` 通知格式、投递规则（会话 idle / done / failed 才唤醒，否则本轮结束后补投；停止会话即取消其后台任务）都同 backend。

桌面端差异（`apps/desktop/src/agent-host/background/`）：
- BullMQ / Redis → agent-host 进程内 setTimeout，下一次推进时刻存 `background_task.next_tick_at`（迁移 v5）；agent-host 重启后 `resume()` 让 watch / wakeup 接着计时。
- 后台命令由 agent-host 直接起独立进程组（白名单环境变量），进程退出即结束任务；日志写会话运行目录 `runtime/<会话>/bg/<任务>/out.log`（agent 只读可达，不写用户工作区）；进程组登记 ProcessTracker，agent-host 意外退出后下次启动清理，对应任务标为中断并通知 agent。
- 权限：只读会话不提供 `run_in_background`；询问会话里它和 execute 一样要审批；自动直接跑。
- 界面：拷 Web 的 BackgroundTaskCard / TaskNotificationRow，`bg_task_update` 写进 bg-tasks 缓存，卡片可取消。

验证：background 单测 7 passed；真实模型 `run_in_background` 跑完自动唤醒并汇报；e2e `background.spec.ts` 2 passed（watch 轮询 3 次完成 → 通知 → 回复结果；卡片取消 → 进程被杀、不唤醒）；全量 e2e 8 passed（开发构建与打包产物各一轮）。

## 15. 接入 aigc（2026-11-05）

决定：桌面端**登录 Web 账号、走 Web 后端接口**（不在桌面端放 aigc Token）。生成记录在 Web 账号下、按 `desktop:<本机会话 id>` 记账；对话、技能、连接器仍只在本机。

- **共用的接口模块**：生图 / 生视频 / 配音 / 克隆音色五个工具的名称、入参、说明、结果格式移到 `packages/agent-core/src/media/media-tools.ts`（`createMediaTools(MediaToolBackend)`），提示词段落移到 `media-prompt.ts`。backend 的 `media.tools.ts` 改为注入 MediaService（行为不变：media / canvas / worker 381 条测试通过，系统提示词快照逐字一致）。
- **backend 新增 `/media-api`**（`media-api.controller.ts`，JWT 鉴权）：models / generations（POST 建、GET 列）/ voices / uploads（直接落 done）/ sources，全部调同一个 MediaService；`MediaGeneration.conversationId` 不是外键，无需改表。重新生成、取 CDN 地址复用已有的 `/media/...` 路由。
- **desktop**：设置页「Web 账号」邮箱验证码登录（main 用 net.fetch 调 /auth/send-code、/auth/verify-code），令牌 safeStorage 加密，经 env 只交给 agent-host；登录 / 退出重启 agent-host。agent-host 用 `WebApi` 调 /media-api 实现 `MediaToolBackend`；图片 / 视频 / 音频附件发送时上传成生成素材（带 versionId）；`sync_media_to_sandbox` 把媒体下载进本机工作区（只读不提供、询问要审批）。媒体卡片拷 Web 的 media-card，桌面端没有 socket，改为有未完成版本时每 3 秒轮询。

验证：backend jest 812 passed（含 media-api 3 条）、快照 2 passed、tsc 0 error；agent-core 142 passed；desktop vitest 52 passed（含 web-media 8 条）。
真实链路（worktree 后端 3201 + 独立 Redis 6380 + aigc dev）：
- 接口级 `/media-api` 10/10：验证码登录、无效令牌 401、模型目录、非法参数 issues、参考图上传、生图接单 → 25s 完成、CDN 可下载、sources、跨会话隔离；
- Web 对话生图（worker → 共享 media-tools → MediaService）2/2：返回格式不变、生成完成；
- desktop e2e `aigc.spec.ts`：设置页登录 → 带参考图生图 → 卡片出图 → sync 进工作区；全量 e2e 9 passed。
已知问题：aigc 用例最初 9 次里有 2 次失败（对话区被换成登录前的设置页，生成本身已完成），之后连续 7 次未复现，原因未查明；用例里留了失败截图。

## 16. 登录页、侧栏用户区与设置弹窗（2026-11-05）

- **登录页**（`features/auth/login-view.tsx`）：参考 Web /login（点阵背景 + 居中卡片、邮箱优先 → 6 位验证码 → 登录、60 秒重发、测试环境自动填码），只有邮箱验证码；「先跳过」后不再自动出现（`settings.loginSkipped`），退出登录时清掉。Web 后端地址移到 设置 → 账号。
- **侧栏底部用户区**（同 Web 侧栏底部）：已登录显示头像 + 邮箱（点开设置 → 账号），未登录显示「未登录 · 登录」；右侧设置齿轮。原来的 技能 / 连接器 / 设置 导航项移除。
- **设置弹窗**（`features/settings/settings-dialog.tsx`）：左侧分类（同 Web SettingsNav 样式）—— 账号、外观、模型、工作区、技能、连接器；技能 / 连接器内容沿用拷自 Web 的组件。
- **外观**：主题 跟随系统 / 浅色 / 深色，main 设 `nativeTheme.themeSource`，页面经 prefers-color-scheme 挂 `.dark`（原生标题栏、滚动条一起变）。

验证：desktop tsc / eslint 0 error，vitest 52 passed；Playwright 全量 9 passed（含登录页跳过与记住、侧栏未登录态、设置分类切换、主题切深色后 `<html>.dark` 与 `nativeTheme.themeSource=dark`、登录页真实验证码登录后侧栏显示账号）。

## 17. 按账号隔离数据（2026-11-05）

决定：会话（含消息、附件、token、后台任务、checkpoint）、技能、连接器按用户隔离；模型 Key、外观、默认工作区设备级共用；未登录时的数据留在访客空间，登录后看不到，退出后仍在。

- main 按账号给 agent-host 一个数据目录（`DesktopStore.profileDir`）：已登录 = `<userData>/users/<Web 用户 id，取 JWT sub>`，访客 = `<userData>` 本身（登录功能上线前的数据原地成为访客数据，不迁移）。登录 / 退出本来就重启 agent-host，借此切换。
- 命令进程登记表改为设备级 `device.db`：A 账号崩溃留下的孤儿命令，切到 B 账号启动时也会被清理。
- 界面：账号变化时回到首页、收起设置弹窗；agent-host 重连后全部数据重拉。修了一个因此暴露的问题：在设置里退出登录 → 登录页跳过后，设置弹窗会重新盖在主界面上导致无法点击。

验证：e2e `accounts.spec.ts`（访客建会话 → 登录后看不到、建自己的会话并装技能 → 退出只见访客数据与内置技能 → 再登录自己的会话和技能都在；全程不用重填模型 Key）；全量 10 条 e2e 通过（aigc 用例改为读当前账号目录下的库）。
