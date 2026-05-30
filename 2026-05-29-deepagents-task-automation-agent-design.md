# 任务自动化 Agent 平台 — 技术设计方案

> 日期：2026-05-29
> 技术栈：NestJS + LangChain/deepagents(LangGraph.js) + Socket.IO + Next.js + Redis + MySQL
> 参考来源：Claude Code harness 架构（消息收发/流式/持久化/远程通信）+ LangChain Deep Agents 官方文档

---

## 1. 概述与目标

构建一个**多用户 SaaS 的任务自动化 Agent 平台**：用户提交一个目标，Agent 基于 deepagents 的 `plan → 执行` 模式自主规划并分步完成；任务在后台长时间运行（浏览器关闭也继续），关键动作需用户审批；前端通过 Socket.IO 实时观看流式进度，断线重连可恢复进度与历史。

整体架构思路参考 Claude Code harness，但用 LangChain Deep Agents 作为 agent 内核、自托管在 NestJS 中（不使用 LangGraph Platform）。

## 2. 已确认需求

| 维度 | 结论 |
|------|------|
| Agent 形态 | 任务自动化（deepagents `write_todos` 规划 + 工具执行，第一期单主 agent） |
| 部署 | 多用户 SaaS（鉴权、会话/租户隔离、并发长任务） |
| 人在环路 | 关键工具调用需用户审批（deepagents 原生 `interruptOn`） |
| 工具范围（一期） | 虚拟 FS（StateBackend）+ 外部 API / MCP / 联网；**不含 shell/沙箱**（预留接口） |
| 任务生命周期 | 后台 worker 持续运行 + 断线重连恢复进度与历史 |

## 3. 技术栈与关键决策（含取舍记录）

| 决策点 | 选择 | 理由 / 取舍 |
|--------|------|------------|
| 架构形态 | 三层分离：Gateway / Agent Worker / (预留 Sandbox) | 多用户长任务需 Gateway 轻量 + Worker 可横向扩展；单体撑不住几小时长任务 |
| Agent 内核 | deepagents（LangGraph.js），**自托管在 NestJS Worker** | 用户栈为自建 NestJS+Socket.IO，不走 LangGraph Platform / `useStream` |
| 前端↔后端 | Socket.IO | 双向、自动重连，承载流式事件 + 审批协议 |
| 实时事件流 | Redis Stream（XADD 自增 id 当 seq） | 等价 Claude Code `from_sequence_num`，支持断线重放 |
| 任务队列 | BullMQ（Redis） | 任务入队解耦，Worker 池消费 |
| **checkpointer** | **Redis（社区 RedisSaver）** | LangGraph 官方无 MySQL saver；复用已有 Redis，零额外基础设施。**审批与断点续跑的硬依赖，不可省** |
| 业务持久化 | MySQL 8.0 | 任务/消息/事件归档/审批审计。JSON 列存 content/payload；对话树应用层 walk 重建（不依赖 DB 递归） |
| 文件能力（一期） | StateBackend（state 虚拟 FS） | 无需沙箱、天然多租户隔离；`execute` 工具仅 sandbox 后端暴露，故一期无 shell |
| 沙箱 | 一期不做，预留 `SandboxProvider` / `SandboxBackendProtocol` 接口 | 后期接入（注：deepagents 内置 Daytona/Modal；E2B 需自实现 `SandboxBackendProtocol` 适配） |
| 子 agent | 一期不用 | 异步子 agent 必须 LangGraph Platform，自建用不了；同步子 agent 后期按需加 |
| LLM | deepagents 默认 Claude（`anthropic:claude-sonnet-4-6`），可配 | 与提供商无关，可换 OpenAI/Google |
| 鉴权登录 | NextAuth(Auth.js v5) Passkey + 共享标准 JWT 桥接 | 无密码、零 OAuth 外部配置；NextAuth 管登录，callback 内铸造标准 JWT 供 NestJS/Socket.IO 验证 |
| `/command` 调用 | Command 路由层：skill 型(deepagents SKILL.md) + prompt 模板型 | 用户显式 `/command` 触发；第一期仅系统内置，对接 deepagents skills(progressive disclosure) |

## 4. 整体架构

