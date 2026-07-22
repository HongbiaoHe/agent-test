# 主动停止运行（Stop）设计

日期：2026-06-11
状态：方案 A + 默认语义已获用户确认

## 需求

发送消息后提供主动停止操作：立即停止当前 agent 运行的所有操作——LLM 流式、工具等待、媒体生成任务。

边界说明：abort 截断的是 agent 对工具结果的**等待**；已发往沙箱的 execute 命令不会被杀（execute 无 signal 透传，沙箱进程自然跑完但结果无人消费）。媒体取消按会话级——上一轮仍在生成中的视频也会被取消（「停止所有操作」的有意语义）。

## 已确认语义

- 已流出的文本与已落库消息**保留**；停止只截断未来，不回滚过去
- 停止后会话状态 `stopped`（新枚举值），与 done 等价对待：可继续发新消息
- `waiting_approval` 中停止 = 直接终态（审批卡随 result 收尾）
- 排队中（job 未开跑）的运行也可停止

## 架构（方案 A：进程内 Abort 注册表 + 协作取消）

前提事实：API 与 agent-run / media-gen 两个 BullMQ worker 同进程（worker.module / media.module 均注册于同一 Nest 应用）；`agent.stream(input, { signal })` 官方支持 AbortSignal（@langchain/core RunnableConfig.signal，types.d.ts:68）；视频生成是客户端 10s 轮询循环（google-media.client.ts:122），天然协作取消点。

多实例部署时进程内注册表失效，需换 Redis 广播——当前单进程架构下按 YAGNI 不做，此处留档。

```
前端 停止按钮 ──POST /conversations/:id/stop──▶ ConversationsService.stop()
  ① AbortRegistry.abort(id)        → agent.stream 抛 AbortError → worker 停止收尾
  ② MediaService.cancelByConversation(id) → 排队 job 移除 + 生成中协作取消
  ③ CAS 状态 → 'stopped'（queued/running/waiting_approval 命中）
  ④ 若 worker 未在跑（排队/审批中）→ 由 stop 端点补发 result{status:'stopped'} 事件
```

## 组件与变更点

### 后端

**`agent/abort-registry.ts`（新增）** — 通用进程内注册表：`register(key) → { signal, dispose }`（dispose 为闭包，仅当 map 中仍是本次注册的 controller 时才删除——防 timeout/并发 job 同 key 覆盖后误删他人注册）、`abort(key) → boolean`（未注册返回 false）。两处实例化：agent-run 按 conversationId、media 按 versionId（各自模块内独立 provider，DI token 区分）。

**`worker/agent.processor.ts`** — 接入顺序保证无漏停、无误删：
1. `kind === 'timeout'` 的早退**保持在最前**（timeout job 与 resume run 可共存，先 register 会覆盖正在跑的 resume 注册）
2. 之后 `register(conversationId)` 拿 `{ signal, dispose }`
3. CAS 门：`updateMany({ where: { id, status: { not: 'stopped' } }, data: { status: 'running' } })`；count=0 → **若 `signal.aborted` 则补发并持久化 `result {status:'stopped'}`**（端点见 abort=true 会跳过补发，见竞态规则），dispose 后 return
4. CAS 后补 `findUnique` 取整条记录（原 `update()` 顺带取 `userId/model` 的能力由此承接）
5. `agent.stream(input, { ...config, signal })`
6. `buf` 移到 try 外；catch 区分：`signal.aborted` → 停止收尾（flush 残余 buf → 发并持久化 `result {status:'stopped'}`，状态已由端点置好不再改写）；否则走现有 failed 分支
7. finally `dispose()`

**竞态规则（result 事件恰好一份）**：端点 `abort()` 返回 true ⇒ worker 一定能观察到 `signal.aborted`（同一 controller），由 **worker** 负责发 result（流中 catch 或 CAS 门分支）；返回 false ⇒ worker 尚未注册（排队中）或已结束，由**端点**按 CAS 命中数决定补发。两侧条件互斥，无重复无丢失。

