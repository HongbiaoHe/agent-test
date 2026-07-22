# 邮件 skill 优化 + PromptPanel 实施计划

> **For agentic workers:** 按 CLAUDE.md 约束执行：禁止 git commit/push；完成声明必须带 `## Verification`；后端测试前先切 node 22。
> Spec：docs/superpowers/specs/2026-06-13-email-skill-and-prompt-panel-design.md

**Goal:** send_email 默认收件人 + 英文邮件 skill + 输入框上方通用交互面板（审批三视图）。

## Task 1: send_email 默认收件人（后端，TDD）

- Test: 新建 `apps/backend/src/agent/tools/send-email.tool.spec.ts`
  - 不传 `to` → `JSON.parse(result).to === 'team@example.com'`（无 env 时）
  - `DEFAULT_EMAIL_TO=x@y.z` → to 为 env 值
  - 显式传 to → 用显式值
- [ ] 先写测试跑红 → 改 `send-email.tool.ts`：`to: z.string().optional()`，实现里 `to ?? process.env.DEFAULT_EMAIL_TO ?? 'team@example.com'`；description/参数描述英文化 → 跑绿
- [ ] `npx tsc --noEmit && npx jest`（node 22）全绿

## Task 2: email-compose SKILL.md 英文重写

- [ ] 重写 `apps/backend/skills/email-compose/SKILL.md`：英文 frontmatter description + 正文指令：
  - Write the email in English, standard format: greeting (`Hi <name>,` / `Hello team,`), short opening line, body (paragraphs or bullets), closing (`Best regards,` + sender name)
  - Do NOT ask for the recipient; omit `to` (system default) unless the user gave an address
  - Include EVERY point the user asked for, in full — no trimming or summarizing away content
  - Call send_email directly (system intercepts for approval); afterwards summarize in one sentence

## Task 3: PromptPanel 通用外壳（前端）

- Create: `apps/frontend/src/app/agent/_components/prompt-panel.tsx`
- props：`{ icon: LucideIcon; title: string; children; footer?: ReactNode }`
- 样式同 TaskPlanPanel：`mb-2 overflow-hidden rounded-xl border bg-card shadow-sm`；头部 icon+title（紧凑 px-3 py-2），内容区 `max-h-*` 内滚，footer 操作区

## Task 4: ApprovalPanel 三视图 + 移位（前端）

- Modify: `approval-card.tsx` → 重构为 `ApprovalPanel`（文件改名 approval-panel.tsx，更新引用）
  - review：args 按 key-value 展示（`whitespace-pre-wrap`），按钮 Approve/Reject/Edit/Reply（按 allowedDecisions，Reply 恒有，沿用现状）
  - edit：逐 actionRequest 逐字段表单：string → Textarea；非 string → JSON Textarea；Save & approve → `{type:'edit', editedAction:{name, args}}`；Cancel 回 review
  - reply：Textarea + Send reply → `{type:'respond', message}` per request；Cancel 回 review
  - props：`{ approval, onSubmit(decisions: unknown[]) }`
- Modify: `use-conversation.ts:99-126`：respondApproval 改为 `(decisions: unknown[]) => respondControl + 乐观清理`（删 window.prompt 逻辑与不再用的 Decision import）
- Modify: `chat-thread.tsx`：删消息流内 `{approval && <ApprovalCard/>}`（:278-282），在输入区 `{plan && <TaskPlanPanel/>}` 之后渲染 `{approval && <ApprovalPanel/>}`；props 签名同步（onDecide → onSubmit），上游调用点（conversation page / use-conversation 接线处）同步
- thread.ts 的 `Decision` 类型若仍被引用则保留，孤儿则随改动清理

## Task 5: 验证

- [ ] 后端 tsc+jest、前端 tsc+lint（node 22）
- [ ] preview：发 `/email-compose 邀请团队周五 demo，提到三点：时间、地点、需要准备 laptop`，验证：审批面板在输入框上方、参数可读、Edit 表单可改 subject/body、Approve 后面板消失 agent 继续、邮件英文且三点齐全
- [ ] 汇报带 `## Verification`
