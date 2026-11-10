# AgentSpark

**AgentSpark（Web）+ Spark（桌面端）双形态的 Agent 工作台**，同时也是一个用于**研究 / 验证 Agent 开发技术**的实验仓库。

目标不是做一个具体产品，而是搭一套**端到端可运行的 Agent 应用骨架**，在里面快速试验各种 Agent 开发技巧（规划、工具调用、人审、技能系统、多轮上下文、实时流式、多租户、MCP、后台任务、云沙箱、多端复用等），并能很快跑起来验证某个技术是否可行、怎么落地。当前仓库已经在这套骨架上落出了一批真实可用的内容创作能力：对话、节点画布、分图层设计、生图 / 生视频 / 配音、视频剪辑。

> 想快速上手当前进度：先读 `docs/superpowers/specs/`（每个功能的方案）和 `docs/superpowers/plans/`（对应实施记录）；历史交接与踩坑见 `docs/superpowers/HANDOFF-*.md`。

---

## 两个形态

| | **AgentSpark（Web）** | **Spark（桌面端）** |
| --- | --- | --- |
| 入口 | `apps/frontend` + `apps/backend` | `apps/desktop`（Electron） |
| Agent 跑在哪 | 服务端 BullMQ worker | 本机 `utilityProcess`（agent-host） |
| 账号 / 数据 | Passkey / 邮箱验证码登录，多租户，MySQL + Redis | 无需账号，本机 SQLite，模型 Key 经 `safeStorage` 加密 |
| 主打能力 | 画布、分图层设计、媒体生成、MCP、后台任务、云沙箱 | 本机文件 / 命令、视频剪辑、离线可用 |
| 共享 | `@agent-test/agent-core` 提供同一套 agent 装配、技能、模式、MCP、沙箱抽象 | 同左 |

---

## 技术栈

pnpm monorepo（`pnpm-workspace.yaml` → `apps/*` + `packages/*`），Node 22（`.nvmrc` = **22.21.1**），pnpm 11.5。

### 后端 `apps/backend`
- **NestJS 11** —— 模块化后端框架
- **deepagents 1.10.2 + LangChain / LangGraph** —— Agent 核心（`createDeepAgent`）；主对话 / 画布 / 设计是三条独立 agent 链路
- **Gemini + DeepSeek**（`@langchain/google-genai`、`@langchain/deepseek`）—— 多模型切换 + 思考深度档位
- **Prisma 6 + MySQL 8** —— 持久化（Conversation / Message / MediaGeneration / CanvasSession / DesignDoc / McpServer / Skill / AgentMode / BackgroundTask …）
- **Redis Stack + BullMQ** —— 任务队列 + 事件 Stream + LangGraph checkpointer（RedisSaver 依赖 RediSearch / RedisJSON）
- **Socket.IO** —— 实时事件推送
- **@simplewebauthn/server + JWT** —— Passkey / 邮箱验证码登录，多租户隔离
- **@modelcontextprotocol/sdk** —— MCP 连接器（OAuth、工具调用、MCP Apps 卡片）
- **Daytona / E2B** —— 云沙箱（技能脚本执行，用户可在设置页切换）
- **skia-canvas + Konva** —— 设计稿后端同构渲染（缩略图、agent 自检）
- **nestjs-pino** —— 结构化日志

### 前端 `apps/frontend`
- **Next 16 + React 19** —— App Router，`/api-backend/*` 做同源 BFF 反代并注入 backend token
- **Tailwind 4 + shadcn/ui** —— UI（manus 暖中性设计系统，见 `apps/frontend/DESIGN.md`）
- **TanStack Query** —— 数据请求
- **react-konva + @xyflow/react** —— 画布 / 设计编辑器
- **next-auth v5(beta) + @simplewebauthn/browser** —— 登录 / Passkey
- **socket.io-client** —— 实时订阅
- **three.js + GSAP** —— `/lab` 3D 页面实验场、落地页滚动动效
- **Playwright** —— 端到端测试

### 桌面端 `apps/desktop`
- **Electron 45 + electron-vite + React 19 + Vite + Tailwind 4**
- **本机 agent-host**（`utilityProcess`）+ **`node:sqlite`** + 自写 LangGraph checkpointer（不依赖 better-sqlite3）
- **ffmpeg** —— 视频剪辑器探测 / 导出（分发从源码自建的 GPL 版）
- **react-i18next** —— zh-CN / zh-Hant / en 三语