**`conversations.controller/service`** — `POST :id/stop`：
```
先 findFirst({ id, tenantId }) 归属校验，无 → 404（沿用 assertConversationOwner 模式）
aborted = registry.abort(id)
await media.cancelByConversation(id)
cas = updateMany({ where: { id, status: { in: ['queued','running','waiting_approval'] } }, data: { status: 'stopped' } })
if (!aborted && cas.count > 0) → publish + persist result{status:'stopped'}   // 排队/审批中无 worker 收尾
return { stopped: aborted || cas.count > 0 }                                   // 幂等：重复停/已结束 → stopped:false
```

**`conversations.service.appendMessage`** — 两处配套（停止后会话可复活的关键）：
- 追加守卫从 `done/failed` 扩为 `done/failed/stopped`（stopped 与 done 等价语义）
- 入队新 run 时把会话状态**重置为 `queued`**——否则上一轮的 `stopped` 终态会让新 job 撞 CAS 门被误判「排队期间被停」，一次停止永久封死会话

**`media/media.service.ts`** — `cancelByConversation(conversationId)`：
- 两处 `queue.add('generate', { versionId })` 补 `{ jobId: versionId }`（取消时可定位 job）
- queued 版本：`queue.getJob(versionId)?.remove()` + 版本状态 `failed`（error=用户已停止）+ publish media_update；**remove() 失败（job 已被拾取为 active）则 try/catch 落到 abort 分支**，不让取消中断
- generating 版本：`mediaAborts.abort(versionId)` 协作取消

**`media/media.processor.ts` + `google-media.client.ts`** — processor 在调用 client 前 `register(versionId)`、finally dispose；client 的 `generateVideoBytes` 接收可选 signal，轮询循环每轮检查 `signal.aborted` → 抛 AbortError；`generateImageBytes` 调用前检查一次（单次短调用，结束后 processor 检查 aborted 则丢弃结果按 failed(用户已停止) 落库）；**processor 的 `waitForRef` 参考图等待循环（最长 5min）同样每轮查 signal**。

**装配**：ConversationsModule 新增 imports MediaModule（用 cancelByConversation）+ agent-run 注册表 provider（与 WorkerModule 共享同一单例，放 EventsModule 或独立 AbortModule 均可，实现时取依赖图最浅者）。schema.prisma status 注释枚举同步加 `stopped`。

### 前端

**`lib/api.ts`** — `stopConversation(id)` → POST stop。

**`chat-thread.tsx`** — busy 时发送按钮变停止（lucide `Square` 图标，`aria-label="停止"`），点击触发 `onStop`；新增 props `onStop`。

**`agent-shell.tsx`** — `stopMut = useMutation(stopConversation)`；传 `onStop` 给 ChatThread；防重复点击（isPending 禁用）。

**`thread.ts`** — `result` 事件 reducer 已通用收尾（置 done/收工具卡），无需改；`buildBaseState` 终态收尾条件加 `|| conv.status === "stopped"`。

**`conversation-sidebar.tsx`** — STATUS_BADGE 加 `stopped: { label: "已停止", variant: "outline" }`。

## 错误处理

| 场景 | 行为 |
|---|---|
| 重复点停止 / 已结束后停止 | 幂等，`stopped:false`，无副作用 |
| worker 正在跑但 abort 后流仍残留事件 | catch 后不再消费流；残余 buf flush 保留 |
| 媒体 job 已完成才收到取消 | getJob 不存在/状态 done → 跳过，不覆盖结果 |
| 媒体 job 取消瞬间被拾取为 active | remove() 抛错 → try/catch 落到协作 abort 分支 |
| 非属主调用 stop | findFirst 归属校验 → 404（沿用现有模式） |
| 停止后追加新消息 | appendMessage 守卫放行 stopped + 状态重置 queued，新 run 正常起跑 |

## 测试

- 单测：AbortRegistry（register/abort/unregister/未注册 abort=false）；processor 停止收尾分支（mock stream 抛 AbortError → 发 stopped result、不写 failed）；service.stop 三分支（运行中/排队中/已结束幂等）；media cancelByConversation（queued 移除、generating abort）
- E2E（preview）：发消息 → busy 中点停止 → 按钮恢复、状态 stopped、工具卡收尾、可继续发新消息
- 回归：现有 jest 全量绿；tsc + lint
