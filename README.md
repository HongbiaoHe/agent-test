# agent-test

一个用于**研究 / 验证 Agent 开发技术**的实验仓库。

目标不是做一个具体产品，而是搭一套**端到端可运行的 Agent 应用骨架**，在里面快速试验各种 Agent 开发技巧（规划、工具调用、人审、技能系统、多轮上下文、实时流式、多租户、追踪等），并能很快地跑起来验证某个技术是否可行、怎么落地。

> 想快速上手当前进度，先读 `docs/superpowers/HANDOFF-2026-05-31.md`（最近一次交接，含运行方式与坑）。

---

## 技术栈

pnpm monorepo（`pnpm-workspace.yaml` → `apps/*`），Node 22。

### 后端 `apps/backend`
- **NestJS 11** —— 模块化后端框架
- **deepagents 1.10.2 + LangChain / LangGraph** —— Agent 核心（`createDeepAgent`）
- **Gemini**（`@langchain/google-genai`）—— LLM
- **Prisma + MySQL 8** —— 持久化（Conversation / Message / Approval / User / Tenant / Authenticator）
- **Redis Stack + BullMQ** —— 任务队列 + 事件 Stream + LangGraph checkpointer
- **Socket.IO** —— 实时事件推送
- **@simplewebauthn/server** —— Passkey / WebAuthn 鉴权
- **LangSmith** —— Agent 运行追踪
- **nestjs-pino** —— 结构化日志

### 前端 `apps/frontend`
- **Next 16 + React 19** —— App Router
- **Tailwind 4 + shadcn/ui** —— UI（manus 暖中性设计系统，见 `src/app/globals.css`）
- **TanStack Query** —— 数据请求
- **next-auth v5(beta) + @simplewebauthn/browser** —— 登录 / Passkey
- **socket.io-client** —— 实时订阅

---

## 仓库里在验证哪些 Agent 开发技巧

| 技巧 | 在哪看 |
| --- | --- |
| **规划 + 工具调用闭环**（`write_todos` 拆解 → 分步执行） | `apps/backend/src/agent/agent.factory.ts` |
| **自定义工具**（zod schema） | `apps/backend/src/agent/tools/` |
| **人在回路审批**（`interruptOn` + checkpointer，发邮件前拦截等用户批准） | `agent.factory.ts`、`apps/backend/src/worker/agent.processor.ts` |
| **技能系统**（deepagents 原生 SkillsMiddleware + progressive disclosure，`read_file` 按需加载 `SKILL.md`） | `apps/backend/skills/*/SKILL.md`、`agent.factory.ts` |
| **斜杠命令 `/command`** 显式触发技能 + 前端自动补全 | `apps/backend/src/commands/`、`apps/frontend/src/app/agent/` |
| **多轮上下文**（worker 每轮从 DB 重放历史，绕过 deepagents 不跨 run 留消息的限制） | `apps/backend/src/worker/agent.processor.ts` |
| **实时流式**（`agent.stream` 多模式事件 → normalize → Redis Stream → Socket.IO） | `apps/backend/src/agent/event-normalizer.ts`、`apps/backend/src/events/` |
| **异步任务管道**（提交 → BullMQ → Worker 消费） | `apps/backend/src/worker/`、`apps/backend/src/conversations/` |
| **多租户隔离**（按 `tenantId`，技能 / state 按 `thread_id` 隔离） | `apps/backend/prisma/schema.prisma`、各 service |
| **Passkey 登录**（WebAuthn，RP 自适应） | `apps/backend/src/auth/passkey.*` |
| **运行追踪**（LangSmith trace 命名 / tags） | `apps/backend/src/worker/agent.processor.ts` |

---

## 快速开始

### 1. 起依赖（MySQL + Redis Stack）

```bash
docker compose -f docker-compose.dev.yml up -d
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

- 后端：复制 `apps/backend/.env.example` → `apps/backend/.env`，填入 `GOOGLE_API_KEY`（其余本机默认即可）
- 前端：复制 `apps/frontend/.env.example` → `apps/frontend/.env.local`

### 4. 初始化数据库

```bash
cd apps/backend && npx prisma migrate dev
```

### 5. 启动

推荐用 **PM2** 一条命令同时拉起前后端（进程托管在后台，`pnpm dev` 末尾会 attach 日志流）：

```bash
pnpm dev            # PM2 启动 backend(3101) + frontend(3100)，并实时跟日志
```

`Ctrl+C` 只断开日志，服务仍在后台运行。常用管理命令：

```bash
pnpm dev:status     # 查看进程状态
pnpm dev:logs       # 重新跟随日志
pnpm dev:restart    # 重启前后端
pnpm dev:stop       # 停止并移除前后端进程
```

也可以分别单独起（不经 PM2，前台运行）：

```bash
pnpm dev:backend    # NestJS，默认 3101
pnpm dev:frontend   # Next，默认 3100
```

打开前端 `/login` 注册 Passkey 或邮箱登录，进 `/agent` 提交目标，即可看到规划 / 工具调用 / 流式输出；输入 `/` 触发技能命令。

> 注意：Node 必须 v22（仓库根有 `.nvmrc`）。PM2 已在 `ecosystem.config.cjs` 里把 nvm 的 v22 路径前置进 `PATH`，默认 shell 下也能正常启动。

---

## 常用脚本（根目录 `package.json`）

```bash
pnpm dev              # PM2 启动前后端 + 跟随日志（推荐）
pnpm dev:status       # PM2 进程状态
pnpm dev:logs         # 跟随前后端日志
pnpm dev:restart      # 重启前后端
pnpm dev:stop         # 停止并移除前后端进程
pnpm dev:backend      # 单独起后端 watch 模式（前台）
pnpm dev:frontend     # 单独起前端 dev（前台）
pnpm build            # 递归构建全部 workspace
pnpm lint             # 递归 lint
```

后端测试：`pnpm --filter backend test`。

> 开发进程编排见根目录 `ecosystem.config.cjs`；PM2 日志默认落在 `~/.pm2/logs`，不进仓库。

---

## 目录结构

```
agent-test/
├── apps/
│   ├── backend/          # NestJS + deepagents
│   │   ├── src/
│   │   │   ├── agent/         # Agent 装配、工具、事件 normalize
│   │   │   ├── worker/        # BullMQ Processor（跑 agent.stream）
│   │   │   ├── conversations/ # 会话 CRUD + 入队
│   │   │   ├── commands/      # /command 技能注册表
│   │   │   ├── events/        # Redis Stream + Socket.IO 网关
│   │   │   ├── auth/          # Passkey / JWT
│   │   │   └── common/        # 日志 / 错误体系 / 统一响应
│   │   ├── skills/        # 技能 SKILL.md（progressive disclosure）
│   │   └── prisma/        # schema + migrations
│   └── frontend/         # Next 16 三栏对话 UI
├── docs/superpowers/     # 设计 spec / 实施计划 / 交接文档
├── docker-compose.dev.yml
└── *.md                  # deepagents 设计与开发参考文档
```

---

## 参考文档

- `2026-05-29-deepagents-task-automation-agent-design.md` —— 完整第一期设计
- `docs/superpowers/specs/` —— walking skeleton 设计 spec
- `docs/superpowers/HANDOFF-*.md` —— 各阶段交接（含运行方式、已知坑、未做项）
- `LangChain-DeepAgents-完整的开发文档.md` —— deepagents 开发参考
