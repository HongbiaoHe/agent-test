# 画布工作流 Agent 模块 — 技术设计方案

> 日期：2026-07-22
> 技术栈：NestJS + deepagents(LangGraph.js) + BullMQ + Redis Stream + Prisma/MySQL + Next.js + @xyflow/react
> 参考基准：现有 agent 模块（`src/agent` / `src/worker` / `src/events` / `src/conversations` / `src/media`）

## 1. 目标与约束

做一个**画布工作流**模块与页面：画布支持 4 种节点（上传图片 / 生图 / 文本 / 生视频）+ 有向连线组成工作流。核心是**画布 agent**——一个持续执行、会规划步骤、可能运行一小时以上的 **harness agent**，自动搭建工作流图（建节点 + 连线）**并自动触发生成**，实现画布自动化。

**硬约束：**
- **高内聚独立模块**：独立会话、独立消息、独立 agent，**不影响现有 agent**（`agent-run` 队列 / `Conversation` / `Message` / `EventsGateway` 一行不改）。
- **持久执行**：浏览器关闭继续跑，断线重连恢复进度与历史，崩溃从断点续跑。
- **token 消耗落库**。
- **处理画布数据更新保存与 agent 操作的冲突**。

## 2. 关键设计决策（brainstorming 定案）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 模块隔离 | 独立表 + 独立队列 `canvas-run` + 独立 processor / factory / gateway 事件名 | 满足"不影响现有 agent"硬约束 |
| 基建复用 | 只读复用 `StreamService`、`MediaService`、`checkpointerProvider`、模型解析与前端 `api.ts`/`socket.ts` | 不改其行为，避免重复造轮子 |
| 运行/Run | **一级实体 `CanvasRun`**（状态/触发/token 总量/起止），一个画布可多次 Run | 长跑 harness 需要 run 级会计与审计 |
| token 会计 | **独立表 `CanvasTokenUsage`**（每次模型调用一行）+ Run 累计 | 可审计可聚合，token 落库 |
| 冲突模型 | **事件源/操作日志 `CanvasOp`（追加式）** + 乐观并发 `revision` | 可回放、可审计、顺序仲裁 |
| 画布状态存储 | **混合**：物化表 `CanvasNode`/`CanvasEdge` 存当前态 + 同事务追加 `CanvasOp` | 读快、又有事件源收益，MVP 性价比最高 |
| 节点数据 | **扁平可空强类型列**（非 Json blob） | 可查询、强类型、MVP 最轻 |
| 运行期冲突 | **运行期画布只读**（前端锁 + 服务端拒绝用户结构变更） | 最简；agent 独占写 → 零写-写竞争 |
| 自动化范围 | **搭图 + 自动执行生成**（复用 MediaService） | 契合"画布自动化" |
| HITL | **`ask_user` 工具 + `interruptOn`** 运行中向用户提问（`respond` 决策） | 用户要求 agent 能问问题 |
| image_upload | **模拟上传**（前端占位，不落真实文件） | MVP 边界 |

## 3. 架构与数据流

```
Next.js /canvas ──REST(快照/编辑/发消息/停止)──▶ NestJS CanvasController/Service
     ▲  socket.io(canvas:subscribe / canvas:event / canvas:control:response)
     │                                              │ queue.add('canvas-run')
     │                                              ▼
     │                                     BullMQ canvas-run
     │                                              ▼
  canvas:event ◀── StreamService(Redis Stream: conversation:{sessionId}:events) ◀── CanvasProcessor
                                                    │  deepagents.stream()
                                                    │  画布工具 → CanvasService.applyOp → 事务(物化表+CanvasOp+revision) → 广播 canvas_patch
                                                    │  usage_metadata → CanvasTokenUsage + Run 累计 + 推 token_usage
                                                    │  ask_user interrupt → control_request → waiting_approval
                                                    ▼
                                              MediaService.createGeneration('media-gen') → media_update(同一条 stream)
```

