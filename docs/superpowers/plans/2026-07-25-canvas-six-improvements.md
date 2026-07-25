# Canvas 六项改进实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 节点内编辑自动保存、Cmd/Ctrl+D 复制节点、生成动作用户确认、修切画布空白 bug、会话列表滚动加载、会话 token 会话级持久化。

**Architecture:** 全部复用既有基建：结构编辑走 `update_node/add_node` op（revision CAS），确认走 `interruptOn`+`chat.ask` 分流，token 走 run 持久化 + 快照聚合回传，分页走 Prisma cursor + useInfiniteQuery。

**Tech Stack:** NestJS + Prisma、Next.js 16 + react-flow(@xyflow/react) + React Query。

**约束（覆盖模板默认）：** CLAUDE.md 禁自动 commit——Commit 步骤替换为「标记完成，用户 review 后统一提交」。测试前 `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH`。

**设计文档：** docs/superpowers/specs/2026-07-25-canvas-six-improvements-design.md

---

## 文件结构

| 文件 | 动作 | 项 |
| --- | --- | --- |
| `apps/backend/src/canvas/canvas.service.ts` | 修改 | #5 list 分页；#6 buildSnapshot 聚合 totalTokens |
| `apps/backend/src/canvas/canvas.controller.ts` | 修改 | #5 list query 参数 |
| `apps/backend/src/canvas/canvas.service.spec.ts` | 修改 | #5/#6 单测 |
| `apps/backend/src/canvas/canvas.types.ts` | 修改 | #6 CanvasSnapshot.totalTokens |
| `apps/backend/src/canvas/canvas.processor.ts` | 修改 | #6 cumulativeTotal 从会话历史起算 |
| `apps/backend/src/canvas/canvas.agent.factory.ts` | 修改 | #3 interruptOn + 系统提示 |
| `apps/frontend/src/lib/api.ts` | 修改 | #5 分页 DTO；#6 totalTokens |
| `apps/frontend/src/app/canvas/_lib/chat.ts` | 修改 | #3 extractAsk 文案 |
| `apps/frontend/src/app/canvas/_components/canvas-chat.tsx` | 修改 | #3 CONFIRM_TOOLS |
| `apps/frontend/src/app/canvas/_components/flow-canvas.tsx` | 修改 | #1 EditorContext；#2 Cmd+D；#4 FitOnFirstLoad |
| `apps/frontend/src/app/canvas/_components/canvas-nodes.tsx` | 修改 | #1 节点内编辑 |
| `apps/frontend/src/app/canvas/_components/canvas-shell.tsx` | 修改 | #4 FlowCanvas key=sessionId |
| `apps/frontend/src/app/canvas/_components/canvas-sidebar.tsx` | 修改 | #5 useInfiniteQuery + 哨兵 |
| `apps/frontend/src/app/canvas/_hooks/use-canvas.ts` | 修改 | #6 快照 seed tokens |

## Task 1（#6 token 持久化，后端 TDD）

- [ ] 1.1 `canvas.types.ts` `CanvasSnapshot` 增加 `totalTokens: number`。
- [ ] 1.2 spec 加失败测试：`snapshot` 返回含 runs 聚合 totalTokens（mock prisma canvasRun.aggregate）；`list` 分页测试同 Task 2 一并写。
- [ ] 1.3 `buildSnapshot`：`const agg = await this.prisma.canvasRun.aggregate({ where: { sessionId: id }, _sum: { totalTokens: true } })` → `totalTokens: agg._sum.totalTokens ?? 0`。
- [ ] 1.4 `canvas.processor.ts` run 起跑处（`let cumulativeTotal = 0;` L139）改为从会话历史总量起算（同一 aggregate）；注释说明「socket token_usage 事件因此是**会话级**累计，前端直显」。
- [ ] 1.5 跑测试 + tsc。

## Task 2（#5 列表分页，后端 TDD）

- [ ] 2.1 spec 失败测试：`list(tenantId, { cursor, limit })` 返回 `{ items, nextCursor }`；满页时 nextCursor=末项 id、不足一页 null；带 cursor 时 prisma 调用含 `cursor:{id}` `skip:1`。
- [ ] 2.2 实现 `list(tenantId, opts?: { cursor?: string; limit?: number })`：
  `orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]`，`take: limit+1` 探测下一页，超出则裁剪并给 nextCursor。
