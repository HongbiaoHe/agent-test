# ask_user 提问工具实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 /agent 增加 human-in-the-loop 提问工具 `ask_user`：批量 1-4 题、单选/多选、每题「其他」自定义、建议答案预选、前端 60s 倒计时自动采纳建议、服务端 10 分钟兜底。

**Architecture:** 与 send_email 审批同构，复用 deepagents `interruptOn` HITL 链路（interrupt → control_request → BullMQ 超时 job → resume Command）。`approve` = tool 执行返回建议答案（auto:true）；`respond` = 用户答案直接当工具结果。

**Tech Stack:** deepagents@1.10.2 HITL、NestJS + BullMQ、Next.js 16 + shadcn/ui（RadioGroup/Checkbox 需新增）。

**约束（覆盖模板默认）：** 项目 CLAUDE.md 禁止自动 commit——所有 Commit 步骤替换为「标记完成，留待用户 review 后统一提交」。跑测试前必须 `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH`（默认 shell 是 node 14，jest 会假绿）。

**设计文档：** docs/superpowers/specs/2026-07-24-ask-user-tool-design.md

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/backend/src/agent/tools/ask-user.tool.ts` | 新增 | tool 定义 + schema 校验 + approve 路径返回建议答案 |
| `apps/backend/src/agent/tools/ask-user.tool.spec.ts` | 新增 | schema 校验与 approve 执行的单测 |
| `apps/backend/src/agent/agent.factory.ts` | 修改 | 注册 tool + interruptOn 配置 |
| `apps/backend/src/worker/agent.processor.ts` | 修改 | 超时 job 带 toolName、时长/行为按工具分叉 |
| `apps/backend/src/worker/agent.processor.spec.ts` | 修改 | 超时分叉单测 |
| `apps/frontend/src/components/ui/radio-group.tsx` `checkbox.tsx` | 新增 | shadcn 原语（CLI 添加） |
| `apps/frontend/src/app/agent/_components/question-panel.tsx` | 新增 | 提问面板：选项渲染 + 倒计时 + decisions 组装 |
| `apps/frontend/src/app/agent/_components/chat-thread.tsx` | 修改 | control_request 按工具名分流面板 |

---

### Task 1: ask_user tool（后端，TDD）

**Files:**
- Create: `apps/backend/src/agent/tools/ask-user.tool.ts`
- Test: `apps/backend/src/agent/tools/ask-user.tool.spec.ts`

- [ ] **Step 1.0: 确认 zod 版本**（superRefine addIssue 的 API v3/v4 有差异）

Run: `grep '"zod"' apps/backend/package.json`，按实际版本写 addIssue。

- [ ] **Step 1.1: 写失败测试**

```ts
// apps/backend/src/agent/tools/ask-user.tool.spec.ts
import { askUserTool } from './ask-user.tool';

const q = (over: Partial<Record<string, unknown>> = {}) => ({
  question: '用哪个数据库？',
  header: '数据库',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'MySQL' }],
  suggested: ['Postgres'],
  ...over,
});

