# Canvas 六项改进设计

日期：2026-07-25
状态：用户委托直接执行（"全部执行完测试完找我 review"）

## 范围

| # | 项 | 类型 |
| --- | --- | --- |
| 1 | 节点选中/双击编辑内容，前端自动保存 | 功能 |
| 2 | 快捷复制节点（Cmd/Ctrl+D） | 功能 |
| 3 | 生成动作需用户确认（不自动执行） | 功能 |
| 4 | 切换画布有时空白 | bug |
| 5 | 会话列表滚动加载更多 | 功能/缺失 |
| 6 | 会话 token 持久化 | bug/缺失 |

## 现状关键事实（探索结论）

- 结构编辑基建齐全：REST `POST /canvas/:id/ops` + `canvasOpSchema` 已支持 `update_node`（label/text/prompt）与 `add_node`，带 revision CAS（`use-canvas.ts` 的 `applyUserOp`）。节点 UI（`canvas-nodes.tsx`）目前纯展示。
- 确认交互基建齐全：`interruptOn` + `chat.ask.tool` 分流（`clear_canvas` 已是 approve/reject 确认形态，`canvas-chat.tsx:297`）。
- 画布外壳跨路由持久（`canvas-wrapper.tsx`），react-flow 实例切会话**不重挂载**：`fitView` 只在首次 mount 生效 → 切到坐标差异大的画布时视口停在旧位置，**表现为空白画布**（bug 4 根因假设，待实测确认）。
- 会话列表 `GET /canvas` 无分页（`canvas.service.ts:90` findMany 全量）。
- token：后端已按 run 持久化（`CanvasRun` 累计列 + `CanvasTokenUsage` 明细），但 socket 事件的 `cumulativeTotal` 是 **run 级**从 0 起算（`canvas.processor.ts:139`）；快照不含 token；前端 `tokens` 纯内存 → 刷新丢失、切画布残留旧值、第二轮运行归零。

## 设计

### 1. 节点编辑自动保存

- `flow-canvas.tsx` 提供 `CanvasEditorContext = { readOnly, updateNode(nodeId, patch) }`（react-flow 自定义节点只拿 data，回调经 context 注入）。
- `canvas-nodes.tsx`：text 节点编辑 `text`，image_gen/video_gen 节点编辑 `prompt`，所有节点 header 双击改 `label`。双击进入编辑（Textarea/Input，编辑期本地态，`nodrag` 类阻止拖拽），blur 或 600ms 防抖自动提交 `update_node` op（仅字段变化时）。
- 运行期 `readOnly` 禁入编辑。CAS 409 由现有 `applyUserOp` 重拉快照兜底。
- patch 回声（update_node 广播）重建 RF 节点：编辑期以本地态为准（uncontrolled），提交后回声内容一致，无闪烁。

### 2. 快捷复制节点

- `flow-canvas.tsx` 包一层 onKeyDown：`Cmd/Ctrl+D`（阻止浏览器默认收藏）复制**当前选中**节点（支持多选逐个），`applyUserOp({op:'add_node', type/label/text/prompt, x:+40, y:+40})`。
- 生成态（mediaGenerationId/媒资）不复制——新节点是干净副本。readOnly 期禁用。

### 3. 生成动作用户确认

- `canvas.agent.factory.ts` `interruptOn` 增加 `generate_media_node: { allowedDecisions: ['approve','reject'] }`。
- 系统提示补一句：generate_media_node 内建用户确认，直接调用即可，禁止先用 ask_user 问"要不要生成"。
- 前端 `chat.ts` `extractAsk`：generate_media_node 生成友好文案（"是否执行该节点的生成任务？"）；`canvas-chat.tsx` 确认分支从 `tool === 'clear_canvas'` 扩为 `CONFIRM_TOOLS` 集合（clear_canvas、generate_media_node）。

### 4. 切换画布空白 bug

- 修复：`canvas-shell.tsx` 给 `<FlowCanvas key={sessionId}>` ——切会话重挂载 RF 实例（视口/选中态归零）。
- 快照异步到达时 mount 时点节点为空、`fitView` prop 落空 → FlowCanvas 内加一次性 `FitOnFirstLoad`（首次 nodes 非空时 fitView；remount 重置一次性标记）。
- 数据刷新本身已正确（queryKey 含 sessionId + staleTime 0）；实测复现/验证视口假设。

### 5. 会话列表滚动加载

- 后端 `GET /canvas?cursor=<id>&limit=30`：`orderBy [updatedAt desc, id desc]` + Prisma cursor(id)+skip 1；返回 `{ items, nextCursor }`（不足一页 nextCursor=null）。
- 前端 `canvas-sidebar.tsx` 改 `useInfiniteQuery` + 列表底部 IntersectionObserver 哨兵自动加载；重命名乐观更新改为按页结构更新。

### 6. 会话 token 持久化

- 后端 run 起跑时 `cumulativeTotal` 改为从会话历史总量起算：`aggregate CanvasRun.totalTokens where sessionId` → socket 事件变为**会话级**累计。
- 快照（`buildSnapshot`）增加 `totalTokens`（同一聚合）；`CanvasSnapshot` 类型与前端 DTO 同步。
- 前端 `use-canvas.ts`：快照落地时 `setTokens(snap.totalTokens)`（同时修掉切会话残留旧值的问题）；live 事件继续覆盖。

## 错误处理

- 编辑提交 409（revision 冲突）→ 现有重拉快照路径。
- 复制/编辑仅空闲期可用（readOnly 期 UI 禁用，与现有交互一致）。
- 生成确认被 reject → 现有通用 reject message 已约束模型不得绕道（`use-canvas.ts:177`）。

## 测试

- 后端：canvas.service list 分页单测；processor cumulativeTotal 起算单测（如现有 spec 结构允许）；`tsc` + 全量 jest。
- 前端：`pnpm lint` + `tsc`；preview 实测六项各自验收（编辑保存后刷新仍在；Cmd+D 复制；生成前弹确认、approve 执行/reject 不执行；切画布不空白；列表滚动加载；token 刷新/切换/二轮运行不丢不混）。

## 明确不做（YAGNI）

- 不做节点右键菜单、剪贴板 Cmd+C/V 序列化、跨画布粘贴。
- 不做编辑历史/撤销。
- 不做 token 图表/按模型细分展示（数据在 CanvasTokenUsage，UI 只显总量）。
