# Agent Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通"前端提交目标 → BullMQ → Worker 跑 deepagents(Gemini) → Redis Stream → Socket.IO → 前端流式 → 落 MySQL"的最小垂直切片。

**Architecture:** NestJS 单体内分层（Gateway + 同进程 BullMQ Worker），deepagents 作 agent 内核，Redis 同时承载队列与事件流，Prisma+MySQL 持久化，Next+shadcn 前端 socket.io-client 实时渲染。

**Tech Stack:** NestJS 11 · Prisma · MySQL 8 · Redis 7 · BullMQ · Socket.IO · deepagents + @langchain/google-genai · Next 16 + TanStack Query + shadcn/ui · pino。

**上游 spec:** [docs/superpowers/specs/2026-05-30-agent-walking-skeleton-design.md](../specs/2026-05-30-agent-walking-skeleton-design.md)

---

## ⚠️ 执行约定（覆盖模板默认）

- **不自动 commit**（CLAUDE.md 强约束）。每个 Task 末尾的"检查点"= 运行验证 + `git add` 暂存，**由用户决定何时 commit**。执行者不得自行 `git commit`。
- **Node 必须 v22.21.1**：每条 shell 命令前置 `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`（默认 shell 是 v14，pnpm/corepack 会语法报错）。
- **服务启动**用 `.claude/launch.json` 的 preview_start（已注入 v22 PATH），不要用裸 `pnpm dev`。
- **docker daemon** 当前未运行——Task 1 第一步需先开 Docker Desktop。
- 完成验证用真实运行 + 测试，不靠 `tsc` clean 单独判定（CLAUDE.md §0）。

---

## 文件结构

**后端 `apps/backend/`**
```
.env / .env.example
prisma/schema.prisma
src/
  main.ts                         (改: pino logger + 全局 filter/interceptor + CORS)
  app.module.ts                   (改: 导入各模块)
  prisma/{prisma.module,prisma.service}.ts
  common/
    errors/error-code.ts          ErrorCodes 集中表
    errors/business.exception.ts  BusinessException
    filters/all-exceptions.filter.ts
    interceptors/response.interceptor.ts
  agent/
    types.ts                      TaskEvent
    tools/get-weather.tool.ts
    agent.factory.ts              createDeepAgent 装配
    event-normalizer.ts (+ .spec.ts)
  events/
    redis.module.ts               ioredis provider
    stream.service.ts             Redis Stream XADD / XREAD
    events.gateway.ts             Socket.IO (room=taskId)
  worker/
    worker.module.ts              BullMQ 注册
    agent.processor.ts            Processor: 消费→stream→落库
  tasks/
    dto/create-task.dto.ts
    tasks.service.ts
    tasks.controller.ts
    tasks.module.ts
docker-compose.dev.yml            (仓库根)
```

**前端 `apps/frontend/`**
```
.env.local / .env.example(更新)
components.json                   (shadcn init)
src/components/ui/*               (shadcn add)
src/components/agent/*            业务组件(消息流/todo/工具卡)
src/lib/api.ts                    (改: 解析 {code,message,data})
src/lib/socket.ts                 socket.io-client 单例
src/app/agent/page.tsx            /agent 页
```

---

## Chunk 1: 基础设施 + 公共层

### Task 1: docker-compose + 后端环境变量

**Files:** Create `docker-compose.dev.yml`, `apps/backend/.env`, `apps/backend/.env.example`

- [ ] **Step 1: 开 Docker Desktop**
Run: `open -a Docker`（等 `docker info` 成功，约 10-30s）

- [ ] **Step 2: 写 `docker-compose.dev.yml`**
```yaml
services:
  mysql:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: dev
      MYSQL_DATABASE: agent
    ports: ["3306:3306"]
    volumes: ["./.docker-data/mysql:/var/lib/mysql"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-pdev"]
      interval: 5s
      timeout: 3s
      retries: 20
  redis:
    image: redis:7
    ports: ["6379:6379"]
    volumes: ["./.docker-data/redis:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20
```

- [ ] **Step 3: 写 `apps/backend/.env` 和 `.env.example`**（内容相同，`.env` 进 .gitignore）
```bash
PORT=3001
CORS_ORIGIN=http://localhost:3000
DATABASE_URL=mysql://root:dev@localhost:3306/agent
REDIS_URL=redis://localhost:6379
GOOGLE_GENAI_MODEL=gemini-2.0-flash
GOOGLE_API_KEY=
```

