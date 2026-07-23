# 画布工作流 Agent — 实现计划（MVP）

> 依据 spec：`docs/superpowers/specs/2026-07-22-canvas-workflow-agent-design.md`
> **全程不 commit**；做完 MVP 给用户验收。每个任务以 `pnpm lint` + `tsc` + 必要测试/预览实测收尾（对照 CLAUDE.md Verification 规则）。
> node 版本：跑测试前先切 v22.21.1（默认 shell 可能是 node 14 假绿）。

**Goal:** 独立的画布工作流模块 + `/canvas` 页面：一个持续执行、会规划、可长跑的画布 harness agent，自动搭工作流图并触发生成；运行期只读解决冲突；Run/token 落库；断线重放 + 断点续跑。不影响现有 agent。

**Architecture:** 独立表 + 独立队列 `canvas-run` + 独立 processor/factory/gateway；服务端单一真相源，`CanvasService.applyOp` 唯一写入口（事务：物化表 + CanvasOp 日志 + revision CAS），广播 `canvas_patch`，前端 react-flow 投影。复用 StreamService/MediaService/checkpointer。

---

## Chunk 1：数据模型
- [ ] 删除旧 scaffolding：旧 migration 目录 `20260722061650_add_canvas_workflow/`、旧 `canvas.types.ts`；从 `schema.prisma` 移除旧 4 表。
- [ ] 按 spec §4 写入 7 个 model：CanvasSession / CanvasRun / CanvasTokenUsage / CanvasMessage / CanvasNode / CanvasEdge / CanvasOp。
- [ ] `pnpm --filter backend prisma migrate dev --name canvas_workflow_v2`（或 `prisma migrate diff` 生成）。验证：`prisma generate` 无错、client 出现新类型。

## Chunk 2：后端 canvas 核心（写入口 + 快照 + 会话）
- [ ] `canvas.types.ts` 重写：CanvasNodeType、CanvasNodeDto、CanvasEdgeDto、CanvasSnapshot、CanvasPatch、CanvasOp 形状、token_usage payload。
- [ ] `common/errors/error-code.ts` 加 CANVAS_* 错误码（NOT_FOUND / BUSY / CONFLICT / NODE_NOT_FOUND / GOAL_EMPTY）。
- [ ] `canvas.service.ts`：
  - `applyOp(sessionId, actor, op, baseRevision?)` —— 事务：运行期拒 user 结构变更(CANVAS_BUSY)；空闲期 revision CAS(CANVAS_CONFLICT)；改物化表 + 追加 CanvasOp(seq) + revision++ + node.version++；返回新 revision + patch。提交后 `stream.publish(sessionId, {type:'canvas_patch', payload})`。
  - `moveNode(sessionId, nodeId, x, y)` —— LWW upsert，不占 revision，广播 move_node。
  - `snapshot(sessionId, tenantId)` —— 查 session+nodes+edges，生成节点按 mediaGenerationId JOIN 最新 MediaVersion 出 status/versionId。
  - `create/list/findMessages/appendMessage/stop` —— 镜像 ConversationsService（建 idle 会话、发目标落 user CanvasMessage + queue.add('run')、停止 CAS + aborts + media.cancel）。
  - 单测：applyOp 运行期拒绝 / 冲突 409 / op 日志追加 / move LWW。
- [ ] `dto/`：create-canvas / append-message / apply-op（op + baseRevision）/ move-node。
- [ ] `canvas.controller.ts`：`@Controller('canvas')` + JwtAuthGuard：POST / GET / GET :id / GET :id/messages / POST :id/messages / POST :id/stop / POST :id/ops / POST :id/nodes/:nodeId/move。
- [ ] 验证：lint + tsc + service 单测通过。

## Chunk 3：画布 agent + 工具
- [ ] `canvas.agent.factory.ts`：createDeepAgent（系统提示=画布 harness 角色；contextSchema{activePlan,userId,sessionId}；middleware=planContinuation+skillReadPolicy 复刻或精简；guardrails toolCallLimit/modelCallLimit；interruptOn{ask_user}；checkpointer）。BuiltAgent 接口复用。
- [ ] `canvas.tools.ts`：`createCanvasTools(svc, media, ctx)` → get_canvas/add_node/update_node/connect_nodes/delete_node/generate_media_node/ask_user。均 zod schema，改动经 svc.applyOp；generate_media_node 沿入边解析上游 image 版本作 referenceVersionIds。
- [ ] 单测：generate_media_node 参考图解析；工具 handler 调 applyOp。
- [ ] 验证：lint + tsc + 单测。

## Chunk 4：worker processor + gateway + 模块装配
- [ ] `canvas.abort.ts`：模块内 CANVAS_ABORTS token + AbortRegistry provider。
- [ ] `canvas.processor.ts`：`@Processor('canvas-run')` 镜像 agent.processor：CAS 门 + 建/收尾 CanvasRun；loadHistory(CanvasMessage)；buildActivePlan；stream；normalize+flush+persist(CanvasMessage)；token usage 抽取→CanvasTokenUsage+Run 累加+推 token_usage；interrupt→control_request+waiting_approval+timeout；resume；finalizeStopped。
- [ ] `canvas.gateway.ts`：`@WebSocketGateway`（复用 EventsGateway 结构）：canvas:subscribe（租户校验 CanvasSession + stream.subscribe emit canvas:event）、canvas:control:response（CAS + resume）。
- [ ] `canvas.module.ts`：imports BullModule.registerQueue({name:'canvas-run', 长跑 lockDuration/stalled 配置})、EventsModule(复用 StreamService)、MediaModule、RedisModule；providers CanvasService/CanvasController/CanvasProcessor/CanvasGateway/checkpointerProvider/CANVAS_ABORTS。
- [ ] `app.module.ts` 注册 CanvasModule。
- [ ] BullMQ 长跑：queue/worker 的 lockDuration（≥600000）、stalledInterval、maxStalledCount。
- [ ] 验证：lint + tsc；后端起得来（preview backend 或 nest build）。

## Chunk 5：前端 /canvas
- [ ] 装 `@xyflow/react`（pnpm --filter frontend add @xyflow/react）。
- [ ] `lib/api.ts` 加 canvas 接口；`lib/socket.ts` 加 subscribeCanvas / respondCanvasControl。
- [ ] `app/canvas/`：layout(持久壳) + page 占位 + [id]/page 占位 + `_components`（canvas-shell / react-flow 画布 / 4 种节点 / canvas-sidebar / chat 面板 / ask-panel / token-meter）+ `_hooks`（use-canvas 快照+patch 折叠 / use-canvas-thread 复刻 thread reducer）+ `_lib`（canvas-patch apply / thread reducer）。
- [ ] 运行期只读遮罩；空闲编辑带 baseRevision，409 重拉；位置拖拽空闲 LWW；生成节点复用 media blob 拉取；顶栏 token 累计。
- [ ] middleware 受保护路由加 `/canvas`。
- [ ] 遵循 DESIGN.md：语义 token + shadcn/ui + lucide；明暗都成立。
- [ ] 验证：lint + tsc + build；preview 实测（新建画布→发目标→agent 建节点连线触发生成→节点状态刷新→token 显示→stop）。

## 验收清单（给用户）
- 新建画布、发一句目标，agent 自动规划并画出工作流（建节点 + 连线）。
- 生成节点自动触发生成，卡片状态 queued→done 刷新出图。
- 运行期画布只读、聊天可见流式 + 计划 + 工具卡 + token 累计。
- agent 用 ask_user 提问 → 前端回答 → 续跑。
- 停止、断线重连恢复。
- 现有 /agent 功能不受影响。
</content>