- **thread_id = CanvasSession.id**（多轮靠 processor 从 `CanvasMessage` 重放历史，deepagents 不在 state 留对话）。
- **推流复用 `StreamService`**：stream id 用 `sessionId`。媒体生成传 `sessionId` 作 conversationId，`media_update` 天然汇入同一条流。新 gateway 用 `canvas:subscribe` 从 `'$'` 订阅并 emit `canvas:event`（历史走 REST 快照 + `GET messages`，不重叠）。

## 4. 数据模型（推翻旧 scaffolding 重写）

```prisma
model CanvasSession {
  id        String  @id @default(cuid())
  title     String  @default("未命名画布")
  status    String  @default("idle") // idle|queued|running|waiting_approval|done|failed|stopped
  model     String?
  tenantId  String
  userId    String
  revision  Int     @default(0)      // = 最新结构 op 的 seq，乐观并发游标
  runs      CanvasRun[]
  messages  CanvasMessage[]
  nodes     CanvasNode[]
  edges     CanvasEdge[]
  ops       CanvasOp[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([tenantId])
}

model CanvasRun {                     // ★一级实体
  id               String  @id @default(cuid())
  sessionId        String
  session          CanvasSession @relation(fields:[sessionId], references:[id])
  status           String  @default("queued")
  trigger          Json                     // 触发本次运行的用户消息/目标
  model            String?
  error            String? @db.Text
  promptTokens     Int     @default(0)
  completionTokens Int     @default(0)
  totalTokens      Int     @default(0)
  startedAt        DateTime @default(now())
  endedAt          DateTime?
  @@index([sessionId])
}

model CanvasTokenUsage {              // ★token 独立表：每次模型调用一行
  id           String @id @default(cuid())
  sessionId    String
  runId        String
  model        String
  inputTokens  Int
  outputTokens Int
  totalTokens  Int
  createdAt    DateTime @default(now())
  @@index([sessionId])
  @@index([runId])
}

model CanvasMessage {                 // 独立对话消息表
  id        String @id @default(cuid())
  sessionId String
  session   CanvasSession @relation(fields:[sessionId], references:[id])
  runId     String?
  role      String        // user|assistant|tool
  type      String        // message|tool_start|tool_end|plan_update|control_request|result|error
  content   Json
  seq       Int
  createdAt DateTime @default(now())
  @@index([sessionId, seq])
}

model CanvasNode {                    // ★扁平强类型列
  id                String @id @default(cuid())
  sessionId         String
  session           CanvasSession @relation(fields:[sessionId], references:[id])
  type              String  // image_upload|image_gen|text|video_gen
  x                 Float   @default(0)   // 位置：LWW，不占 revision、不进 op 日志
  y                 Float   @default(0)
  label             String?
  text              String? @db.Text      // text 节点正文
  prompt            String? @db.Text      // image_gen/video_gen 提示词
  assetPath         String?               // image_upload 模拟上传占位
  mediaGenerationId String?               // 生成节点只存 generationId，状态靠 JOIN MediaVersion
  version           Int     @default(0)   // 节点级乐观锁
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([sessionId])
}

model CanvasEdge {
  id        String @id @default(cuid())
  sessionId String
  session   CanvasSession @relation(fields:[sessionId], references:[id])
  source    String
  target    String
  createdAt DateTime @default(now())
  @@index([sessionId])
  @@unique([sessionId, source, target])
}

model CanvasOp {                      // ★事件源/操作日志（追加式）
  id        String @id @default(cuid())
  sessionId String
  seq       Int                        // 单调递增 = session.revision
  actor     String                     // agent|user
  op        Json                       // add_node|update_node|remove_node|add_edge|remove_edge
  createdAt DateTime @default(now())
  @@unique([sessionId, seq])
}
```

旧 migration `20260722061650_add_canvas_workflow` 与旧 `canvas.types.ts` 将被删除/重写；生成新 migration。

## 5. 冲突模型（唯一写入口 + 运行期只读 + 空闲期乐观并发）

所有结构变更收敛到 `CanvasService.applyOp(sessionId, actor, op, baseRevision?)`：