- [ ] **Step 4: 起依赖并验证 healthy**
Run: `docker compose -f docker-compose.dev.yml up -d`
然后轮询：`docker compose -f docker-compose.dev.yml ps`
Expected: mysql、redis 均 `healthy`
补充：`.docker-data/` 加进 `.gitignore`

- [ ] **Step 5: 检查点** — `git add docker-compose.dev.yml apps/backend/.env.example .gitignore`（**不 commit**，等用户）

### Task 2: Prisma + 数据模型

**Files:** Create `apps/backend/prisma/schema.prisma`, `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`

- [ ] **Step 1: 装依赖**
Run: `export PATH=...; pnpm --filter backend add @prisma/client && pnpm --filter backend add -D prisma`

- [ ] **Step 2: 写 `prisma/schema.prisma`**（见 spec §5：Task/Message 两表，datasource mysql，generator client）

- [ ] **Step 3: 生成 + 迁移**
Run: `cd apps/backend && npx prisma migrate dev --name init`
Expected: 生成 migration + `node_modules/.prisma/client`；MySQL 出现 Task/Message 表

- [ ] **Step 4: 写 `PrismaService`**（`extends PrismaClient`，`onModuleInit` 调 `$connect`）+ `PrismaModule`（`@Global()`，exports PrismaService）

- [ ] **Step 5: 验证连接** — 临时在 main.ts 或写个 spec 跑 `prisma.task.count()` 不报错

- [ ] **Step 6: 检查点** — `git add` 暂存（不 commit）

### Task 3: 错误体系 + 统一响应

**Files:** Create `src/common/errors/error-code.ts`, `business.exception.ts`, `filters/all-exceptions.filter.ts`, `interceptors/response.interceptor.ts`; Test `filters/all-exceptions.filter.spec.ts`

- [ ] **Step 1: 写 `error-code.ts`**（见 spec §7：ErrorCodes 常量表，分段 1xxxx/2xxxx/5xxxx）

- [ ] **Step 2: 写 `BusinessException`**
```ts
import { HttpException, HttpStatus } from '@nestjs/common';
export class BusinessException extends HttpException {
  constructor(
    public readonly err: { code: number; message: string },
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code: err.code, message: err.message }, status);
  }
}
```

- [ ] **Step 3: 写失败测试 `all-exceptions.filter.spec.ts`**
断言：`BusinessException` → 响应 `{code:err.code,message,data:null}` + warn 日志；普通 `Error` → `{code:50000,...}` + error 日志。

- [ ] **Step 4: 跑测试确认 FAIL**
Run: `export PATH=...; pnpm --filter backend test all-exceptions`
Expected: FAIL（filter 未实现）

- [ ] **Step 5: 写 `AllExceptionsFilter`**（`@Catch()`，区分 BusinessException vs 其他，统一输出 `{code,message,data:null}`，注入 pino logger 分级打日志）

- [ ] **Step 6: 写 `ResponseInterceptor`**（成功结果包成 `{code:0,message:'ok',data}`）

- [ ] **Step 7: 跑测试确认 PASS** + 检查点暂存

### Task 4: nestjs-pino 日志接入

**Files:** Modify `src/app.module.ts`, `src/main.ts`

- [ ] **Step 1: 装依赖** — `pnpm --filter backend add nestjs-pino pino-http pino-pretty`
- [ ] **Step 2: `app.module.ts` 导入 `LoggerModule.forRoot`**（dev 用 pino-pretty transport，autoLogging 开，request-id）
- [ ] **Step 3: `main.ts`**：`app.useLogger(app.get(Logger))`；注册全局 `AllExceptionsFilter` + `ResponseInterceptor`；`enableCors({origin: env.CORS_ORIGIN})`；`useGlobalPipes(new ValidationPipe())`
- [ ] **Step 4: 启动验证** — preview_start backend，看 pino 结构化日志输出；`curl :3001/api/hello` 返回被包成 `{code:0,...}`
- [ ] **Step 5: 检查点暂存**

> **Chunk 1 完成 = docker 依赖 healthy + Prisma 连库 + 错误/响应/日志体系就位 + 后端能起。**

---

## Chunk 2: Agent + 流式管道