```
┌─────────────┐   Socket.IO (WS)    ┌──────────────────────┐
│  Next.js    │ ←─────────────────→ │   NestJS API Gateway  │
│  (前端)      │   REST (鉴权/历史)   │  - JWT 鉴权 / 多租户   │
└─────────────┘                     │  - Socket.IO Gateway  │
                                    │  - 任务入队            │
                                    │  - 事件转发(Stream→WS) │
                                    └──────────┬───────────┘
                                       BullMQ  │  Redis Stream(订阅)
                                    ┌──────────▼───────────┐
                                    │   Agent Worker        │
                                    │  (独立 NestJS 进程,可多实例) │
                                    │  - deepagents loop    │
                                    │  - stream→Stream       │
                                    │  - 消息落库 MySQL      │
                                    │  - interruptOn 审批    │
                                    └──────────┬───────────┘
                                    (一期)虚拟FS+外部工具
                                    (后期)SandboxProvider→沙箱

  Redis:  ① BullMQ 队列(run + resume + 超时 delayed job)  ② task:{id}:events Stream  ③ RedisSaver checkpointer
  MySQL:  tenants/users/assistants/tasks/messages/events_archive/approvals
```

**组件职责（单一职责）：**

| 组件 | 职责 | 不做什么 |
|------|------|---------|
| Next.js 前端 | 渲染会话/任务、流式消息、审批卡片；Socket.IO 收事件发指令 | 不接触 LLM/沙箱 |
| API Gateway | 鉴权、租户隔离、Socket.IO 网关、任务入 BullMQ、订阅 Redis Stream 转发、REST 拉历史 | **不跑 agent loop** |
| Agent Worker | 领 BullMQ 任务、跑 deepagents、事件写 Stream + 落库、审批中断/恢复 | 不直接连前端 |
| Redis | 队列(含 resume job) + Stream 事件流 + checkpointer | — |
| Archiver | Stream consumer group 消费 task:*:events，MAXLEN 裁剪前落 events_archive（一期可内置于 Gateway 进程） | 不转发前端、不跑 agent |
| MySQL | 持久真相源 | 不做实时 |

**与 Claude Code 映射**：Gateway≈REPL/bridge 中转；Worker≈daemon；Redis Stream≈SSE 事件流 + seq 重连；MySQL≈`*.jsonl` transcript；`interruptOn`≈permission control 协议。

### 4.1 鉴权与多租户身份（NextAuth Passkey + 共享 JWT，路径 B）

登录链路：
```
Next.js: NextAuth(Auth.js v5) Passkey Provider(WebAuthn, JWT 策略, experimental.enableWebAuthn)
  → @auth/* adapter 把 passkey credential 存 MySQL(authenticators 表)
  → 登录成功后在 jwt/session callback 铸造一个标准 JWT(jose, HS256 或 RS256)
       payload: { sub: userId, tenantId, exp }   ← 用共享 AUTH_JWT_SECRET 签
前端: 取标准 JWT
  → REST: Authorization: Bearer <jwt>
  → Socket.IO: handshake.auth.token = <jwt>
NestJS: JwtAuthGuard / Socket.IO Guard 用同一 secret/公钥验证 → 解出 userId+tenantId 注入请求上下文
```

**为什么铸造标准 JWT 而非直接验 NextAuth session**：NextAuth v5 的 session token 是 Auth.js 私有 JWE 格式（随版本演进易碎）。在 callback 里另签一个标准 JWT，让 NestJS 用通用 jose/jsonwebtoken 验证，桥接最稳、最解耦。

**WebAuthn RP 配置**（环境变量，非第三方后台）：`RP_ID`(domain)、`RP_NAME`、`ORIGIN`。无任何 OAuth client 配置 —— 满足"零额外配置"诉求。

> Passkey UX 兜底：纯 passkey 需设备支持 + 首次注册 authenticator；后期可加邮箱 magic link fallback（需邮件服务，一期不做）。

### 4.2 `/command` 动态调用 skill（Command 路由层）

在 deepagents skills（agent 自主 progressive disclosure）之上加一层 **Command 路由层**，把用户显式输入的 `/command` 映射到调用。支持两类 command：

| 类型 | 含义 | 落地 |
|------|------|------|
| **skill 型** | `/command` 显式调用一个 deepagents `SKILL.md` | 加载 SKILL.md 注入 + 引导 input 强制使用该 skill |
| **prompt 模板型** | `/command` 展开为预定义 prompt 模板注入（Claude Code slash command 风格） | 服务端渲染模板、插入 args |

