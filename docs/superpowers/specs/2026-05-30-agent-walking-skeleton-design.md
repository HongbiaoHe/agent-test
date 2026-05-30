# Agent Walking Skeleton — 设计 Spec

> 日期：2026-05-30
> 上游：参考 [2026-05-29-deepagents-task-automation-agent-design.md](../../../2026-05-29-deepagents-task-automation-agent-design.md)（完整第一期设计）
> 本 spec 范围：第一期的**最小垂直切片（walking skeleton）**，跑通核心异步管道 + agent 闭环，作为后续功能的地基。

---

## 1. 目标与成功标准

前端提交一个目标 → 经 BullMQ 派给 Worker → deepagents(Gemini) 自主 `write_todos` 规划并调用工具 → 执行过程经 Redis Stream + Socket.IO 实时流式到前端 → 任务与消息落 MySQL。

**成功标准（可运行可测试）：**
1. `docker compose -f docker-compose.dev.yml up -d` 起 mysql + redis 并 healthy
2. 后端 `pnpm --filter backend start:dev` 正常启动，Prisma 连上 MySQL，BullMQ 连上 Redis
3. 前端 `/agent` 页提交目标 → 实时看到 `write_todos` 规划、`get_weather` 工具调用、最终回答
4. 任务结束后 MySQL 的 `Task` 状态为 `done`，`Message` 表有规划/工具/回答记录
5. 单元测试（事件 normalize、agent 装配 mock model）+ 一个 e2e（提交→done）通过

## 2. 范围

**做（skeleton）：**
- docker-compose 本地 mysql + redis
- NestJS：HTTP 提交接口 + Socket.IO 网关 + BullMQ 队列 + 同进程 Worker
- deepagents 主 agent（Gemini）+ 内置 `write_todos`/虚拟 FS + demo 工具 `get_weather`
- `agent.stream` 事件 normalize → Redis Stream → Socket.IO 推前端
- Prisma 落 `Task` / `Message`
- 统一日志（nestjs-pino）+ 错误体系（业务/系统分类、集中 ErrorCodes、统一响应）
- 前端 shadcn/ui 的 `/agent` 页

**不做（YAGNI，后续迭代）：**
审批 `interruptOn`/checkpointer、鉴权/多租户/NextAuth、`/command` 路由、断线重放(`lastSeq`/events_archive)、guardrails 中间件、子 agent、沙箱、独立 Worker 进程、长期记忆。

## 3. 架构

```
Next 前端(3000) ──POST /tasks──▶ NestJS(3001) Gateway ──BullMQ.add──▶ Redis 队列
   ▲  socket.io-client                │                                   │
   └──Socket.IO◀─XREAD─ Gateway 订阅 Stream            BullMQ Worker(同进程)
                                                            │ createDeepAgent(Gemini)
                                                            │ agent.stream(streamMode,subgraphs)
                                                     每事件 XADD ▶ Redis Stream task:{id}:events
                                                     完整 message ─▶ MySQL(Task/Message)
```

**组件职责（apps/backend/src）：**

| 模块 | 职责 |
| --- | --- |
| `tasks/` | `POST /tasks`（建 Task + 入队）、`GET /tasks/:id`；DTO 校验 |
| `agent/` | deepagents 装配（model/tools/backend）、`get_weather` 工具、事件 normalize |
| `worker/` | `@nestjs/bullmq` Processor：消费任务、跑 agent.stream、写 Stream、落 Message、更新 Task 状态 |
| `events/` | Redis Stream 发布（XADD）+ 订阅转发；Socket.IO Gateway（room=taskId） |
| `prisma/` | PrismaService、schema |
| `common/` | 日志、错误（ErrorCodes/BusinessException/AllExceptionsFilter）、统一响应拦截器 |

## 4. 数据流