### 共享包 `packages/*`
- **`@agent-test/agent-core`** —— web / desktop 共用的 agent 核心：`buildAgent`、系统提示通用段、GuardedSandbox、模型 / 思考档位、事件归一、技能解析、MCP 客户端、模式与工具注册表。**不依赖 Nest / Prisma / Redis**
- **`@agent-test/design-schema`** —— 设计稿 / 图层 / op / 字体 / 模型白名单 zod schema（前端、后端、agent 工具三方共用）
- **`@agent-test/video-schema`** —— 剪辑工程 schema 与时间线计算（agent 工具、剪辑器、导出器共用）

---

## 功能地图

### 对话 Agent（`/agent`、桌面端）
- 规划 + 工具调用闭环（`write_todos` 拆解 → 分步执行）、`ask_user` 提问卡片
- 人在回路审批（`send_email`、需审批的 MCP 工具；中断后带决策续跑）
- 技能系统：内置 + 用户安装技能，progressive disclosure 按需加载 `SKILL.md`；技能脚本可跑在云沙箱
- 斜杠命令 `/command` 显式触发技能 + 前端自动补全
- **Agent 模式**：每用户一份装配配置（系统提示 + 勾选代码工具 / MCP server / 技能 + 默认模型 / 思考档位）；平台提示词片段可改写，也支持自建片段（`{{custom.xxx}}`）
- **多模型 + 思考档位**：Gemini / DeepSeek 白名单；auto / off / on / low / medium / high（按模型能力裁剪）
- **MCP 连接器**：添加 server、OAuth 授权、工具调用与审批、MCP Apps 卡片
- 附件上传 + 媒体分析（Gemini 读图片 / 视频 / 音频）
- **后台任务**：`run_in_background` / `watch_until` / `schedule_wakeup` / `cancel_background_task`，任务状态在对话里以卡片展示
- 实时流式（token / 工具 / 计划 / 审批事件）与停止运行
- 多轮上下文：worker 每轮从 DB 重放历史，checkpointer 负责中断续跑

### 内容创作（Web）
- **画布 `/canvas/[id]`**：节点画布（可缩放 / 拖拽 / 连线），图片 / 视频 / 音频节点 + 生成节点 + 视频拼接节点；agent 工具可直接批量 `add_nodes` / `update_nodes` / `connect_nodes` / `generate_media_node` / `merge_video_node`
- **分图层设计 `/design/[id]`**：设计文档 = 画布 + 图层 + ops；agent 增删改图层、生成图层图片、拆层（Seedream 5.0 Pro 直连 BytePlus）；后端 Konva + skia 同构渲染缩略图
- **媒体生成**：生图 / 生视频 / 生音频 / 配音统一走 aigc 生成服务（模型目录、回调、轮询兜底、资产版本）
- **网页 / 端口预览**：agent 生成的站点或起的 dev server，经子域名反代预览（`p-<id>.<base>`），vite HMR 可用

### 桌面端 Spark
- 本机 agent：文件读写限制在工作区，shell 用 `GuardedSandbox` 包 `LocalShellBackend`；崩溃 / 强退有收尾
- 技能 / MCP / 模式 / 后台任务与 Web 同源（共享 `agent-core`），另内置 6 个技能（策略 / 文案 / 设计 / 音频 / 视频 + 建技能向导）
- **视频剪辑器**：时间线工程（`@agent-test/video-schema`）、素材探测、字幕、ffmpeg 导出；agent 工具 `create_video_project` / `check_video_project`
- 网页预览（`spark-preview://`）与 MCP Apps 沙箱（`spark-mcp://`）特权协议
- 可选登录 Web 账号，生图 / 生视频 / 配音走 Web 的 `/media-api`

---

## 仓库里在验证哪些 Agent 开发技巧

