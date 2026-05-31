# Handoff：/agent 三栏对话 UI（抄 demo/template）+ 多轮追加

> 给接手的新 session：读完本文件即可上手。当前代码已提交在 `78a0630`，工作区干净。

## 一、本次任务（两件事）

### 1. 把 `/agent` 升级成三栏对话布局，**样式抄 `apps/frontend/src/app/demo/template/`**（用户已确认该样式）
- demo 模板是完整三栏：**会话侧栏（ConversationSidebar）+ 对话区（ChatThread）+ 详情面板（DetailPanel）**，manus 暖中性风格，响应式（desktop 常驻 sidebar / mobile 用 Sheet 抽屉），含 ThemeToggle。
- 目标：把 `/agent` 现在的「简单单页」换成这套三栏，接真实数据（不是 demo 的 mock）：
  - **侧栏会话列表** ← `GET /conversations`（已存在，返回当前租户会话 `{id,goal,status,createdAt}`）
  - **对话区** ← 选中会话后 `GET /conversations/:id`（含 messages）渲染历史 + socket `conversation:subscribe` 实时流式（现有审批卡片/工具卡片/todos 逻辑迁过来）
  - **详情面板** ← 可放工具调用详情/审批（按需，可后置）
- demo 组件可直接复制改造：`_components/{conversation-sidebar,chat-thread,chat-message,detail-panel,theme-toggle}.tsx`、`_hooks/{use-theme,use-is-desktop}.ts`。把 `_data/mock.ts` 换成真实 API/socket。
- demo 用到的 shadcn 组件都已装：`sheet avatar tooltip input separator tabs scroll-area button card badge skeleton textarea`。

### 2. 多轮追加（同一会话连续对话）
- 现状：每次提交都 `POST /conversations` **新建**会话；agent 跑完 done 就结束，不记得上下文。
- 要做：在**已有会话里继续发消息**，用**同一个 `thread_id`（= Conversation.id）**续跑——deepagents 的 RedisSaver checkpointer 会自动加载该 thread 的历史 state，agent 有上下文记忆。
- 后端：新增追加入口，建议 `POST /conversations/:id/messages { content }`：
  - 校验会话属于当前租户（`@CurrentUser` tenantId + findFirst）
  - 落一条 user message（seq 接续）
  - `queue.add('agent-run', { conversationId, kind:'run-append', goal: content })`（或复用 kind:'run'，worker 里 `agent.stream({messages:[新用户消息]}, {thread_id})` 续跑——同 thread_id + checkpointer 自动带历史）
  - 注意：worker 当前 `kind:'run'` 用 `{messages:[{role:'user',content:goal}]}`；追加同样传新 user 消息 + 同 thread_id 即可，checkpointer 负责历史。
- 前端：对话区底部常驻输入框，发消息走追加入口，新一轮事件继续 append 到当前会话消息流。

## 二、当前架构 context（接手必读）

**技术栈**：pnpm monorepo · `apps/backend`=NestJS 11 · `apps/frontend`=Next 16 + React 19 + Tailwind 4 + shadcn/ui(base-nova/neutral) + TanStack Query。

**数据模型**（Prisma，`apps/backend/prisma/schema.prisma`）：
- `Conversation`（= deepagents thread，`id` 即 `thread_id`）：goal/status/tenantId/userId + messages
- `Message`：conversationId/role/type/content(Json)/seq
- `Approval`、`Tenant`、`User`
- status：`queued|running|waiting_approval|done|failed`

**鉴权（next-auth v5 + NestJS JWT 桥接）**：
- 登录 `signIn('credentials',{email})` → next-auth Credentials.authorize 调 NestJS `POST /auth/login` 拿标准 JWT → 存进 next-auth session（httpOnly cookie），并经 session callback 暴露 `backendToken`
- **CSR 取 token**：`lib/api.ts`/`lib/socket.ts` 用 `getSession()` 取 `session.backendToken` → REST 带 `Authorization: Bearer`，socket 带 `auth:{token}`
- **SSR 守卫**：`src/middleware.ts`（next-auth `auth()`，matcher `/agent`+`/conversations`）
- **SSR 取数**：Server Component `await auth()` 取 backendToken（见 `app/conversations/page.tsx` 示例）
- NestJS 端：REST 用 `JwtAuthGuard`（`apps/backend/src/auth/`），socket 用 `EventsGateway.handleConnection` 验同一 JWT；都按 `tenantId` 做多租户隔离

**实时（socket.io）**：
- 前端 `lib/socket.ts`：`subscribeConversation(id, onEvent)` emit `conversation:subscribe`、收 `conversation:event`；`respondControl(id, decisions)` emit `control:response`
- 后端 `EventsGateway`：subscribe/control 都校验会话租户归属
- 事件类型 `ConversationEvent.type`：`token|message|tool_start|tool_end|plan_update|control_request|result|error`（含义见 `lib/socket.ts` + 现有 `/agent/page.tsx` handleEvent）

**agent**：`apps/backend/src/agent/agent.factory.ts`（deepagents + Gemini，`send_email` 需审批；`get_weather` demo）。Worker：`worker/agent.processor.ts`（kind: run/resume/timeout）。

**现有 `/agent/page.tsx` 的事件处理 + 审批 4 决策逻辑**可整体迁到新对话区组件，别丢。

## 三、环境坑（务必照做，否则踩坑）
- **Node 必须 v22**：每条 shell 命令前 `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`（默认 shell 是古老的 v14）
- **启服务**用 `.claude/launch.json` 的 `preview_start`（backend/frontend，已注入 v22 PATH）；改代码后常需 `preview_stop`+`preview_start` 重启（watch 不一定重载新依赖）
- **依赖**：`pnpm --filter frontend add ...`；装完若报 `ERR_PNPM_IGNORED_BUILDS` 就 `pnpm approve-builds --all`
- **docker**：`docker compose -f docker-compose.dev.yml up -d`（mysql + **redis-stack**，redis 必须 stack 版含 RediSearch/RedisJSON，checkpointer 依赖）
- **.env**：`apps/backend/.env`（含 GOOGLE_API_KEY）、`apps/frontend/.env.local`（含 AUTH_SECRET）均已配好、在 gitignore；模板见各 `.env.example`
- **不自动 commit**（CLAUDE.md）；preview 浏览器有时会被导航到别处，用绝对 URL `http://localhost:3000/...` 拉回

## 四、建议步骤
1. 复制 demo 组件到 `/agent`（或新建 `app/agent/_components/`），先静态跑通三栏布局
2. 侧栏接 `GET /conversations`（TanStack Query），选中会话 → `GET /conversations/:id` 渲染历史
3. 对话区接 socket `subscribeConversation`，迁移现有 token/tool/plan/审批渲染逻辑
4. 后端加 `POST /conversations/:id/messages` 追加入口 + worker 续跑（同 thread_id）
5. 前端对话区输入框走追加；验证多轮上下文记忆（第二轮 agent 记得第一轮）
6. preview 验证（登录→建会话→多轮对话→切换会话），每步 `git add` 暂存（不 commit，等用户）

## 五、验收
- /agent 是三栏（侧栏会话列表 + 对话 + 详情），样式贴 demo/template
- 选会话看历史；同会话多轮、agent 有上下文记忆
- 鉴权/多租户/审批/流式都仍工作；`pnpm --filter backend test` 仍绿（12 测试）
