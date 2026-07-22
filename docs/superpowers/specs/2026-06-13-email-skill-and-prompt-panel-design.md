# 邮件 skill 优化 + 通用交互面板 PromptPanel — 设计

日期：2026-06-13
分支：feat/skills-sandbox-media-gen

## 目标（用户已确认）

1. `send_email` 不再要求收件人：`to` 可选，缺省取 `DEFAULT_EMAIL_TO` env，兜底示例邮箱 `team@example.com`（用户指定用示例邮箱即可）。工具文案英文化。
2. `email-compose` SKILL.md 重写为英文：邮件用英文撰写、标准西式格式（greeting → body → sign-off）；不追问收件人；用户要求的内容点必须完整保留进正文。
3. 新增通用交互面板 `PromptPanel`：固定在输入框上方（TaskPlanPanel 同区域同样式语言），icon + 标题 + 内容 + 操作区，未来「向用户提问/收集输入」复用。
4. 审批交互重构为 `ApprovalPanel`（基于 PromptPanel）：从消息流移到输入框上方；review（参数 key-value 友好展示）/ edit（面板内逐字段表单，字符串字段 Textarea，非字符串回退 JSON）/ reply（面板内 Textarea）三视图，替代 `window.prompt`。

## 现状（已核实，行号见 Explore 报告并将在实现时复核）

- 工具：apps/backend/src/agent/tools/send-email.tool.ts（to 必填，中文描述，demo 固定返回 sent:true）。
- interruptOn：agent.factory.ts:251 `{ send_email: true }`——不动。
- SKILL.md：apps/backend/skills/email-compose/SKILL.md（中文，会追问收件人）。
- 前端：approval-card.tsx 渲染在 chat-thread.tsx:278-282 消息流内；edit/respond 走 use-conversation.ts:99-126 的 window.prompt；决策经 socket `control:response` 回传（events.gateway.ts:112），后端 resume 链路不动。
- TaskPlanPanel（task-plan-panel.tsx）：输入框上方面板的样式基准 `rounded-xl border bg-card shadow-sm`。

## 设计决策

- **decisions 组装下移到面板**：`ApprovalPanel` 自己管理三视图状态并组装完整 `decisions[]`，`onSubmit(decisions)` 上抛；use-conversation 的 `respondApproval` 简化为透传（去掉 window.prompt 与 Decision 分支）。socket 协议不变。
- **PromptPanel 是纯展示外壳**（icon/title/children/footer），不含业务状态——保证「以后询问用户问题」可复用。
- 后端零行为变更（除 send_email 默认收件人），不新增 ask_user 工具（YAGNI，用户说的是"以后"）。

## 验证

- 后端：node22 tsc + jest（新增 send-email.tool.spec：缺省 to → 默认地址）。
- 前端：tsc + lint。
- preview 实测：触发一封邮件（聊天 `/email-compose`），确认审批面板出现在输入框上方、参数可读、Approve/Edit/Reply 流程可走通、决策后面板消失且 agent 继续；邮件内容英文且完整。