| 技巧 | 在哪看 |
| --- | --- |
| **规划 + 工具调用闭环** | `packages/agent-core/src/agent/agent.factory.ts` |
| **自定义工具**（zod schema） | `packages/agent-core/src/agent/tools/`、`apps/backend/src/agent/tools/` |
| **人在回路审批**（`interruptOn` + checkpointer） | `apps/backend/src/worker/agent.processor.ts`、`packages/agent-core/src/agent/tools/ask-user.tool.ts` |
| **技能系统**（progressive disclosure） | `packages/agent-core/src/skills/`、`apps/backend/skills/*/SKILL.md` |
| **斜杠命令** `/command` | `packages/agent-core/src/commands/parse-command.ts`、`apps/backend/src/commands/` |
| **多轮上下文**（每轮重放 DB 历史） | `apps/backend/src/worker/agent.processor.ts`、`apps/backend/src/agent/latest-persistent-redis-saver.ts` |
| **实时流式**（normalize → Redis Stream → Socket.IO） | `packages/agent-core/src/agent/event-normalizer.ts`、`apps/backend/src/events/` |
| **异步任务管道**（提交 → BullMQ → Worker） | `apps/backend/src/worker/`、`apps/backend/src/conversations/` |
| **多模型 + 思考档位** | `packages/agent-core/src/agent/models.ts`、`packages/agent-core/src/agent/thinking-level.ts` |
| **Agent 模式 + 工具注册表** | `packages/agent-core/src/modes/` |
| **MCP 客户端 / OAuth / 工具审批** | `packages/agent-core/src/mcp/`、`apps/backend/src/mcp/` |
| **沙箱抽象**（GuardedSandbox） | `packages/agent-core/src/agent/guarded-sandbox.ts`、`apps/backend/src/sandbox/` |
| **后台任务**（watch / command / wakeup） | `apps/backend/src/background/` |
| **多租户隔离**（按 `tenantId`） | `apps/backend/prisma/schema.prisma`、各 service |
| **Passkey 登录**（WebAuthn） | `apps/backend/src/auth/passkey.service.ts` |
| **画布 agent**（把画布操作工具化） | `apps/backend/src/canvas/canvas.agent.factory.ts`、`apps/backend/src/canvas/canvas.tools.ts` |
| **分图层设计 agent** | `apps/backend/src/design/agent/design.agent.factory.ts` |
| **桌面本地 agent**（utilityProcess + 本机 SQLite） | `apps/desktop/src/agent-host/run/run-service.ts` |
| **媒体生成管道**（aigc + 回调 + 轮询兜底） | `apps/backend/src/media/`、`apps/backend/src/aigc/` |

---

## 快速开始

### 1. 起依赖（MySQL + Redis Stack）

```bash
docker compose -f docker-compose.dev.yml up -d
```

Redis 必须是 **stack** 版（含 RediSearch / RedisJSON），checkpointer 依赖 `FT.CREATE` / `JSON.SET`。

### 2. 安装依赖

```bash
nvm use            # .nvmrc = 22.21.1
pnpm install
```