**Command Registry**（启动构建，供前端 `/` 自动补全）：
```ts
type CommandDef =
  | { kind: 'skill';  name; description; skillPath; allowedTools?; model? }
  | { kind: 'prompt'; name; description; template; argsSchema?; allowedTools?; model? }
```
- 第一期 **仅系统内置**：skill 型从打包的 `skills/` 目录读 `SKILL.md` frontmatter（= progressive disclosure 第一步，只读 frontmatter）；prompt 型从代码/JSON 配置定义。
- 来源层叠（对应文档 §14.6）：后期租户自定义同名覆盖内置。

**解析与路由（Gateway）**：
```
"/research AI 趋势" → 解析 name=research, args="AI 趋势"
  → Registry 查 name:
     ├ kind=skill : 入队 {kind:'skill', skillName, args}
     ├ kind=prompt: 服务端渲染 template(插 args) → 入队 {kind:'prompt', renderedPrompt}
     └ 未命中     : 回错误事件 + 可用命令清单
  → Worker:
     skill 型 : 加载 SKILL.md 作为 files 注入(对齐 §14.3) + input="使用 `research` 技能完成：AI 趋势"
     prompt 型: input = renderedPrompt
     两者均可按 frontmatter 的 allowed-tools/model 对这轮 run 临时覆盖
```

**命名空间与可扩展性（关键）**：命令采用 `<domain>-<action>` 命名约定（`/video-tvc`、`/video-xx`、`/image-xx` …），Registry 按 domain 自动分组。系统需支撑**大量命令**且：
- **数据驱动、零改核心代码扩展**：skill 型新增命令只需在 `skills/` 目录放一个 `SKILL.md`（Registry 启动扫描目录自动注册）；prompt 型只需加一条配置。加几十上百个命令不动核心代码。
- **每命令专属工具子集**：每个命令的 `SKILL.md` frontmatter `allowed-tools` 决定这轮 run 暴露哪些工具——`/video-tvc` 激活视频生成工具、`/image-xx` 激活图像工具，互不干扰（对应 Claude Code 的 command-scoped allowed-tools）。

**前端**：输入框监听 `/` → 弹补全面板，命令按 `domain-` 前缀**分组展示**（video / image / …）、支持 name+description **模糊搜索**与前缀过滤（输入 `/video` 只列 `video-*`）→ 选中填充 `/name ` → 补 args 提交。

**存储（第一期）**：skill 文件打包镜像走 `FilesystemBackend`（多租户务必 `virtualMode: true` 防路径越权）+ `skills: ["./skills/"]`；prompt 模板走内置配置。**第一期无需 DB 表**；后期租户自定义再加 `commands` / `skills` 元数据表 + StoreBackend（namespace = 租户）。

**与 Claude Code 映射**：`/command` 解析 ≈ commands.ts；Registry ≈ 可用 skill 列表；forcedSkill 注入 ≈ 用户显式调用而非模型自选。

## 5. 消息流与流式推送

### 5.1 发消息（前端 → Worker）
```
用户提交目标/追加指令
  → Socket.IO emit('task:submit', {taskId?, content})
  → Gateway: 鉴权+租户校验 → user 消息落 MySQL(前端乐观渲染) → BullMQ.add('agent-run', {...}) → 立即 ack
  → Worker: 领取 → 启动/续跑 deepagents
```
要点：用户消息先落库 + 前端乐观显示；入队即返回，长任务不阻塞连接。

### 5.2 收消息 / 流式（Worker → 前端）
Worker 用 `agent.stream(input, { configurable:{ thread_id: taskId }, streamMode:['updates','messages','custom'], subgraphs:true })` 拿细粒度事件（deepagents 推荐方式；子 agent 独立流必须开 `subgraphs:true`），每个事件包成统一信封写 Redis Stream：
```ts
interface TaskEvent {
  seq: string            // Redis Stream id
  taskId: string
  type: 'token' | 'message' | 'tool_start' | 'tool_end'
      | 'plan_update' | 'control_request' | 'result' | 'error'
  payload: unknown
  ts: number
}
```
```
Worker XADD → Redis Stream(task:{id}:events) → Gateway XREAD BLOCK 订阅 → socket.to(room=taskId).emit('task:event', evt)
  → 前端: token→累积流式 buffer(按行刷新);message→落定;tool_*→工具卡片;control_request→审批弹窗
```
**`type` 的事件来源**（`normalize` 映射）：`token`/`tool_start`/`tool_end` ← `streamMode:'messages'`（token 流 + `tool_call_chunks`/`ToolMessage`）；`plan_update` ← `streamMode:'updates'` 的 `todos` channel；`control_request` ← `__interrupt__`；`message`/`result` ← `updates`；自定义进度 ← `streamMode:'custom'`（工具内 `config.writer`）。多模式组合时 `stream` 产出的元组是 `[namespace, mode, data]`。