1. **运行期（session.status busy）**：拒绝 `actor=user` 的结构变更（`CANVAS_BUSY`）；前端锁结构编辑 UI，仅平移缩放。agent 是唯一写者 → 零写-写竞争。
2. **空闲期用户编辑**：带 `baseRevision`；事务内 `where session.revision = baseRevision` CAS，不匹配 → `409 CANVAS_CONFLICT`，前端重拉快照。挡多标签页/并发用户。
3. **事务内容**（一次原子提交）：改物化表（node/edge）+ 追加 `CanvasOp(seq=revision+1)` + `session.revision++` + node.version++（若改 data）。
4. **位置 move**：presentation，LWW 独立轻量路径（直接 upsert x/y + 广播 `move_node`），不占 revision、不进 op 日志、不 409。
5. 事务提交后广播 `canvas_patch`（带变更后 `revision`）；前端 `revision` 跳变 >1 说明漏事件 → 重拉快照兜底。

## 6. 画布 Agent（持久 harness）

`src/canvas/canvas.agent.factory.ts`，照 `buildAgent` 模式装配 `createDeepAgent`：

- **规划**：内置 `write_todos` + 复刻 `planContinuationMiddleware`（跨 resume 不重订计划，计划文本由 processor 从 `CanvasMessage` 的最近 `plan_update` 算出经 runtime context 注入）。
- **guardrails**：`toolCallLimit` / `modelCallLimit`（高上限，防失控又允许长跑）。
- **interruptOn**：`{ ask_user: true }`。
- **画布工具**（worker 闭包注入 `sessionId`/`userId`，不经模型）：
  | 工具 | 作用 |
  |------|------|
  | `get_canvas` | 返回当前 `{nodes, edges}`（agent 感知画布态） |
  | `add_node` | 建节点（type + label/text/prompt + x/y）→ applyOp |
  | `update_node` | 改节点 data（version 乐观锁）→ applyOp |
  | `connect_nodes` | 建边（source→target）→ applyOp |
  | `delete_node` | 删节点（级联删相关边）→ applyOp |
  | `generate_media_node` | 触发生图/生视频：读节点 prompt + 沿入边解析上游 image 节点已完成版本作 referenceVersionIds → `MediaService.createGeneration(sessionId, userId, ...)` → 回填 `mediaGenerationId` → applyOp update_node |
  | `ask_user` | 向用户提问（`{question, options?}`），`interruptOn` 挂起，`respond` 决策续跑 |

## 7. Worker / Processor（镜像 `agent.processor`，独立）

`@Processor('canvas-run')`：
1. `kind==='timeout'` → handleTimeout 早退。
2. `aborts.register(sessionId)`（`CANVAS_ABORTS` = 模块内自建 `AbortRegistry` 实例，不碰共享 `AbortModule`）。
3. CAS 门 `session.status != stopped → running`；建/关联 `CanvasRun`。
4. `kind==='resume'` → `new Command({ resume:{ decisions } })`；否则 `loadHistory`(从 `CanvasMessage` 重放 message/tool_end) + `buildActivePlan`。
5. `agent.stream(input, { thread_id:sessionId, userId, signal, streamMode:['updates','messages'], subgraphs:true })`。
6. 消费流：`normalize`（复用现有 normalizer）；token 只推流、边界 `flush` 收口成 message 落 `CanvasMessage`；工具事件推流 + 落库。
7. **token 会计**：每次模型调用从 AIMessage `usage_metadata` 抽 `{input,output,total}` → 落 `CanvasTokenUsage` + 累加 `CanvasRun` + 推 `token_usage` 事件（只推流不落 message）。
8. **interrupt 检测**：`state.tasks[].interrupts` → 推 `control_request`(payload=问题/选项) + 落库 + CAS `running→waiting_approval` + 排 timeout job → return。
9. 终态：CAS `done|failed|stopped`，finalize `CanvasRun`(status/endedAt)。停止走 `finalizeStopped`。

**长跑配置**：`canvas-run` worker 调高 `lockDuration`（如 10min）+ 合理 `stalledInterval`/`maxStalledCount`，避免 1 小时 job 被误判 stalled 重复消费；BullMQ 在 job 活跃期间自动续锁。

`CanvasEventsGateway`：`canvas:subscribe`（租户校验 CanvasSession 归属 → `stream.subscribe` emit `canvas:event`）、`canvas:control:response`（CAS `waiting_approval→running` + 建审计 + 入队 resume）。