- [ ] 2.3 controller `@Get() list(@CurrentUser() user, @Query('cursor') cursor?, @Query('limit') limit?)`。
- [ ] 2.4 跑测试 + tsc。

## Task 3（#3 生成确认）

- [ ] 3.1 `canvas.agent.factory.ts` interruptOn 增加 `generate_media_node: { allowedDecisions: ['approve', 'reject'] }`；系统提示「触发生成」规则处补：generate_media_node 内建用户确认（同 clear_canvas），直接调用、禁止先 ask_user 询问是否生成。
- [ ] 3.2 前端 `chat.ts` `extractAsk`：`generate_media_node` → question 缺省文案「是否执行该节点的生成任务？」（带 args.nodeId 时附节点 id）。
- [ ] 3.3 `canvas-chat.tsx`：`const CONFIRM_TOOLS = new Set(['clear_canvas', 'generate_media_node'])`，确认分支改 `CONFIRM_TOOLS.has(ask.tool)`。

## Task 4（#4 切画布空白修复）

- [ ] 4.1 `canvas-shell.tsx`：`<FlowCanvas key={sessionId} …>`。
- [ ] 4.2 `flow-canvas.tsx` 加 `FitOnFirstLoad`（useReactFlow + 一次性 ref：首次 nodes 从空变非空 → `fitView({ padding: 0.2 })`；remount 自动重置）。
- [ ] 4.3 preview 实测：两块节点坐标差异大的画布来回切换，均不空白。

## Task 5（#1 节点编辑 + #2 复制）

- [ ] 5.1 `flow-canvas.tsx`：创建并导出 `CanvasEditorContext`（`{ readOnly, updateNode(nodeId, patch: {label?/text?/prompt?}) }`），Provider 包住 `<ReactFlow>`；`updateNode` → `onApplyOp({op:'update_node', nodeId, ...patch})`。
- [ ] 5.2 `canvas-nodes.tsx`：
  - text 节点正文双击 → Textarea（本地态、`nodrag`、autoFocus），blur/600ms 防抖提交 `text`；
  - image_gen/video_gen 的 prompt 段同样处理提交 `prompt`；
  - NodeShell header 标题双击 → Input 提交 `label`；
  - `readOnly` 时不进入编辑。仅内容变化才提交。
- [ ] 5.3 `flow-canvas.tsx` 外层 div `onKeyDown`：Cmd/Ctrl+D `preventDefault`，对 `nodes.filter(n=>n.selected)` 逐个 `onApplyOp({op:'add_node', type, label, text, prompt, x:+40, y:+40})`（生成态不复制）；readOnly 忽略。
- [ ] 5.4 lint + tsc。

## Task 6（#6/#5 前端接线）

- [ ] 6.1 `api.ts`：`CanvasSnapshot` 增 `totalTokens: number`；`listCanvases(cursor?)` → `Promise<{ items: CanvasListItem[]; nextCursor: string | null }>`。
- [ ] 6.2 `use-canvas.ts` 快照 sync 块：`setTokens(snapQ.data?.totalTokens ?? 0)`（顺带修切会话残留旧值）。
- [ ] 6.3 `canvas-sidebar.tsx`：`useInfiniteQuery({ queryKey:['canvas-list'], getNextPageParam })` + 列表底部哨兵 div（IntersectionObserver）自动 `fetchNextPage`；rename 乐观更新适配分页缓存结构（`pages[].items[]`）。
- [ ] 6.4 lint + tsc。

## Task 7（端到端验收，preview）

- [ ] 7.1 编辑：双击 text/prompt/标题改内容 → 自动保存 → 刷新页面仍在。
- [ ] 7.2 复制：选中节点 Cmd+D → 新节点出现（+40,+40）→ 刷新仍在。
- [ ] 7.3 生成确认：让 agent 建生图节点并触发生成 → 弹「确认/取消」→ reject 不执行；再来一次 approve 执行（无 key 时生成会失败也 OK，验证确认环节即可）。
- [ ] 7.4 切画布：来回切换不空白、数据正确。
- [ ] 7.5 列表：造出 >30 个会话（脚本插 DB）→ 滚动到底自动加载更多。
- [ ] 7.6 token：跑一轮后刷新页面 token 不归零；切画布显示各自数值；第二轮运行累计续增。

## 完成标准

后端 jest 全绿、双端 tsc 0 error、`pnpm lint` 0 error、7.1-7.6 全部实测通过；不 commit，带 Verification 汇报。