约定：**token 增量只走 Stream 不落库**，只有完整 message 落 MySQL。前端流式渲染复用 Claude Code 思路（增量累积 → 按行刷新 → 收到完整 message 原子替换）。

### 5.3 断线恢复
```
前端记 lastSeq
  断线 → Socket.IO 重连 → emit('task:resume', {taskId, lastSeq})
  → Gateway:
     lastSeq 仍在 Stream → XRANGE task:{id}:events (lastSeq, +] 补发 → 转 XREAD BLOCK 实时
     lastSeq 已被 MAXLEN 裁出 → 先从 events_archive 按 seq 补 (lastSeq, 已归档最大] → 再衔接 Stream/XREAD
  → 若任务已结束: 从 MySQL 拉完整历史 + 最终结果
```
Stream 设 `MAXLEN ~ N` 控内存。**Redis MAXLEN 是裁剪即丢、无回调**，故由独立 **Archiver**（§4 组件，Stream consumer group）在裁剪前把事件落 `events_archive`——不能依赖"自动回落"。

> 注意区分两种恢复：**前端展示恢复**（Stream+MySQL，不依赖 checkpointer）vs **agent 执行恢复**（checkpointer，审批/崩溃续跑）。

## 6. 审批协议（deepagents 原生 `interruptOn`）

**用 deepagents 原生 `interruptOn` + checkpointer，不手写拦截器。**

```ts
createDeepAgent({
  tools: [...],
  interruptOn: {
    delete_file: true,
    read_file: false,
    send_email: { allowedDecisions: ['approve', 'reject'] },
  },
  checkpointer,   // 必须传(RedisSaver)
})
```

流程（关键：审批可能等很久，Worker **不在进程内阻塞等待**——命中中断即结束当前 job 释放 slot，决策回来后入队 resume job 由**任意** Worker 续跑，与"无状态可横扩 Worker 池"一致）：
```
[run job] Worker: deepagents 命中 interruptOn 的工具 → 图暂停,状态存 checkpointer → invoke 返回带 __interrupt__
  → result.__interrupt__[0].value 含 actionRequests + reviewConfigs
  → 包成 control_request 事件写 Stream → 前端审批卡片(显示工具名+参数,可编辑)
  → task 状态置 waiting_approval → 当前 job 正常结束,释放 worker slot(不阻塞等人)
用户决策 → emit('control:response', {requestId, decisions})
  → Gateway 鉴权 + 校验 requestId 命中当前未决审批
  → BullMQ.add('agent-run', { taskId, kind:'resume', requestId, decisions })   // 复用任务队列,不再用独立 resume 通道
  → [resume job] 任意空闲 Worker 领取 → agent.invoke(
       new Command({ resume: { decisions } }),
       { configurable: { thread_id: taskId }, context: { tenantId, userId } })   // 同 thread_id+checkpointer 续跑; context 同 §7.1 注入租户身份
  → 续跑事件继续写同一 task:{id}:events Stream
```

**决策类型（4 种，前端均需支持）**：`approve`（原参数执行）/ `edit`（改参数执行，回传格式 `{ type:'edit', editedAction:{ name, args } }`）/ `reject`（跳过）/ `respond`（人类回复当工具结果）。多工具调用时 `decisions` 数组按 `actionRequests` 顺序对应。

**超时兜底**：发出 control_request 时同步排一个 BullMQ delayed job（如 30min）；到点若 task 仍 `waiting_approval`，按默认 `reject` 入队 resume job 续跑 + 通知（不依赖 Worker 进程内计时）。用户决策与超时是两个并发触发源——以 `task.status` 的 `waiting_approval → running` 原子 CAS 保证只续跑一次（幂等）。每次决策落 `approvals` 表审计。

## 7. deepagents 集成

