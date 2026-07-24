# ask_user 提问工具设计

日期：2026-07-24
状态：已确认（用户批准）

## 目标

给 `/agent` 增加一个 human-in-the-loop 提问工具 `ask_user`：agent 缺关键信息时向用户提问，支持单选/多选、自定义答案、建议答案预选；前端 60s 倒计时，无人操作则自动采用建议答案；交互形态与现有 send_email 审批面板一致。

## 已确认的需求决策

| 决策点 | 结论 |
| --- | --- |
| 一次调用问几个问题 | 一批 1–4 个（questions 数组） |
| 倒计时到点行为 | 用户任意操作即取消倒计时，转纯手动提交；无操作到点自动提交建议答案 |
| 服务端兜底超时 | 10 分钟（`ASK_USER_TIMEOUT_MS`，env 可配）；页面关闭场景由它兜底 |
| 自定义答案形态 | 每题带「其他」项：单选与选项互斥，多选可叠加补充 |
| 决策类型 | 仅 `approve`（采纳建议）与 `edit`（用户答案）；不提供 reject |

> **实现期修正（2026-07-24）**：设计原用 `respond` 决策承载用户答案，但本项目 langchain 1.4.2 的
> HITL 运行时只支持 approve/edit/reject（`node_modules/langchain/dist/agents/middleware/hitl.js:267-303`，
> 未知决策类型抛错）；`respond` 是官方新版文档的能力。改用 **`edit`**：前端把用户答案写进
> `args.answers`（schema 内部字段，模型被禁止自填），tool 检测到 answers 即原样返回（auto:false），
> 无 answers 则返回建议答案（auto:true）。对外语义不变。

## 架构

与 send_email 审批完全同构，复用整条 HITL 链路：

```
模型调 ask_user
  → deepagents interruptOn 中断（HITL 中间件，官方 §12）
  → worker：status=waiting_approval + 发 control_request 事件 + 排 BullMQ 超时 job（10min，job data 带 toolName）
  → 前端 QuestionPanel（60s 倒计时）
  → resume 端点（现有 CAS：waiting_approval→running 先到先得）
  → Command({ resume: { decisions } }) 续跑
```

决策语义：
- **approve = 采纳建议答案**。tool 按原参数执行，返回 `{ answers: [{ header, question, selected: suggested, auto: true }] }`。前端倒计时到点与服务端兜底超时都发 approve。
- **edit = 用户答案**。前端组装 `{ type: 'edit', editedAction: { name: 'ask_user', args: { questions: 原样, answers: 用户答案 } } }`，HITL 中间件用改后参数执行 tool，tool 返回 answers 并标记 auto:false。

## 组件与改动面

### 后端

1. **`apps/backend/src/agent/tools/ask-user.tool.ts`**（新增）

```ts
schema: z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    multiSelect: z.boolean().default(false),
    options: z.array(z.object({
      label: z.string(),
      description: z.string().optional(),
    })).min(2).max(4),
    suggested: z.array(z.string()).min(1),
  })).min(1).max(4),
}).superRefine(/* suggested ⊆ options labels；单选题 suggested 恰 1 个 */)
```

description 引导模型：缺关键信息才问、必须给 suggested、用户可能自定义回答。

2. **`apps/backend/src/agent/agent.factory.ts`**：`interruptOn` 增加 `ask_user: { allowedDecisions: ['approve', 'respond'] }`；tools 注册 askUserTool。

3. **`apps/backend/src/worker/agent.processor.ts`**：
   - 中断检测处排 timeout job 时，job data 带上 `toolName`（从 interrupt value 的 actionRequests 取），延时按名分叉：`ask_user` → `ASK_USER_TIMEOUT_MS`（默认 600000），其余维持 `APPROVAL_TIMEOUT_MS`（120000）。
   - 超时处理按 toolName 分叉：`ask_user` → 发 `[{type:'approve'}]` decisions + 流内提示「⏱ 等待回答超时，已自动采用建议答案」；`send_email` 保持 auto-reject 现状。

### 前端

4. **`apps/frontend/src/app/agent/_components/question-panel.tsx`**（新增）
   - 分流条件：`actionRequests.length === 1 && actionRequests[0].name === 'ask_user'` → QuestionPanel；否则回退现有 ApprovalPanel。
   - 基于 PromptPanel 外壳（与邮件审批同观感）；shadcn `RadioGroup` / `Checkbox` + 每题「其他」项文本输入。
   - 建议答案默认预选 + 「建议」徽标。
   - 倒计时 60s：剩余秒数 + 细进度条；任意交互即取消；到点无交互自动提交 approve。页面刷新倒计时重走 60s（control_request 已持久化，历史重放恢复面板）。
   - 提交：`[{ type: 'respond', message: 每题「header：选中项 / 自定义」结构化文本 }]`（一次调用 = 1 个 actionRequest，decisions 对齐规则天然满足）。

## 错误处理

- suggested 不在 options → zod superRefine 报参数错误，模型自动重试。
- 前端 60s / 服务端 10min / 用户手动三方竞态 → 现有 resume CAS 幂等（后到者拿不到 waiting_approval，静默丢弃）。
- SSE 断线/刷新 → control_request 已持久化为 message，历史重放恢复面板（现有机制）。

## 测试

- `ask-user.tool.spec.ts`：schema 校验（suggested ⊆ options、单选恰 1、题数上限）+ approve 执行返回建议答案 JSON。
- `agent.processor.spec.ts` 扩展：timeout 按 toolName 分叉（ask_user → approve、send_email → reject）。
- 前端 `pnpm lint` + preview 实测两条路径：倒计时自动采纳 / 手动改选提交。

## 明确不做（YAGNI）

- 不支持模型自定义倒计时时长（固定 60s，兜底 env 可配）。
- 不支持 edit/reject 决策。
- 不做倒计时跨刷新持续（刷新重走 60s）。
- 不处理一次模型输出中 ask_user 与其他工具混排的复合面板（回退现有 ApprovalPanel）。