## 8. 前端 `/canvas`（react-flow）

- 装 `@xyflow/react` v12。仿 `/agent` 的 layout-wrapper 持久化模式。
- 三区：画布/会话列表侧栏 + **ReactFlow 画布**（4 种自定义节点 + 连线）+ 聊天侧栏（复刻 `thread.ts` reducer + `use-conversation` 的「React Query 基底 + socket 增量折叠」范式）。
- **画布状态**：`useQuery` 拉 `CanvasSnapshot`（含节点/边，生成节点 JOIN MediaVersion 出实时状态）作基底；`canvas:event` 的 `canvas_patch` 增量 apply 到 react-flow nodes/edges；`media_update` → invalidate 生成节点资产。
- **运行期只读遮罩**；空闲编辑经 REST 带 `baseRevision`，`409` 重拉。位置拖拽空闲期 LWW。
- **生成节点**复用现有 media 资产拉取（`generationId` → 最新版本 → 带鉴权 blob → `<img>/<video>`）。
- **ask_user**：运行期收 `control_request` → 聊天区弹问题+回答面板（复刻 `approval-panel` respond 视图）→ `canvas:control:response`。
- 顶栏显示当前 Run 的 token 累计（`token_usage` 事件驱动）。
- 遵循 `apps/frontend/DESIGN.md`：语义 token + shadcn/ui + lucide 图标，明暗都成立。

## 9. 事件类型

复用信封 `ConversationEvent`；type 集合：`token`(推流) / `message` / `tool_start` / `tool_end` / `plan_update` / `control_request` / `result` / `error` / `media_update` / `canvas_patch`(推流) / `token_usage`(新增，推流)。`canvas_patch`/`token_usage`/`token`/`media_update` 不落 `CanvasMessage`，只走流。

`CanvasPatch` payload：`add_node|update_node|move_node|remove_node|add_edge|remove_edge`，除 move 外均带变更后 `revision`。

## 10. MVP 边界（YAGNI）

**做**：4 种节点 + 连线；agent 自动搭图 + 触发生成；运行期只读冲突；op 日志 + 乐观并发；Run + token 落库；`ask_user` HITL；长跑 harness + 断线重放 + 断点续跑。

**不做（预留接口）**：真实图片上传落盘（image_upload 模拟）；CRDT 真协作编辑；节点执行 DAG 调度器（agent 顺序触发即可）；子 agent；画布模板/导出。

## 11. 测试策略

- **单元**：`applyOp` 事务（revision CAS / 冲突 409 / op 日志追加 / 运行期只读拒绝）；token usage 抽取与累加；参考图沿入边解析；事件 normalize；`generate_media_node` 参数与回填。
- **集成**：worker→Stream→gateway 事件贯通；运行期只读拒绝用户结构变更；断线重放（快照 + 增量不重复）；长跑 job 不 stalled；`ask_user` interrupt→resume 续跑（MemorySaver 注入）；stop 收尾（result 恰好一份）。
- **E2E（预览实测）**：新建画布 → 发目标 → agent 规划 + 建节点 + 连线 + 触发生成 → 生成卡片状态刷新 → token 累计显示 → stop。

## 12. 关键风险

1. **deepagents 单轮不留 state 对话**：多轮/resume 靠 `loadHistory` 从 `CanvasMessage` 重放（现有 agent 已踩过，照抄）。
2. **usage_metadata 可得性**：随 provider/流式实现而异；从 `updates` 模式的完整 AIMessage 抽取最稳，抽不到则跳过该次累加（不阻断运行）。
3. **长跑 job 的 BullMQ stalled**：必须调 `lockDuration`/`stalled` 配置，否则 1 小时 job 被重复消费。
4. **media_update 与画布节点对齐**：不回写 node.data，快照按 `mediaGenerationId` JOIN MediaVersion 算状态；事件仅驱动前端刷新。
5. **`revision` 与 `CanvasOp.seq` 一致性**：必须同事务自增，避免并发下游标漂移（运行期只读已消除 agent/user 并发，空闲期靠事务 CAS）。
</content>
</invoke>