**提交：** 前端 `POST /tasks {goal}` → Gateway 校验（goal 非空，否则 `TASK_GOAL_EMPTY`）→ 建 `Task(status=queued)` → `BullMQ.add('agent-run',{taskId,goal})` → 返回 `{code:0,data:{taskId}}` → 前端 `socket.emit('task:subscribe',{taskId})` 加入 room。

**执行 + 流式：** Worker 领取 → `Task.status=running` → `createDeepAgent(...).stream(input,{configurable:{thread_id:taskId},streamMode:['updates','messages','custom'],subgraphs:true})` → 每事件 `normalize(namespace,mode,data)` 成 `TaskEvent{seq,taskId,type,payload,ts}` → `XADD task:{id}:events` → Gateway `XREAD BLOCK` → `socket.to(taskId).emit('task:event',evt)`。完整 message/工具结果落 `Message`。结束 → `Task.status=done` + `result` 事件。

**事件 normalize 映射：**
- `token`/`tool_start`/`tool_end` ← `streamMode:'messages'`（token 流 + `tool_call_chunks`/`ToolMessage`）
- `plan_update` ← `streamMode:'updates'` 的 `todos` channel
- `message`/`result` ← `updates`
- 自定义进度 ← `streamMode:'custom'`
- token 增量只走 Stream 不落库；完整 message 落 MySQL

**TaskEvent：**
```ts
interface TaskEvent {
  seq: string;      // Redis Stream id
  taskId: string;
  type: 'token' | 'message' | 'tool_start' | 'tool_end' | 'plan_update' | 'result' | 'error';
  payload: unknown;
  ts: number;
}
```

## 5. 数据模型（Prisma）

```prisma
model Task {
  id        String   @id @default(cuid())
  goal      String   @db.Text
  status    String   @default("queued") // queued|running|done|failed
  messages  Message[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Message {
  id        String   @id @default(cuid())
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id])
  role      String   // user|assistant|tool
  type      String   // message|tool_call|tool_result|plan|result
  content   Json
  seq       Int
  createdAt DateTime @default(now())
  @@index([taskId, seq])
}
```

## 6. Agent 装配

```ts
const agent = createDeepAgent({
  model: `google-genai:${process.env.GOOGLE_GENAI_MODEL ?? 'gemini-2.0-flash'}`,
  systemPrompt: '你是一个任务自动化助手，先用 write_todos 规划，再分步执行。',
  tools: [getWeatherTool],           // demo 工具
  backend: new StateBackend(),        // 一期虚拟 FS
  // 不配 interruptOn/checkpointer/subagents（skeleton）
});
```
- 需要 `@langchain/google-genai`（Gemini provider）
- `get_weather(city)`：`tool()` + zod schema，返回假数据 `{city, tempC, condition}`

## 7. 后端：日志与错误体系

**日志（nestjs-pino）：** 全局 LoggerModule，pino-http 自动记录请求（含 request-id），dev 用 pino-pretty。业务关键点手动打点：任务入队、agent 开始/结束、工具调用、错误。

**错误分类 + 统一响应** `{ code, message, data }`（成功 `code=0`）：

| 类型 | 处理 | HTTP | 日志 |
| --- | --- | --- | --- |
| 业务错误 | 抛 `BusinessException(ErrorCodes.X)` | 4xx | warn |
| 系统错误 | 全局 `AllExceptionsFilter` 兜底 → `INTERNAL_ERROR` | 5xx | error + stack |

**集中定义** `apps/backend/src/common/errors/error-code.ts`（按域分段）：
```ts
export const ErrorCodes = {
  TASK_NOT_FOUND:   { code: 10001, message: '任务不存在' },
  TASK_GOAL_EMPTY:  { code: 10002, message: '任务目标不能为空' },
  AGENT_RUN_FAILED: { code: 20001, message: 'Agent 执行失败' },
  INTERNAL_ERROR:   { code: 50000, message: '系统繁忙，请稍后重试' },
} as const;
```
- `BusinessException extends HttpException`：携带 code+message
- `AllExceptionsFilter`：`BusinessException` → 按其 code/message + warn；其他 → `INTERNAL_ERROR` + error(stack+request-id)，不泄漏内部
- 成功响应由 `ResponseInterceptor` 统一包成 `{code:0,message:'ok',data}`