### Task 5: agent 装配 + demo 工具 +（spike）验证 Gemini tool-calling

**Files:** Create `src/agent/tools/get-weather.tool.ts`, `src/agent/agent.factory.ts`, `src/agent/types.ts`

- [ ] **Step 1: 装依赖** — `pnpm --filter backend add deepagents @langchain/google-genai @langchain/core langchain zod`
- [ ] **Step 2: 写 `get-weather.tool.ts`**（`tool()` + zod schema `{city}`，返回假数据 `{city,tempC:23,condition:'晴'}`）
- [ ] **Step 3: 写 `agent.factory.ts`**（`createDeepAgent({model:'google-genai:'+env.GOOGLE_GENAI_MODEL, systemPrompt, tools:[getWeather], backend:new StateBackend()})`）
- [ ] **Step 4: 写 `types.ts`**（`TaskEvent` 接口，见 spec §4）
- [ ] **Step 5: SPIKE 验证**（需用户已填 `GOOGLE_API_KEY`）— 写个临时脚本 `npx tsx` 跑 `agent.invoke({messages:[{role:'user',content:'查一下北京天气并简短总结'}]})`，确认 Gemini 真的触发 `get_weather` tool-calling + write_todos。
Expected: 看到工具被调用 + 最终回答。**若 deepagents JS + Gemini 不支持 tool-calling，停下报告用户**（spec §13 风险）。
- [ ] **Step 6: 检查点暂存**

### Task 6: 事件 normalize（TDD）

**Files:** Create `src/agent/event-normalizer.ts`, Test `event-normalizer.spec.ts`

- [ ] **Step 1: 写失败测试** — 给定 mock 的 `stream` 元组样本（updates 含 todos / messages 含 token / ToolMessage），断言 `normalize(namespace,mode,data)` 产出正确 `TaskEvent.type`（plan_update/token/tool_end…）
- [ ] **Step 2: 跑测试 FAIL**
- [ ] **Step 3: 实现 `normalize`**（按 spec §4 映射表）
- [ ] **Step 4: 跑测试 PASS** + 检查点暂存

### Task 7: Redis(BullMQ + Stream) + Socket.IO Gateway

**Files:** Create `src/events/redis.module.ts`, `stream.service.ts`, `events.gateway.ts`, `src/worker/worker.module.ts`

- [ ] **Step 1: 装依赖** — `pnpm --filter backend add @nestjs/bullmq bullmq ioredis @nestjs/websockets @nestjs/platform-socket.io socket.io`
- [ ] **Step 2: `redis.module.ts`** — 提供 ioredis 单例（REDIS_URL）
- [ ] **Step 3: `stream.service.ts`** — `publish(taskId,evt)`=XADD；`subscribe(taskId,fromSeq,cb)`=XREAD BLOCK 循环
- [ ] **Step 4: `events.gateway.ts`** — `@WebSocketGateway({cors})`，处理 `task:subscribe` 加入 room + 启动 XREAD 转发 `task:event`
- [ ] **Step 5: `worker.module.ts`** — `BullModule.forRoot`(REDIS_URL) + `registerQueue('agent-run')`
- [ ] **Step 6: 启动验证** — backend 起，socket 能连（用 preview_eval 测 `io(':3001')` 连上）+ 检查点暂存

### Task 8: Worker Processor 串联

**Files:** Create `src/worker/agent.processor.ts`

- [ ] **Step 1: 写 `agent.processor.ts`**（`@Processor('agent-run')`）：
  - 取 `Task.status=running`
  - `agent.stream(input,{configurable:{thread_id:taskId},streamMode:['updates','messages','custom'],subgraphs:true})`
  - `for await` → `normalize` → `stream.publish` → 完整 message `prisma.message.create`
  - 结束 `Task.status=done` + publish `result`；catch → `status=failed` + publish `error`
- [ ] **Step 2: 单测**（注入 fake model + mock prisma/stream，断言状态流转 + publish 调用）
- [ ] **Step 3: 跑测试 PASS** + 检查点暂存

### Task 9: tasks 接口

**Files:** Create `src/tasks/dto/create-task.dto.ts`, `tasks.service.ts`, `tasks.controller.ts`, `tasks.module.ts`

