---
name: deepagents-dev
description: >-
  deepagents（LangChain Deep Agents，TypeScript/LangGraph.js）框架开发与技术方案设计的权威参考基准。
  当用 deepagents / createDeepAgent 开发 agent、或设计 agent 平台技术方案时，先用本 skill 检索官方文档基准，
  再展开设计与实现。覆盖：子 Agent(subagents)、中间件(middleware)、虚拟文件系统与后端
  (StateBackend / StoreBackend / CompositeBackend / FilesystemBackend / 沙箱)、长期记忆(memory)、
  技能(Skills / progressive disclosure)、人机协作(interruptOn / 审批 / Command resume)、
  流式输出(streamMode / subgraphs)、上下文工程(offload / summarize / 子 Agent 隔离)、守护(guardrails)、
  生产部署(Thread/User/Assistant、checkpointer 持久化、记忆作用域)、ACP、CLI。
  触发词：deepagents、createDeepAgent、deep agent、子 agent、subagent、langgraph agent、
  agent 中间件、虚拟文件系统、StoreBackend、CompositeBackend、interruptOn、write_todos、
  deepagents 方案、deepagents 设计、agent 平台设计。
---

# deepagents 开发参考基准

`reference.md`（同目录，2393 行 / 76KB）是 LangChain Deep Agents **官方 TypeScript 文档的完整摘要**，按 25 章 + 2 附录组织。本 skill 是它的"导航 + 设计基准"。本项目（`apps/backend`）真实运行在 `deepagents@1.10.2` + `@langchain/langgraph@1.3.2` 上。

**两类用途**：
1. **开发** —— 要用某个 deepagents 能力（子 Agent、后端、记忆、技能、人审、流式…）前，先取对应章节，照官方 API 写。
2. **设计技术方案** —— 以 reference.md 为基准（不要凭印象）；本项目第一期设计见根目录 `2026-05-29-deepagents-task-automation-agent-design.md`。

> 路径说明：下文路径相对**仓库根** `/Users/biu/Desktop/agent-test`。driver 与文档都在 `.claude/skills/deepagents-dev/` 内。

## 取文档：用 section.mjs，别整篇读

reference.md 有 76KB。**不要 `read_file` 整篇灌进上下文** —— 用 driver 按需取章（progressive disclosure）：

```bash
# 1) 先列全部章节（拿到章号）
node .claude/skills/deepagents-dev/section.mjs

# 2) 按章号取（可多章）
node .claude/skills/deepagents-dev/section.mjs 9 13 16

# 3) 按标题关键词取
node .claude/skills/deepagents-dev/section.mjs 记忆 流式
```

需要 node 22（本项目 `.nvmrc` = 22.21.1；默认 shell 可能是 node 14，先确保 PATH 指向 v22）。脚本自带 reference.md 定位，在仓库任意目录都能跑。

## 章节速查（topic → 章号）

| 我要做的事 | 取这些章 |
| --- | --- |
| 入门 / 最小示例 / 何时该用 deepagents | `1` `2` |
| 自定义模型、内置/自定义中间件、结构化输出 | `3` `7` |
| 上生产：Thread/User/Assistant、持久化、记忆作用域、沙箱生命周期、guardrails | `5` |
| 核心能力全景（write_todos / 文件工具 / 上下文压缩） | `6` |
| 上下文工程：offload、summarize、运行时 context、子 Agent 隔离 | `8` |
| 选后端：StateBackend / StoreBackend / CompositeBackend / FilesystemBackend / 自定义 VFS / policy hooks | `9` |
| 子 Agent：Dictionary vs Compiled、general-purpose、技能继承、调试 | `10` |
| 异步子 Agent（需 LangSmith 部署） | `11` |
| 人机协作：interruptOn、中断+恢复、编辑参数 | `12` |
| 长期记忆：作用域、多用户 seed、episodic、后台合并 | `13` |
| 技能：SKILL.md 结构、progressive disclosure、三种后端用法、子 Agent 技能 | `14` |
| 沙箱：execute、提供商、生命周期、两个文件平面、安全 | `15` |
| 流式：streamMode 四种、subgraphs、token/工具/自定义事件 | `16` |
| 前端：useStream、子 Agent 流式渲染、Todo 列表 | `17` `18` `19` |
| ACP / CLI / MCP 工具 / 配置 / 数据位置 | `20`–`25` |
| 常用 npm 包、环境变量速查 | 关键词 `npm`、`环境变量` |

## 设计基准（设计技术方案时遵循；细节取对应章节）

- **何时用**（§1）：需要规划 / 大量上下文管理 / 沙箱执行 / 长期记忆 / 文件权限 / 人审 / 多模型切换 → 用 deepagents；纯简单任务用 LangChain `createAgent` 或裸 LangGraph。
- **装配入口**（§1·§6）：`createDeepAgent({ model, systemPrompt, tools, backend, skills, interruptOn, checkpointer })`。内置能力：`write_todos` 规划、`ls/read_file/write_file/edit_file/glob/grep` 虚拟文件系统、`task` 派子 Agent、自动 offload + summarize。
- **选后端**（§9，最关键决策）：`StateBackend`（默认，单线程临时）｜`StoreBackend`（跨线程持久，**多用户必设 `namespace`**）｜`CompositeBackend`（路由不同路径到不同后端，**最常用**，典型 `/memories/`→Store）｜`FilesystemBackend`（真实磁盘，**务必 `virtualMode:true` 防越权**）｜沙箱后端（额外暴露 `execute`）。
- **上下文工程**（§6.4·§8.4）：输入上下文最小化；重活派子 Agent 且要求**只回 <500 字摘要**；大输出落盘，主上下文用 `read_file`/`grep` 取片段；offload 阈值 ~20k token、summarize 在 max_input 的 85%。
- **记忆 vs 技能**（§6.7·§14.9）：**记忆**(`AGENTS.md`，启动总注入，放通用偏好/约定) vs **技能**(`SKILL.md`，命中才加载 = progressive disclosure，放任务相关大流程)。跨线程记忆必须用 `CompositeBackend` 把 `/memories/` 路由到 Store。
- **人机协作**（§12）：`interruptOn: { 工具名: true }` 触发审批中断；恢复用 `agent.stream(new Command({ resume: { decisions } }), config)`。
- **生产**（§5）：三概念 Thread/User/Assistant；`checkpointer` 提供每步持久化与恢复；记忆作用域 user(推荐默认)/assistant/global；guardrails 用中间件（modelCallLimit / toolCallLimit / retry / fallback / pii）。
- **流式**（§16）：`streamMode: ['updates','messages']` + `subgraphs: true` 才能看到子 Agent 的流。