## 8. 前端：shadcn/ui

- 初始化：`pnpm dlx shadcn@latest init`（Next 16 + Tailwind 4 + React 19），原子组件 `@/components/ui`
- `/agent` 页：`textarea`(目标) + `button`(提交，TanStack Query mutation `POST /tasks`) + socket.io-client 订阅 `task:event` 实时渲染
- 现成组件优先：`card`/`badge`(状态)/`scroll-area`/`skeleton`
- 业务组件 `@/components/agent/*`：消息流、todo 列表（状态图标）、工具调用卡片——组合 shadcn 原子组件，不够再二开
- `lib/api.ts` 统一解析 `{code,message,data}`，`code!==0` 抛带 message 的错误
- 保留现有 `/health` 自检页

## 9. 本地依赖与环境变量

**docker-compose.dev.yml：** mysql:8（`MYSQL_ROOT_PASSWORD=dev`/`MYSQL_DATABASE=agent`/3306/卷）+ redis:7（6379/卷）+ healthcheck。

**`apps/backend/.env`（+ `.env.example` 模板进 git）：**
```bash
PORT=3001
CORS_ORIGIN=http://localhost:3000
DATABASE_URL=mysql://root:dev@localhost:3306/agent
REDIS_URL=redis://localhost:6379
GOOGLE_GENAI_MODEL=gemini-2.0-flash
GOOGLE_API_KEY=            # ← 待用户填
```

**`apps/frontend/.env.local`（+ 更新 `.env.example`）：**
```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

`.gitignore` 已忽略 `.env*`（保留 `!.env.example`）；真实 `.env` 不进 git，模板进 git。唯一待填：`GOOGLE_API_KEY`。

## 10. 错误处理（运行时）

| 场景 | 处理 |
| --- | --- |
| LLM 错误 | deepagents 默认指数退避重试 |
| Worker 异常 | BullMQ 重试 + `Task.status=failed` + 发 `error` 事件 |
| goal 为空 | `BusinessException(TASK_GOAL_EMPTY)` 400 |
| 任务不存在 | `BusinessException(TASK_NOT_FOUND)` 404 |
| 前端断线 | socket.io 自动重连（lastSeq 重放留后续） |

## 11. 测试策略

- **单元**：事件 `normalize` 映射；agent 装配（注入 fake model 不调真 LLM）；`AllExceptionsFilter` 业务/系统分流
- **e2e**：`POST /tasks` → 轮询 `GET /tasks/:id` 直到 `done` → 校验 Message 有数据（需 mysql+redis，可用 fake model 或真 Gemini）
- **联调**：手动跑 `/agent` 页，preview 验证流式可见

## 12. 实施顺序（供 writing-plans 参考）

1. docker-compose + 后端 env + Prisma schema + migrate
2. 公共层：日志(pino) + 错误体系(ErrorCodes/BusinessException/filter/response interceptor)
3. Redis(BullMQ + Stream) + Socket.IO Gateway 接线
4. agent 装配(Gemini + get_weather) + 事件 normalize
5. Worker Processor 串起：消费→stream→XADD→落库→状态
6. `POST /tasks`/`GET /tasks/:id` + 提交→入队
7. 前端 shadcn init + `/agent` 页 + socket 订阅渲染
8. 测试（单元+e2e）+ 联调验证

## 13. 关键依赖与风险

- `deepagents` + `@langchain/google-genai` JS 版本/Gemini tool-calling 实际能力——落地首步先 spike 验证 `createDeepAgent` + Gemini 能跑 tool-calling
- `agent.stream` 多模式 + `subgraphs` 的事件结构需按实际包核对 normalize
- 同进程 Worker 长任务会占用进程——skeleton 可接受，后续拆独立进程
