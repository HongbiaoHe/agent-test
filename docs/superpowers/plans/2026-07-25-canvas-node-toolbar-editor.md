# Canvas 节点浮窗编辑 + 保存 loading 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 节点编辑入口改为「选中节点 → 节点上方 NodeToolbar 浮窗」，并让 `update_node` 从触发到保存成功全程有 loading 反馈。

**Architecture:** 用 react-flow 内置 `NodeToolbar`（自动跟随节点位置/缩放）承载编辑表单；`use-canvas` 把 `applyUserOp` 从 fire-and-forget 改为按 nodeId 记账的可观测状态（saving/saved/error），经既有 `CanvasEditorContext` 下发给节点与浮窗渲染。

**Tech Stack:** Next.js 16 + @xyflow/react 12.11.2（NodeToolbar）+ React Query + shadcn/ui。

**约束（覆盖模板默认）：** CLAUDE.md 禁自动 commit——Commit 步骤替换为「标记完成，用户 review 后统一提交」。前端改动无 jest 覆盖，验收靠 `tsc`/`lint` + preview 实测。

**设计文档：** docs/superpowers/specs/2026-07-25-canvas-node-toolbar-editor-design.md

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/frontend/src/app/canvas/_hooks/use-canvas.ts` | 修改 | `applyUserOp` 记账 → 暴露 `saveStates: Record<string, SaveState>` |
| `apps/frontend/src/app/canvas/_components/flow-canvas.tsx` | 修改 | `CanvasEditorContext` 增加 `saveState(nodeId)`；透传 saveStates |
| `apps/frontend/src/app/canvas/_components/node-editor-toolbar.tsx` | 新增 | 浮窗编辑面板（NodeToolbar + 字段表单 + 保存状态区） |
| `apps/frontend/src/app/canvas/_components/canvas-nodes.tsx` | 修改 | 移除内联 EditableText，改纯展示 + 挂 NodeEditorToolbar + 节点角标转圈 |
| `apps/frontend/src/app/canvas/_components/canvas-shell.tsx` | 修改 | 把 `saveStates` 传给 FlowCanvas |

---

### Task 1: use-canvas 暴露保存状态

**Files:** Modify `apps/frontend/src/app/canvas/_hooks/use-canvas.ts`

- [ ] **Step 1.1** 顶部加类型与状态：

```ts
/** update_node 保存状态（按 nodeId）：saving 在途 / saved 刚成功 / error 失败已重拉 */
export type SaveState = "saving" | "saved" | "error";
```

hook 内：

```ts
  // update_node 保存状态（按 nodeId）：in-flight 计数聚合连续编辑，避免先返回的响应提前清 loading
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const inflight = useRef<Record<string, number>>({});
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
```

- [ ] **Step 1.2** 改写 `applyUserOp`（只有 `update_node` 记账；其他 op 行为不变）：

```ts
  /** 用户结构编辑（空闲期）：带当前 revision 做乐观并发，409 重拉快照。
      update_node 额外按 nodeId 记账保存状态，供节点/浮窗显示 loading。 */
  async function applyUserOp(op: CanvasOpInput) {
    if (!sessionId) return;
    const nodeId = op.op === "update_node" ? op.nodeId : null;
    if (nodeId) {
      inflight.current[nodeId] = (inflight.current[nodeId] ?? 0) + 1;
      const t = clearTimers.current[nodeId];
      if (t) {
        clearTimeout(t);
        delete clearTimers.current[nodeId];
      }
      setSaveStates((prev) => ({ ...prev, [nodeId]: "saving" }));
    }
    try {
      await applyCanvasOp(sessionId, op, canvas.revision);
      if (nodeId) settleSave(nodeId, "saved", 1500);
    } catch {
      void refetchSnap();
      if (nodeId) settleSave(nodeId, "error", 3000);
    }
  }

  /** 结账：计数归零才落终态，并在 delay 后自动清除该 nodeId 的状态 */
  function settleSave(nodeId: string, state: SaveState, delay: number) {
    inflight.current[nodeId] = Math.max((inflight.current[nodeId] ?? 1) - 1, 0);
    if (inflight.current[nodeId] > 0) return; // 还有后续编辑在途，保持 saving
    setSaveStates((prev) => ({ ...prev, [nodeId]: state }));
    clearTimers.current[nodeId] = setTimeout(() => {
      delete clearTimers.current[nodeId];
      setSaveStates((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }, delay);
  }
```

- [ ] **Step 1.3** 卸载清理计时器：

```ts
  useEffect(
    () => () => {
      for (const t of Object.values(clearTimers.current)) clearTimeout(t);
    },
    [],
  );
```

- [ ] **Step 1.4** return 增加 `saveStates`。
- [ ] **Step 1.5** `pnpm --filter frontend exec tsc --noEmit` 0 error。

---

### Task 2: context 扩展与透传

**Files:** Modify `flow-canvas.tsx`、`canvas-shell.tsx`

- [ ] **Step 2.1** `flow-canvas.tsx`：`CanvasEditorContext` 值增加 `saveStates: Record<string, SaveState>`；`FlowCanvas` props 增加 `saveStates`，并进 `editor` useMemo 依赖。
- [ ] **Step 2.2** `canvas-shell.tsx`：`<FlowCanvas … saveStates={c.saveStates} />`。
- [ ] **Step 2.3** tsc 0 error。

---

### Task 3: NodeEditorToolbar 浮窗

**Files:** Create `apps/frontend/src/app/canvas/_components/node-editor-toolbar.tsx`

- [ ] **Step 3.1** 实现组件（要点，完整代码按此约束展开）：
  - props：`{ nodeId, label, fallbackLabel, body?: { field: 'text' | 'prompt'; value: string; placeholder: string } }`。
  - `<NodeToolbar isVisible={selected && !readOnly} position={Position.Top} offset={12}>`，外层 `nodrag nowheel` + `w-72 rounded-lg border bg-popover p-2.5 shadow-lg`（语义 token）。
  - 内含：label Input（Enter/Escape 收口）、可选正文 Textarea；均 600ms 防抖 + blur 提交 `updateNode(nodeId, { [field]: v })`，值未变不提交。
  - 右上角状态区：`saving` → `Loader2 animate-spin` +「保存中…」；`saved` → `Check`（`text-success`）+「已保存」；`error` → `AlertCircle`（`text-destructive`）+「保存失败，已重新加载」。
  - `selected` 由调用方（节点组件的 `NodeProps.selected`）传入。
- [ ] **Step 3.2** lint + tsc。

---

### Task 4: 节点改纯展示 + 挂浮窗 + 角标

**Files:** Modify `canvas-nodes.tsx`

- [ ] **Step 4.1** 删除 `EditableText`（及其 `useRef`/`useState` 相关 import 若不再使用）。
- [ ] **Step 4.2** `NodeShell` 改回纯展示标题（`<span className="truncate">{label || fallbackTitle}</span>`），并在 header 右侧渲染保存角标：`saveStates[nodeId] === 'saving'` 时 `Loader2 animate-spin size-3`。
- [ ] **Step 4.3** 四个节点组件从 `NodeProps` 取 `selected`，在返回值里挂 `<NodeEditorToolbar nodeId=… selected={selected} … />`：
  - TextNode：body = `{ field: 'text', value, placeholder: '节点正文…' }`
  - ImageGenNode/VideoGenNode：body = `{ field: 'prompt', … }`
  - ImageUploadNode：无 body（仅 label）
- [ ] **Step 4.4** 正文展示区去掉「双击编辑」提示文案，占位改「（空）」「（未填提示词）」。
- [ ] **Step 4.5** `pnpm lint` + tsc 0 error。

---

### Task 5: preview 实测验收

- [ ] **Step 5.1** 打开 canvas 会话（E2E-编辑测试A），点选 text 节点 → 浮窗出现在节点上方。
- [ ] **Step 5.2** 改 label 与正文 → 观察「保存中…」→「已保存」；DB 实查字段已更新。
- [ ] **Step 5.3** 刷新页面 → 修改仍在；双击节点不再进入编辑态。
- [ ] **Step 5.4** 选中 image_gen 节点 → 浮窗编辑 prompt → 同样看到状态流转。
- [ ] **Step 5.5** 取消选中（点空白）→ 浮窗消失。
- [ ] **Step 5.6** 运行期（发一条消息让 agent 跑）→ 选中节点无浮窗（readOnly）。

## 完成标准

前端 `tsc` 0 error、`pnpm lint` 0 error、5.1–5.6 实测通过；不 commit，带 Verification 汇报。