- [ ] **Step 1: `create-task.dto.ts`** — `@IsNotEmpty() goal`（空则 ValidationPipe → 也可在 service 抛 `BusinessException(TASK_GOAL_EMPTY)`）
- [ ] **Step 2: `tasks.service.ts`** — `create(goal)`: prisma 建 Task(queued) + `queue.add('agent-run',{taskId,goal})`；`findOne(id)`: 不存在抛 `TASK_NOT_FOUND`
- [ ] **Step 3: `tasks.controller.ts`** — `POST /tasks` / `GET /tasks/:id`
- [ ] **Step 4: e2e 测试** — `POST /tasks{goal}` → 轮询 `GET /tasks/:id` 直到 done（用 fake model 或真 Gemini）→ 校验 messages 有数据
- [ ] **Step 5: 跑 e2e PASS** + 检查点暂存

> **Chunk 2 完成 = 后端全链路：提交→入队→Worker 跑 agent→流式事件→落库→状态 done，可通过 e2e 验证。**

---

## Chunk 3: 前端 + 联调验证

### Task 10: shadcn 初始化 + API/socket 基建

**Files:** `apps/frontend/components.json`(init), `src/lib/api.ts`(改), `src/lib/socket.ts`(create), `.env.local`, `.env.example`(更新)

- [ ] **Step 1: shadcn init** — `cd apps/frontend && pnpm dlx shadcn@latest init`（选默认/Tailwind4），`pnpm dlx shadcn@latest add button textarea card badge scroll-area skeleton`
- [ ] **Step 2: 装 socket** — `pnpm --filter frontend add socket.io-client`
- [ ] **Step 3: 写 `.env.local` + 更新 `.env.example`** — `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001`
- [ ] **Step 4: 改 `lib/api.ts`** — `postTask(goal)` 解析 `{code,message,data}`，`code!==0` throw Error(message)
- [ ] **Step 5: 写 `lib/socket.ts`** — `io(NEXT_PUBLIC_API_BASE_URL)` 单例 + `subscribeTask(taskId, onEvent)`
- [ ] **Step 6: 检查点暂存**

### Task 11: /agent 页 + 业务组件

**Files:** Create `src/app/agent/page.tsx`, `src/components/agent/{message-list,todo-list,tool-card}.tsx`

- [ ] **Step 1: 业务组件**（用 shadcn card/badge 组合）：`TodoList`(状态图标)、`ToolCard`(工具名+参数+结果)、`MessageList`(流式消息)
- [ ] **Step 2: `/agent/page.tsx`** — textarea+button 提交（TanStack Query mutation→postTask）；拿到 taskId 后 `subscribeTask` 累积事件渲染（token 累积、plan_update 更新 todos、tool_* 加卡片、result 落定）
- [ ] **Step 3: 检查点暂存**

### Task 12: 端到端联调验证

- [ ] **Step 1: 确认 `GOOGLE_API_KEY` 已填**（否则提示用户填）
- [ ] **Step 2: preview_start backend + frontend**（已在 launch.json）
- [ ] **Step 3: 打开 `/agent`**，提交"查询北京天气并总结"，用 preview_screenshot/eval 验证：看到 write_todos 规划 → get_weather 工具调用 → 最终回答流式出现
- [ ] **Step 4: 验证持久化** — `GET /tasks/:id` status=done；查 MySQL Message 有记录
- [ ] **Step 5: 跑全部测试** — `pnpm --filter backend test` + e2e 绿
- [ ] **Step 6: 检查点** — 汇总验证结果，`git add` 全部，列出变更清单**等用户 review 后提交**

> **Chunk 3 完成 = 用户在浏览器看到 agent 真跑 + 流式 + 持久化，全部测试通过。可运行可测试版本达成。**

---

## 验收清单（对应 spec §1 成功标准）

- [ ] docker compose mysql+redis healthy
- [ ] 后端 start:dev 正常，Prisma 连库、BullMQ 连 Redis
- [ ] `/agent` 提交 → 实时见 write_todos + get_weather + 回答
- [ ] Task=done，Message 有规划/工具/回答
- [ ] 单元(normalize/agent/filter) + e2e(提交→done) 通过

## 后续迭代（本计划之外，spec/设计文档已列）
审批 interruptOn+checkpointer → 鉴权多租户 → /command 路由 → 断线重放(events_archive Archiver) → guardrails → 子agent → 沙箱 → 独立 Worker 进程。