describe('askUserTool', () => {
  it('approve 路径：执行返回全部建议答案且标记 auto', async () => {
    const raw = await askUserTool.invoke({ questions: [q()] });
    const parsed = JSON.parse(raw);
    expect(parsed.answers).toEqual([
      { header: '数据库', question: '用哪个数据库？', selected: ['Postgres'], auto: true },
    ]);
  });

  it('suggested 不在 options 中 → 校验失败', async () => {
    await expect(
      askUserTool.invoke({ questions: [q({ suggested: ['SQLite'] })] }),
    ).rejects.toThrow();
  });

  it('单选题 suggested 多于 1 个 → 校验失败', async () => {
    await expect(
      askUserTool.invoke({ questions: [q({ suggested: ['Postgres', 'MySQL'] })] }),
    ).rejects.toThrow();
  });

  it('多选题 suggested 可以多个', async () => {
    const raw = await askUserTool.invoke({
      questions: [q({ multiSelect: true, suggested: ['Postgres', 'MySQL'] })],
    });
    expect(JSON.parse(raw).answers[0].selected).toEqual(['Postgres', 'MySQL']);
  });

  it('超过 4 题 → 校验失败', async () => {
    await expect(
      askUserTool.invoke({ questions: [q(), q(), q(), q(), q()] }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 1.2: 跑测试确认失败**（模块不存在）

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm --filter backend test -- ask-user.tool`
Expected: FAIL（Cannot find module './ask-user.tool'）

- [ ] **Step 1.3: 实现 tool**

```ts
// apps/backend/src/agent/tools/ask-user.tool.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 向用户提问的 HITL 工具（配合 interruptOn，见 agent.factory）。
 *
 * 决策语义（设计 docs/superpowers/specs/2026-07-24-ask-user-tool-design.md）：
 * - respond：用户在前端面板的选择/自定义答案直接作为工具结果，本函数不执行。
 * - approve：采纳建议答案——本函数执行，返回 suggested 并标记 auto:true。
 *   前端 60s 倒计时到点与服务端 10 分钟兜底超时都走 approve。
 */
const questionSchema = z.object({
  question: z.string().describe('The complete question to ask the user.'),
  header: z.string().describe('Short label (2-6 chars) shown as the question group title.'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Allow selecting multiple options.'),
  options: z
    .array(
      z.object({
        label: z.string().describe('Display text of the choice.'),
        description: z.string().optional().describe('What this choice implies.'),
      }),
    )
    .min(2)
    .max(4),
  suggested: z
    .array(z.string())
    .min(1)
    .describe(
      'Recommended answer(s); must be option labels. Exactly 1 for single-select. Auto-adopted if the user does not respond in time.',
    ),
});

const askUserSchema = z
  .object({ questions: z.array(questionSchema).min(1).max(4) })
  .superRefine((val, ctx) => {
    val.questions.forEach((question, i) => {
      const labels = new Set(question.options.map((o) => o.label));
      for (const s of question.suggested) {
        if (!labels.has(s)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom, // zod v4 则为 code: 'custom'
            path: ['questions', i, 'suggested'],
            message: `suggested "${s}" 必须是 options 里的 label`,
          });
        }
      }
      if (!question.multiSelect && question.suggested.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['questions', i, 'suggested'],
          message: '单选题 suggested 必须恰好 1 个',
        });
      }
    });
  });

export const askUserTool = tool(
  ({ questions }: z.infer<typeof askUserSchema>) =>
    JSON.stringify({
      answers: questions.map((question) => ({
        header: question.header,
        question: question.question,
        selected: question.suggested,
        auto: true,
      })),
    }),
  {
    name: 'ask_user',
    description:
      'Ask the user 1-4 clarifying questions when a key decision cannot be made from available context. ' +
      'Each question provides 2-4 options and a suggested answer (must be option labels). ' +
      'The user may pick options, or reply with a custom answer instead. ' +
      'If the user does not respond in time, the suggested answers are adopted automatically. ' +
      'Do not use for questions you can answer yourself from the conversation or workspace.',
    schema: askUserSchema,
  },
);
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm --filter backend test -- ask-user.tool`
Expected: 5 passed

- [ ] **Step 1.5: lint**

Run: `pnpm lint`（或项目单文件 hook）→ 0 error

---

### Task 2: factory 接线

**Files:**
- Modify: `apps/backend/src/agent/agent.factory.ts:207-217`

- [ ] **Step 2.1: 注册 tool 与 interruptOn**

import 增加 `import { askUserTool } from './tools/ask-user.tool';`；

```ts
    tools: [
      getWeatherTool,
      sendEmailTool,
      askUserTool,
      ...((opts.extraTools ?? []) as never[]),
    ],
    // ...
    interruptOn: {
      send_email: true,
      // ask_user 只允许两种决策：approve=采纳建议答案（tool 执行）；respond=用户答案直接当结果。
      // 不提供 edit/reject——对「提问」语义无意义（设计 §已确认的需求决策）。
      ask_user: { allowedDecisions: ['approve', 'respond'] },
    },
```

- [ ] **Step 2.2: tsc + 既有测试回归**

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm --filter backend exec tsc --noEmit && pnpm --filter backend test`
Expected: 0 error / 全部 pass

---

### Task 3: worker 超时分叉（TDD）

**Files:**
- Modify: `apps/backend/src/worker/agent.processor.ts`（JobData、TIMEOUT 常量、queue.add 处 ~L254、handleTimeout ~L483）
- Test: `apps/backend/src/worker/agent.processor.spec.ts`

- [ ] **Step 3.1: 读现有 agent.processor.spec.ts 的 mock 模式**（cast-at-injection，见 CLAUDE.md §8）

- [ ] **Step 3.2: 写失败测试**——超时行为按 toolName 分叉

```ts
// 追加到 agent.processor.spec.ts（沿用现有 mock 结构组装 processor）
describe('handleTimeout 按 toolName 分叉', () => {
  it('ask_user 超时 → 自动 approve（采纳建议答案）', async () => {
    // arrange：conversation.status = waiting_approval（prisma mock CAS 返回 count 1）
    // act：process({ data: { conversationId, kind: 'timeout', toolName: 'ask_user' } })
    // assert：queue.add 被调用为 ('resume', { decisions: [{ type: 'approve' }] , ...})
    //        stream.publish 文案含「已自动采用建议答案」
  });

  it('send_email 超时 → 保持 auto-reject', async () => {
    // assert：decisions [{ type: 'reject' }]、文案含「已自动拒绝」
  });
});
```

（具体 mock 写法照抄现有 spec 的组装方式，禁 any，cast-at-injection。）

- [ ] **Step 3.3: 跑测试确认失败**

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm --filter backend test -- agent.processor`
Expected: 新增用例 FAIL

- [ ] **Step 3.4: 实现**

```ts
// JobData 增加：
interface JobData {
  conversationId: string;
  goal?: string;
  kind?: 'run' | 'resume' | 'timeout';
  decisions?: unknown[];
  /** timeout job 专用：中断的工具名，超时行为按此分叉（ask_user 自动采纳建议 vs 默认拒绝） */
  toolName?: string;
}

// 常量：
const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000);
/** ask_user 的服务端兜底超时：前端 60s 倒计时是主路径，这里只兜「页面已关」，须给足思考时间 */
const ASK_USER_TIMEOUT_MS = Number(process.env.ASK_USER_TIMEOUT_MS ?? 600000);

// process() 入口：
if (kind === 'timeout') {
  await this.handleTimeout(conversationId, job.data.toolName);
  return;
}

// 中断检测处（原 L251-258）——interrupt value 里取工具名：
const evt: RawEvent = { type: 'control_request', payload: value };
await this.stream.publish(conversationId, evt);
await this.persist(conversationId, evt, seq++);
const toolName = (
  value as { actionRequests?: { name?: string }[] } | undefined
)?.actionRequests?.[0]?.name;
await this.queue.add(
  'timeout',
  { conversationId, kind: 'timeout', toolName },
  { delay: toolName === 'ask_user' ? ASK_USER_TIMEOUT_MS : TIMEOUT_MS },
);

// handleTimeout 分叉：
private async handleTimeout(
  conversationId: string,
  toolName?: string,
): Promise<void> {
  const cas = await this.prisma.conversation.updateMany({
    where: { id: conversationId, status: 'waiting_approval' },
    data: { status: 'running' },
  });
  if (cas.count === 0) return; // 用户已决策，无需超时处理

  // ask_user 超时 = 采纳建议答案（approve 执行 tool 返回 suggested）；其余保持拒绝
  const isAskUser = toolName === 'ask_user';
  this.logger.warn(
    `conversation=${conversationId} ${isAskUser ? '等待回答超时，自动采纳建议' : '审批超时，自动拒绝'}`,
  );
  await this.prisma.approval.create({
    data: {
      conversationId,
      decision: 'timeout',
      payload: { reason: isAskUser ? 'ask_user_timeout' : 'approval_timeout' },
    },
  });
  await this.stream.publish(conversationId, {
    type: 'message',
    payload: {
      text: isAskUser
        ? '⏱ 等待回答超时，已自动采用建议答案。'
        : '⏱ 审批超时，已自动拒绝该操作。',
    },
  });
  await this.queue.add('resume', {
    conversationId,
    kind: 'resume',
    decisions: [{ type: isAskUser ? 'approve' : 'reject' }],
  });
}
```

- [ ] **Step 3.5: 跑测试确认通过 + 全量回归 + tsc**

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm --filter backend test && pnpm --filter backend exec tsc --noEmit`
Expected: 全 pass / 0 error

---

### Task 4: shadcn 原语（前端）

**Files:**
- Create: `apps/frontend/src/components/ui/radio-group.tsx`、`checkbox.tssx`

- [ ] **Step 4.1: CLI 添加**

Run: `cd apps/frontend && pnpm dlx shadcn@latest add radio-group checkbox`
Expected: 两文件生成、radix 依赖入 package.json。若 CLI 与项目配置冲突，则按 `components/ui/switch.tsx` 的既有风格手写两原语（radix primitives + 语义 token）。

- [ ] **Step 4.2: lint + tsc**

Run: `pnpm --filter frontend exec tsc --noEmit`（如有 script 则用之）
Expected: 0 error

---

### Task 5: QuestionPanel（前端）

**Files:**
- Create: `apps/frontend/src/app/agent/_components/question-panel.tsx`
- Modify: `apps/frontend/src/app/agent/_components/chat-thread.tsx:289`（分流）

- [ ] **Step 5.1: 实现 QuestionPanel**

要点（完整实现按此约束展开）：
- 类型（放本文件，args 来自 `approval.actionRequests[0].args`）：

```ts
interface AskUserOption { label: string; description?: string }
interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserOption[];
  suggested: string[];
}
/** 分流谓词：chat-thread 用它决定渲染 QuestionPanel 还是 ApprovalPanel */
export function isAskUserApproval(approval: Approval): boolean {
  return (
    approval.actionRequests.length === 1 &&
    approval.actionRequests[0].name === 'ask_user'
  );
}
```

- 状态：`answers: { selected: string[]; custom: string; useCustom: boolean }[]`，初始 selected = 每题 suggested（建议答案预选）。
- 单选：RadioGroup，「其他」为一个 radio 项，选中时显示 Input（与选项互斥）；多选：Checkbox 列表 + 「其他」Checkbox + Input（可叠加）。
- 建议项 label 旁 `<Badge variant="secondary">建议</Badge>`。
- 倒计时：`COUNTDOWN_S = 60`；`useEffect` 起 `setInterval` 每秒减一（注意 Next16 禁 effect 内同步 setState——interval 回调里 set 是允许的）；`interacted` 为 true 时清掉；到 0 → `onSubmit([{ type: 'approve' }])`。任何选项点击/输入聚焦 → `setInteracted(true)`。
- 头部：`PromptPanel` icon 用 `MessageCircleQuestion`（lucide），title「Spark 想确认几件事」，`glow`；未交互时 footer 显示「{n}s 后自动采用建议答案」+ 细进度条（`bg-primary` 宽度百分比）。
- 提交（respond）：

```ts
function submit() {
  const lines = questions.map((q, i) => {
    const a = answers[i];
    const picks = [...a.selected];
    if (a.useCustom && a.custom.trim()) picks.push(`自定义：${a.custom.trim()}`);
    return `${q.header}: ${picks.join('、') || '(未选择)'}`;
  });
  onSubmit([{ type: 'respond', message: lines.join('\n') }]);
}
```

- 样式：语义 token only（`bg-card`/`text-muted-foreground`/`border-border`…），4/8px 间距，`rounded-md/lg`，禁 emoji 图标（CLAUDE.md §7）。

- [ ] **Step 5.2: chat-thread 分流**

```tsx
import { isAskUserApproval, QuestionPanel } from "./question-panel";
// L289 处：
{approval &&
  (isAskUserApproval(approval) ? (
    <QuestionPanel approval={approval} onSubmit={onDecide} />
  ) : (
    <ApprovalPanel approval={approval} onSubmit={onDecide} />
  ))}
```

- [ ] **Step 5.3: lint + tsc**

Run: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH && pnpm lint && pnpm --filter frontend exec tsc --noEmit`
Expected: 0 error（diff 无 any/as any/@ts-ignore）

---

### Task 6: 端到端验证（preview 实测）

- [ ] **Step 6.1: 起 preview**（注意 PM2 守护：先 `PM2_HOME=./.pm2 pm2 stop frontend` 如占用；测完恢复 desktop 视口）
- [ ] **Step 6.2: 触发提问**：对 agent 发「问我一个 1-4 题的多选+单选问题再继续」类消息，确认 QuestionPanel 渲染：选项/建议徽标/倒计时。
- [ ] **Step 6.3: 路径 A**——不操作等 60s：自动提交 approve，流内工具结果为建议答案（auto:true），agent 继续。
- [ ] **Step 6.4: 路径 B**——再触发一次，点选其他选项+自定义：倒计时消失，手动提交，工具结果为格式化用户答案。
- [ ] **Step 6.5: send_email 回归**——触发一次邮件审批，确认走老 ApprovalPanel 且 120s 超时逻辑不受影响（可看代码路径确认，不必等 120s）。

---

## 完成标准

- 后端：`pnpm --filter backend test` 全 pass、`tsc --noEmit` 0 error。
- 前端：`pnpm lint` 0 error、`tsc --noEmit` 0 error。
- preview 实测两条路径 + send_email 回归确认。
- 不 commit——汇报（带 Verification section）后由用户 review。