### 7.1 Worker 装配
```ts
const agent = createDeepAgent({
  systemPrompt,                                  // 任务 agent 角色与规则
  model: 'anthropic:claude-sonnet-4-6',          // 可配
  tools: [...externalApiTools, ...mcpTools],     // 虚拟FS/planning 内置
  backend: new StateBackend(),                   // 一期虚拟 FS
  interruptOn: { /* 审批策略 */ },
  checkpointer,                                  // RedisSaver
  contextSchema,                                 // 多租户: 声明 context 形状, 供 namespace 工厂读取
  middleware: [ /* guardrails, 见 §9 */ ],
  // subagents: 一期不配
})

for await (const [namespace, mode, data] of await agent.stream(input, {
  configurable: { thread_id: taskId },
  context: { tenantId, userId },                 // 自托管无 serverInfo.user, 多租户身份只能经 context 注入
  streamMode: ['updates', 'messages', 'custom'], // updates=状态/__interrupt__, messages=token/tool, custom=writer
  subgraphs: true,                               // 子 agent 独立流必须开
})) {
  await publishToRedisStream(taskId, normalize(namespace, mode, data))
}
```

### 7.2 内置默认中间件（deepagents 自带）
`TodoListMiddleware`、`FilesystemMiddleware`、`SubAgentMiddleware`、`SummarizationMiddleware`、`AnthropicPromptCachingMiddleware`、`PatchToolCallsMiddleware`；传 `interruptOn` 自动加 `HumanInTheLoopMiddleware`、传 `skills` 自动加 `SkillsMiddleware`、传 `memory` 自动加 `MemoryMiddleware`。

### 7.3 工具来源（统一成 LangChain tools）
| 来源 | 接入方式 |
|------|---------|
| 虚拟 FS / planning | deepagents 内置（ls/read_file/write_file/edit_file/glob/grep + write_todos） |
| 自定义外部 API | LangChain `tool()` + zod schema |
| MCP 工具 | `@langchain/mcp-adapters` 的 `MultiServerMCPClient` → 转 LangChain tools |
| 联网 search/fetch | 现成 LangChain tool（如 Tavily）或自定义 |

每个工具挂 `riskLevel` 元数据，驱动 `interruptOn` 审批策略。

### 7.4 自动上下文压缩（无需自建，对应 Claude Code compact）
- **Offloading**：tool 输入/结果 >20k token 时替换为文件路径引用 + 前 10 行预览。
- **Summarization**：上下文越过模型 `max_input_tokens` 的 85% 时压缩为结构化摘要，原文写入虚拟 FS 留档，保留 10% 近期上下文。

### 7.5 长期记忆（可选，后期）
`CompositeBackend(new StateBackend(), { '/memories/': new StoreBackend({ namespace }) })` + 传 `store`。多用户**必须设 namespace**（按 `tenantId,userId`）。

## 8. 数据模型

### MySQL（业务真相源）
```
tenants            租户(隔离根)
users              用户(隶属租户, JWT 身份)
authenticators     passkey 凭据(Auth.js WebAuthn adapter 表): credentialId, userId,
                   publicKey, counter, transports
accounts           Auth.js adapter 账户表(WebAuthn 需要)
assistants         配置好的 agent 实例: systemPrompt/model/tools 配置/interruptOn 策略 (= 文档 Assistant)
tasks              ≈thread: id(=thread_id), tenantId, userId, assistantId, goal,
                   status(queued|running|waiting_approval|paused|done|failed|canceled),
                   lastSeq, createdAt
messages           对话树: uuid, taskId, parentUuid, role(user|assistant|tool), type,
                   content(JSON), seq, createdAt   ← parentUuid 应用层 walk 重建链
events_archive     taskId, seq, type, payload(JSON), ts  (Archiver 经 consumer group 落库; 供 lastSeq 超出 Stream 窗口时重放)
approvals          审批审计: taskId, requestId, toolName, args(JSON),
                   decision(approve|edit|reject|respond), editedArgs, decidedBy, decidedAt
```

### Redis（运行时状态）
```
checkpointer       RedisSaver, key 按 thread_id → 图状态/审批断点/续跑
task:{id}:events   Stream, XADD 自增 id=seq, MAXLEN 限长; Archiver consumer group 裁剪前落档
bull:agent-run     BullMQ 队列(run job + resume job + 审批超时 delayed job)
```

### 多租户隔离（贯穿每层）
Gateway 鉴权校验 tenantId → Socket.IO room 按 taskId → checkpointer/StoreBackend namespace 按 `(tenantId,userId)`（自托管无 Platform 的 `serverInfo.user`，namespace 工厂只能取 `rt.runtime.context.*`——故 Worker 必须配 `contextSchema` 且 `stream/invoke(..., { context:{ tenantId, userId } })` 注入，见 §7.1）→ MySQL 查询带 tenantId。

