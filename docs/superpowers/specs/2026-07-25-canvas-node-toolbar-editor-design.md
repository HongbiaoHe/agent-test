# Canvas 节点浮窗编辑 + 保存 loading 设计

日期：2026-07-25
状态：已确认（用户批准）

## 目标

1. 节点编辑入口从「双击内联」改为「**选中节点 → 节点旁浮出编辑面板**」。
2. `update_node` 用户操作全程可见 loading：触发即开始，直到保存成功（或失败）。

## 现状

- 编辑目前是节点内双击进入 Textarea/Input（`canvas-nodes.tsx` 的 `EditableText`），600ms 防抖 + blur 提交 `update_node` op。
- `applyUserOp`（`use-canvas.ts`）是 fire-and-forget：await 后不回传状态，失败仅静默重拉快照 → 用户无从判断是否保存成功。
- `@xyflow/react` 12.11.2 内置 `NodeToolbar`（自动跟随节点位置/缩放的浮层容器）。

## 设计

### 1. NodeToolbar 浮窗编辑

- 节点内文本恢复纯展示（移除双击进入编辑）。
- 每个节点渲染 `<NodeToolbar isVisible={selected && !readOnly} position={Position.Top}>`，内容按类型：
  - 全类型：`label` 单行 Input。
  - text：`text` Textarea；image_gen/video_gen：`prompt` Textarea；image_upload：仅 label。
- 面板容器加 `nodrag nowheel`（输入时不拖动/缩放画布）。
- 保存时机不变：输入 600ms 防抖 + blur 立即收口，仅字段变化才发 op。
- 多选时各节点各自浮出面板（NodeToolbar 默认行为）。
- `readOnly`（agent 运行期）不渲染浮窗。

### 2. update_node loading

- `use-canvas.ts` 新增 `savingNodes: Record<string, number>`（nodeId → 在途计数）与 `saveStates: Record<string, 'saving'|'saved'|'error'>`；`applyUserOp` 对 `update_node`：
  - 发起：计数 +1，状态 `saving`；
  - 成功：计数 -1，归零时置 `saved`（1.5s 后清除）；
  - 失败：计数 -1，置 `error`（重拉快照后 3s 清除）。
- **起点提前到键入那刻（2026-07-25 用户反馈修正）**：保存有 600ms 防抖，若等请求发出才亮
  loading，前 600ms 用户没有任何反馈。故 context 增加 `markSaving(nodeId)`——编辑器 `onChange`
  即调用点亮 `saving`；内容改回原值、最终无 op 可发时用 `cancelSaving(nodeId)` 撤销。
- **连续编辑不再假失败（实测发现）**：`applyUserOp` 原用闭包里的 `canvas.revision` 作 CAS 基线，
  连续编辑（改完标题接着改正文）时 React 未重渲染、socket patch 也可能未到 → 第二个 op 携带
  过期 revision 必然 409，表现为「保存失败」。修复：用 `revisionRef` 跟踪最新 revision
  （来源 = 本地 canvas 同步 + `applyOp` 响应返回的新 revision），并把用户 op 串行化（`opChain`）。
- 状态经 `CanvasEditorContext` 下发（新增 `saveStates`）。
- **展示位置（2026-07-25 用户反馈修正）**：统一在**画布左上角一处**（`flow-canvas.tsx` 的
  `SaveStatusBadge`，聚合全部节点状态：任一 saving → 保存中；否则 error → 失败；否则 saved → 已保存），
  **不在每个节点上、也不在浮窗内**显示。
  `saving` → `Loader2` 旋转 +「保存中…」；`saved` → `Check` +「已保存」；`error` → `AlertCircle` +「保存失败，已重新加载」。

### 2.1 保存成功后浮窗消失（实测发现的 bug 及修复）

`update_node` 成功后服务端回广播 `canvas_patch`，`FlowCanvas` 用 `toRfNodes(canvas)` 整表重建
RF 节点，新节点对象不带 `selected` → 选中态丢失 → 依赖 `selected` 的 NodeToolbar 在保存成功那刻
突然消失。修复：canvas → RF 同步时保留上一份的 `selected` 集合再合并。

### 3. 并发与错误

- 同节点连续编辑（防抖多次触发）以计数聚合，避免先返回的响应提前清掉 loading。
- 409 冲突：沿用现有重拉快照，并展示 `error` 态，不再"静默假成功"。

### 4. 测试

- 前端 `tsc` + `lint` 0 error。
- preview 实测：选中出浮窗 → 改 label/text/prompt → 看到「保存中 → 已保存」→ 刷新内容仍在；运行期无浮窗；双击不再进编辑。

## 明确不做（YAGNI）

- 不做浮窗内的节点删除/复制按钮（复制已有 Cmd+D）。
- 不做拖拽移动浮窗、不做位置记忆。
- 不做保存失败的手动重试按钮（下次编辑即重试）。