## 本项目如何接线（doc → 真实代码）

把官方 API 落到本仓库的对照，改 agent 内核时先看这里：

| 文档能力 | 本项目实现 |
| --- | --- |
| `createDeepAgent` 装配 | [apps/backend/src/agent/agent.factory.ts](apps/backend/src/agent/agent.factory.ts) —— Gemini + `CompositeBackend(沙箱/StateBackend, {'/skills/': 只读 StoreBackend})` + `skills:['/skills/']` + `interruptOn:{send_email:true}` + Redis checkpointer + extraTools 注入 |
| checkpointer 持久化（§5.3） | [apps/backend/src/agent/checkpointer.provider.ts](apps/backend/src/agent/checkpointer.provider.ts) |
| 流式 `streamMode`+`subgraphs`（§16） | [apps/backend/src/worker/agent.processor.ts](apps/backend/src/worker/agent.processor.ts) 的 `agent.stream(...)` |
| 人审中断+`Command` 恢复（§12） | 同上 `agent.processor.ts`：检查 `state.tasks[].interrupts`，`new Command({ resume })` 续跑 |
| 技能存储与播种（§14.4 + CompositeBackend 挂载） | [apps/backend/src/skills/](apps/backend/src/skills/) —— SkillsService（内置+用户安装+DB）+ `skill-store.seed.ts` 每 run 前 diff 播种 InMemoryStore（键为**挂载点相对路径** `/<name>/<rel>`，CompositeBackend 委派前剥路由前缀） |
| 沙箱后端（§15，Daytona user-scoped：一个用户一个，停 5min/删 30min） | [apps/backend/src/agent/sandbox.ts](apps/backend/src/agent/sandbox.ts)（无 `DAYTONA_API_KEY` 回退 StateBackend）+ [apps/backend/src/agent/skills-backend.ts](apps/backend/src/agent/skills-backend.ts) 的 `beforeAgent` 技能同步（上传路径补回 `/skills` 前缀，官方 §14.8 模式） |
| 政策钩子只读后端（§9.5） | `skills-backend.ts` 的 `ReadOnlyStoreBackend`（write/edit 返回 error） |
| 事件归一化（流的 4 种 mode） | [apps/backend/src/agent/event-normalizer.ts](apps/backend/src/agent/event-normalizer.ts) |

## Gotchas（本项目真实踩过的坑，文档没写）

- **跑完一轮后 `state.messages` 为空**：deepagents 单轮结束不在持久化 state 保留对话消息，同 `thread_id` 续跑拿不到上文。本项目靠 worker 从 DB 重放历史解决（见 `agent.processor.ts` 的 `loadHistory`）。设计多轮会话时必须自己管历史，别假设 checkpointer 留着对话。
- **多轮里任务计划/已读 SKILL.md 不回上下文**：`write_todos` 的 plan、`read_file` 读到的 SKILL.md 都不在重放范围；不处理会导致每轮重新拆解计划、反复读同一个 SKILL.md。本项目在 system prompt 里回注既有计划与已激活技能的 SKILL.md（见 `buildPlanPrompt` / `buildSkillPrompt`）。
- **跑测试/脚本前先切 node 22**：默认 shell 可能是 node 14，直接跑会静默失败。
- **`9.7 工厂模式已废弃`**：`backend: (config)=>new StateBackend(config)` 旧写法别再用，直接 `new StateBackend()`。
- **CompositeBackend 会剥路由前缀再委派**（dist 注释："stripped_key has the route prefix removed (but keeps leading slash)"）：挂载在 `/skills/` 下的 StoreBackend，其存储键必须是**挂载点相对路径**（`/docx/SKILL.md`），带上 `/skills/` 前缀会出现 `/skills/skills/` 双前缀 + read_file 404（本项目实测踩过）。同理 `uploadFiles` 进沙箱时要把挂载前缀**补回去**。
- **StoreBackend namespace 工厂的实际入参是 `{ state, config, assistantId }`**（非文档写的 runtime context）：per-user 数据要走 `config.configurable`（worker 在 stream config 里传），`runtime.context` 在 namespace 工厂里拿不到。

## Troubleshooting

| 症状 | 处理 |
| --- | --- |
| `node: command not found` 或行为异常 | 当前是 node 14，切到 22.21.1 后重跑 `section.mjs` |
| `section.mjs` 报 `# 无章节号 N` | 该号不存在，先 `node section.mjs`（无参）看可用章号 |
| 取章内容像是被截断 | 章节本身就长（如 §5/§12/§13），正常；按需配合 `read_file` 在 reference.md 里精读子节 |