### 3. 配置环境变量

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
```

后端 `.env` **必填**：
- `GOOGLE_API_KEY`（Gemini，agent 主模型）
- `AUTH_JWT_SECRET`、`MCP_TOKEN_ENC_KEY`（缺失后端起不来）

按需再填：
- `DAYTONA_API_KEY` / `E2B_API_KEY` —— 技能脚本云沙箱（留空自动回退为无命令执行能力）
- `AIGC_BASE_URL` / `AIGC_TOKEN` —— 生图 / 生视频 / 配音（模型清单也经它取）
- `BYTEPLUS_ARK_API_KEY` —— 设计模块的 Seedream 5.0 Pro 拆层
- `RESEND_API_KEY` —— 登录验证码邮件

### 4. 初始化数据库

```bash
cd apps/backend
npx prisma migrate dev
```

### 5. 启动 Web

```bash
pnpm dev
```

PM2 会同时拉起 `agent-core`（tsc watch）、`backend`（**3101**）、`frontend`（**3100**）；脚本做健康检查，通过后自己退出，进程在后台常驻。常用管理命令：

```bash
pnpm dev:status     # 进程状态
pnpm dev:logs       # 跟随日志
pnpm dev:restart    # 重启
pnpm dev:stop       # 停止并移除
```

也可以不经 PM2 单独前台起：`pnpm dev:backend` / `pnpm dev:frontend`。

打开 <http://localhost:3100>：`/` 是公开落地页，`/login` 用 Passkey 或邮箱验证码登录，`/agent` 进三栏对话；`/canvas` 是画布介绍页，`/canvas-list`、`/design` 需登录。

> 注意：Node 必须 v22（`.nvmrc`）。`ecosystem.config.cjs` 已把 nvm 的 v22 路径前置进 `PATH`，默认 shell 下也能正常启动。

### 6. 启动桌面端（可选）

```bash
pnpm --filter desktop dev
```

首启选工作目录、填模型 Key；不登录也能用（本机 SQLite）。要在桌面端生图 / 生视频 / 配音，需在设置里登录 Web 账号。

### 7. 外网 / 手机访问（可选）

```bash
pnpm tunnel         # ngrok 暴露 3100，打印 URL + 二维码
pnpm tunnel:off     # 关闭隧道
```

aigc 回调、Passkey 跨设备演示、手机调试都走这条隧道（免费版同时只能跑一条）。

---

## 常用脚本（根目录 `package.json`）

```bash
pnpm dev              # PM2 起 agent-core + backend + frontend，健康检查后退出
pnpm dev:status       # PM2 进程状态
pnpm dev:logs         # 跟随前后端日志
pnpm dev:restart      # 重启前后端
pnpm dev:stop         # 停止并移除进程
pnpm dev:backend      # 单独前台起后端（3101）
pnpm dev:frontend     # 单独前台起前端（3100）
pnpm tunnel           # 开 ngrok 隧道（3100）
pnpm tunnel:off       # 关隧道
pnpm build            # 递归构建全部 workspace
pnpm lint             # 递归 lint
pnpm test:scripts     # scripts/*.test.mjs
```

各端测试：

```bash
pnpm --filter backend test                    # 后端 Jest
pnpm --filter @agent-test/agent-core test     # 共享包 Jest
pnpm --filter desktop test                    # 桌面 agent-host Vitest
pnpm --filter frontend e2e                    # 前端 Playwright
```

> 开发进程编排见根目录 `ecosystem.config.cjs`；PM2 的 home 是仓库内 `.pm2/`（`PM2_HOME=./.pm2`），日志落在 `.pm2/logs`，不进仓库。

---

## 目录结构

```
agent-test/
├── apps/
│   ├── backend/                 # NestJS 11 + deepagents
│   │   ├── src/
│   │   │   ├── agent/           # Web 版 agent 装配、工具、提示词、checkpointer、沙箱
│   │   │   ├── worker/          # 主对话 BullMQ processor（跑 agent.stream）
│   │   │   ├── conversations/   # 会话 CRUD + 追加入队
│   │   │   ├── commands/        # /command 技能注册表
│   │   │   ├── events/          # Redis Stream + Socket.IO 网关
│   │   │   ├── canvas/          # 画布 agent、画布 ops、gateway
│   │   │   ├── design/          # 分图层设计 agent、生成队列、同构渲染
│   │   │   ├── media/           # 生图 / 生视频 / 音频、上传、回调对账
│   │   │   ├── media-analysis/  # 附件媒体分析
│   │   │   ├── aigc/            # aigc 生成服务客户端与模型目录
│   │   │   ├── mcp/  modes/  skills/  background/
│   │   │   ├── preview/         # 站点 / 端口预览反代
│   │   │   ├── sandbox/         # Daytona / E2B 云沙箱设置与迁移
│   │   │   ├── auth/  users/  common/
│   │   │   └── prisma/
│   │   ├── skills/              # 内置技能（email-compose / marketing-strategist / tvc-director）
│   │   └── prisma/              # schema + migrations
│   ├── frontend/                # Next 16：三栏对话、画布、设计、设置
│   └── desktop/                 # Spark：Electron 桌面端（本机 agent + 视频剪辑器）
├── packages/
│   ├── agent-core/              # web / desktop 共用 agent 核心
│   ├── design-schema/           # 设计稿 schema（三方共用）
│   └── video-schema/            # 剪辑工程 schema + 时间线计算
├── docs/
│   ├── superpowers/             # specs（方案）+ plans（实施计划）+ HANDOFF（交接）
│   ├── canvas-agent-*.html      # 画布全链路架构 / 数据流
│   └── video*/                  # 介绍视频的生成脚本
├── scripts/                     # dev / 健康检查 / ngrok 隧道
├── docker-compose.dev.yml
├── ecosystem.config.cjs         # PM2 进程编排
└── pnpm-workspace.yaml
```

---

## 文档索引

- `CLAUDE.md` —— 协作约定（禁 `any`、设计系统、不自动 commit 等）
- `apps/frontend/DESIGN.md` —— 前端设计系统（token 表、暗色机制、shadcn 约定）
- `docs/superpowers/specs/` —— 每个功能的设计方案
- `docs/superpowers/plans/` —— 对应的实施计划
- `docs/superpowers/HANDOFF-*.md` —— 历史交接（运行方式、已知坑）
- `docs/canvas-agent-architecture.html` / `docs/canvas-agent-dataflow.html` —— 画布 agent 架构与逐操作数据流
- `2026-05-29-deepagents-task-automation-agent-design.md` —— 第一期整体设计
- `.claude/skills/deepagents-dev/` —— deepagents 开发参考（`/deepagents-dev` 调用）