## 9. 守护、错误处理与测试

### 9.1 守护中间件（多租户必备）
```ts
middleware: [
  modelCallLimitMiddleware({ runLimit: 50 }),    // 防失控循环
  toolCallLimitMiddleware({ runLimit: 200 }),
  modelFallbackMiddleware('gpt-4.1'),
  piiMiddleware('email', { strategy: 'redact', applyToInput: true }),
]
// 模型连接弹性: maxRetries: 10, timeout: 120_000
```

### 9.2 错误处理矩阵
| 场景 | 处理 |
|------|------|
| LLM API 错误 | 指数退避重试 6→10 次 + fallback 模型 |
| 工具失败 | `toolRetryMiddleware` 重试；仍失败把错误回灌模型自调整 |
| 审批超时 | BullMQ delayed job 到点 → 默认 `reject` 重入队续跑 + 通知（详见 §6） |
| Worker 崩溃 | BullMQ 重试 job + checkpointer 从断点续跑 |
| 前端断线 | Socket.IO 重连 + `task:resume{lastSeq}` 重放 |
| 上下文超限 | deepagents 自动 offload + summarize |

### 9.3 测试策略
- **单元**：事件信封 normalize 映射、审批决策（approve/edit/reject/respond）处理、对话树 parentUuid 重建、`SandboxProvider` 接口 mock。
- **集成**：Worker→Stream→Gateway 事件流贯通、`lastSeq` 断线重放、**Archiver 落档 + lastSeq 超 Stream 窗口时从 events_archive 重放**、`interruptOn` 中断 → resume 重入队由任意 Worker `Command(resume)` 续跑（MemorySaver 注入）、BullMQ 任务生命周期。
- **E2E**：提交目标→规划→工具调用→审批弹窗→批准→完成；断线重连恢复；任务暂停后续跑。

## 10. 第一期范围与 YAGNI 边界

**第一期做**：NextAuth Passkey 登录 + 标准 JWT 桥接 + 多租户鉴权 + Socket.IO 网关；BullMQ + Agent Worker；deepagents 主 agent（write_todos 规划 + 虚拟 FS + 外部 API/MCP/联网工具）；`interruptOn` 审批（4 种决策）；Redis Stream 流式 + 断线重放；Redis checkpointer 断点续跑；MySQL 持久化；guardrails 中间件；`/command` 路由层（skill 型 + prompt 模板型，系统内置）。

**预留接口、后期再做**：
- `SandboxProvider` / `SandboxBackendProtocol` → 接入沙箱（Daytona/Modal/E2B）解锁 `execute` shell 工具。
- 租户自定义 skill / command（StoreBackend namespace=租户 + 管理 UI + `commands`/`skills` 表）。
- 子 agent（同步优先；异步子 agent 需 LangGraph Platform）。
- 长期记忆（CompositeBackend + StoreBackend）。
- 全文检索（Meilisearch/ES）。

## 11. 关键约束与风险

1. **checkpointer 不可省**：`interruptOn` 审批与断点续跑的硬依赖。一期用 Redis RedisSaver（社区包，成熟度需验证；备选 Postgres 官方 saver）。
2. **异步子 agent 不可用**：依赖 LangGraph Platform，自托管下第一期只能同步子 agent（一期不用子 agent，规避）。
3. **MySQL 无官方 LangGraph saver**：故 checkpointer 走 Redis，业务数据走 MySQL，职责分离。
4. **E2B 非 deepagents 内置后端**：后期接沙箱时需自实现 `SandboxBackendProtocol` 适配 E2B，或改用内置的 Daytona/Modal。
5. **deepagents JS 版本成熟度**：部分能力（如异步子 agent、某些 backend）以 Python 为先；落地时按 npm 包实际能力核对，必要处用 LangGraph.js 直接实现等效逻辑。
6. **NextAuth Passkey provider 实验性**：需开 `experimental.enableWebAuthn`，且要求 DB adapter（authenticators/accounts 表）；落地核对 Auth.js 版本。JWT 桥接采用「callback 内另签标准 JWT」，避免 NestJS 依赖 Auth.js 私有 JWE 格式。
7. **deepagents skills 要求 `>=1.7.0`** 且遵循 agentskills.io 标准——`/command` 的 skill 型依赖此。prompt 模板型为自建路由层，不依赖 deepagents 版本，可作为 skill 型不可用时的兜底。
