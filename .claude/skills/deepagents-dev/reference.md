# LangChain Deep Agents 完整文档摘要（TypeScript）

> 本文档系统整理 LangChain Deep Agents 全部官方文档（TypeScript 版本），用于让 AI Agent 在开发时进行知识检索。每个模块都附原文 URL。
> 索引根目录：https://docs.langchain.com/oss/javascript/deepagents/overview

---

## 目录

1. [概览（Overview）](#1-概览overview)
2. [快速开始（Quickstart）](#2-快速开始quickstart)
3. [自定义（Customization）](#3-自定义customization)
4. [与 Claude Agent SDK / Codex 对比](#4-与-claude-agent-sdk--codex-对比)
5. [部署到生产（Going to production）](#5-部署到生产going-to-production)
6. [核心能力概览（Harness）](#6-核心能力概览harness)
7. [模型（Models）](#7-模型models)
8. [上下文工程（Context Engineering）](#8-上下文工程context-engineering)
9. [后端（Backends）](#9-后端backends)
10. [子 Agent（Subagents）](#10-子-agentsubagents)
11. [异步子 Agent（Async Subagents）](#11-异步子-agentasync-subagents)
12. [人机协作（Human-in-the-loop）](#12-人机协作human-in-the-loop)
13. [记忆（Memory）](#13-记忆memory)
14. [技能（Skills）](#14-技能skills)
15. [沙箱（Sandboxes）](#15-沙箱sandboxes)
16. [流式输出（Streaming）](#16-流式输出streaming)
17. [前端概览（Frontend Overview）](#17-前端概览frontend-overview)
18. [前端：子 Agent 流式渲染](#18-前端子-agent-流式渲染)
19. [前端：Todo 列表](#19-前端todo-列表)
20. [协议：ACP（Agent Client Protocol）](#20-协议acpagent-client-protocol)
21. [CLI 使用指南](#21-cli-使用指南)
22. [CLI 模型提供商](#22-cli-模型提供商)
23. [CLI 配置](#23-cli-配置)
24. [CLI MCP 工具](#24-cli-mcp-工具)
25. [CLI 数据存放位置](#25-cli-数据存放位置)

---

## 1. 概览（Overview）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/overview

`deepagents` 是 LangChain 团队基于 LangChain Core 与 LangGraph 构建的"Agent 套壳/Harness"标准库。它和普通 Agent 一样跑 tool-calling 循环，但内置：**任务规划、虚拟文件系统、上下文工程、子 Agent、长记忆、技能、沙箱、人机协作**。

仓库包含三部分：
- **Deep Agents SDK**（npm 包 `deepagents`）：构建 Agent
- **Deep Agents CLI**：基于 SDK 的终端编码助手
- **ACP 集成**：让 Deep Agent 在 Zed 等编辑器里以协议方式被调用

何时用：处理需要规划、需要大量上下文管理、需要在沙箱中执行命令、需要长期记忆、需要细粒度文件权限控制、需要人审、需要跨模型提供商灵活切换的复杂任务。简单任务可以用 LangChain 的 `createAgent` 或纯 LangGraph 工作流。

**最小可运行示例：**

```typescript
import * as z from "zod";
// npm install deepagents langchain @langchain/core
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";

const getWeather = tool(
  ({ city }) => `It's always sunny in ${city}!`,
  {
    name: "get_weather",
    description: "Get the weather for a given city",
    schema: z.object({ city: z.string() }),
  },
);

const agent = createDeepAgent({
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant",
});

console.log(
  await agent.invoke({
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  })
);
```

内置核心能力一览：
- `write_todos`：规划与任务分解
- `ls / read_file / write_file / edit_file / glob / grep`：虚拟文件系统
- `execute`（仅沙箱后端）：执行 shell
- `task`：派发子 Agent，做上下文隔离
- 自动摘要（Summarization）+ 自动卸载（Offloading）：超长上下文自动压缩
- 跨线程长期记忆（基于 LangGraph Store）
- 文件权限规则（read/write 白/黑名单）
- 人审中断（`interrupt_on`）
- 技能（progressive disclosure）
- 模型无关：任何支持 tool-calling 的 LangChain Chat Model 都能用

建议开启 LangSmith：设置 `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`。

---

## 2. 快速开始（Quickstart）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/quickstart

构建一个研究 Agent，用 Tavily 搜索 + Deep Agent 内置规划/文件系统/子 Agent。

**步骤一：安装**
```bash
npm install deepagents langchain @langchain/core @langchain/tavily
```

**步骤二：设置环境变量**
```bash
export ANTHROPIC_API_KEY="your-api-key"
export TAVILY_API_KEY="your-tavily-api-key"
```

**步骤三：定义搜索工具**

```typescript
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";

const internetSearch = tool(
  async ({ query, maxResults = 5, topic = "general", includeRawContent = false }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });
    return await tavilySearch._call({ query });
  },
  {
    name: "internet_search",
    description: "Run a web search",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z.number().optional().default(5),
      topic: z.enum(["general", "news", "finance"]).optional().default("general"),
      includeRawContent: z.boolean().optional().default(false),
    }),
  },
);
```

**步骤四：创建 Agent**

```typescript
import { createDeepAgent } from "deepagents";

const researchInstructions = `You are an expert researcher. Your job is to conduct thorough research and then write a polished report.

You have access to an internet search tool as your primary means of gathering information.`;

const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-6",   // 默认即为该模型；可换 openai:gpt-5.4、google-genai:gemini-3.1-pro-preview 等
  tools: [internetSearch],
  systemPrompt: researchInstructions,
});
```

**步骤五：调用**

```typescript
const result = await agent.invoke({
  messages: [{ role: "user", content: "What is langgraph?" }],
});

console.log(result.messages[result.messages.length - 1].content);
```

Agent 的执行流程：自动调用 `write_todos` 做规划 → 调 `internet_search` 收集资料 → 用 `write_file` / `read_file` 卸载大体积结果 → 必要时用 `task` 派发子 Agent → 综合产出回答。Deep Agents 默认支持流式输出。

---

## 3. 自定义（Customization）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/customization

`createDeepAgent` 的可配置项：

```typescript
const agent = createDeepAgent({
  name?: string,
  model?: BaseLanguageModel | string,
  tools?: TTools | StructuredTool[],
  systemPrompt?: string | SystemMessage,
  middleware?,
  subagents?,
  backend?,
  interruptOn?,
  skills?,
  memory?,
  responseFormat?,    // 结构化输出
  checkpointer?,      // 人审/会话恢复必需
  store?,             // 长期记忆需要
  contextSchema?,
});
```

### 3.1 连接弹性（Connection resilience）
默认每次调用模型自动指数退避重试 6 次。可调整：

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-6",
    maxRetries: 10,        // 默认 6
    timeout: 120_000,
  }),
});
```
对长时间任务搭配 checkpointer 可在失败时从最近状态续跑。

### 3.2 模型
两种写法：字符串 `"provider:model"` 或直接传 LangChain Chat Model 对象。详见后文 [模型](#7-模型models)。

### 3.3 内置中间件
默认装载：
- `TodoListMiddleware`、`FilesystemMiddleware`、`SubAgentMiddleware`、`SummarizationMiddleware`、`AnthropicPromptCachingMiddleware`、`PatchToolCallsMiddleware`
- 传 `memory` 时加 `MemoryMiddleware`，传 `skills` 时加 `SkillsMiddleware`，传 `interruptOn` 时加 `HumanInTheLoopMiddleware`

### 3.4 自定义中间件示例

```typescript
import { tool, createMiddleware } from "langchain";
import { createDeepAgent } from "deepagents";
import * as z from "zod";

const getWeather = tool(
  ({ city }: { city: string }) => `The weather in ${city} is sunny.`,
  {
    name: "get_weather",
    description: "Get the weather in a city.",
    schema: z.object({ city: z.string() }),
  }
);

const logToolCallsMiddleware = createMiddleware({
  name: "LogToolCallsMiddleware",
  wrapToolCall: async (request, handler) => {
    console.log(`[Middleware] Tool: ${request.toolCall.name}`);
    console.log(`[Middleware] Args: ${JSON.stringify(request.toolCall.args)}`);
    const result = await handler(request);
    console.log(`[Middleware] Done`);
    return result;
  },
});

const agent = await createDeepAgent({
  model: "claude-sonnet-4-20250514",
  tools: [getWeather] as any,
  middleware: [logToolCallsMiddleware] as any,
});
```

**关键警告：不要在中间件初始化时设置 `self.x` 这类可变属性**，子 Agent / 并发工具 / 多线程会导致竞态。需要跨 hook 共享数据时改用图状态（graph state）。

### 3.5 结构化输出（Structured Output）

```typescript
import { z } from "zod";
import { createDeepAgent } from "deepagents";

const weatherReportSchema = z.object({
  location: z.string(),
  temperature: z.number(),
  condition: z.string(),
  humidity: z.number(),
  windSpeed: z.number(),
  forecast: z.string(),
});

const agent = await createDeepAgent({
  responseFormat: weatherReportSchema,
  tools: [internetSearch],
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather like in San Francisco?" }],
});

console.log(result.structuredResponse);
// { location: 'San Francisco', temperature: 18.3, condition: 'Sunny', ... }
```

---

## 4. 与 Claude Agent SDK / Codex 对比

**原文：** https://docs.langchain.com/oss/javascript/deepagents/comparison

| 维度 | LangChain Deep Agents | Claude Agent SDK | Codex SDK |
| --- | --- | --- | --- |
| 用途 | 通用 Agent（含编码） | 编码 Agent（定制） | 预制编码 Agent |
| 模型支持 | 与提供商无关，100+ | 紧绑 Claude | 紧绑 OpenAI |
| 形态 | Python / TS SDK + CLI | Python / TS SDK | TS SDK + CLI + 桌面端 + IDE |
| 执行环境 | 本地、远程沙箱、虚拟文件系统 | 本地 | 本地、云 |
| 部署 | LangGraph Platform | 自部署 | N/A |
| 前端 | React 集成 | 仅服务端 | 仅服务端 |
| 可观测 | LangSmith | 无 | OpenAI Traces |
| License | MIT | MIT（底层 Claude Code 闭源） | Apache-2.0 |

Deep Agents 独有：长期记忆（Memory Store）、沙箱作为工具的模式、虚拟文件系统、LangGraph Platform 部署、组合式中间件、A2A、ACP 服务端等。Claude Agent SDK 独有：Claude 多云原生支持、hooks。Codex 独有：OS 级 sandbox 模式、`codex mcp-server`。

---

## 5. 部署到生产（Going to production）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/going-to-production

三大基本概念：**Thread**（会话）、**User**（用户）、**Assistant**（一个被配置好的 Agent 实例）。

最快路径：`deepagents deploy` 一键部署成 LangSmith Deployment，自动配 assistants/threads/runs/store/checkpointer，附带认证、webhook、cron、可观测、MCP/A2A 端点。

`langgraph.json` 示例：
```json
{
  "dependencies": ["."],
  "graphs": { "agent": "./src/agent.ts:agent" },
  "env": ".env"
}
```

### 5.1 多租户认证
- 用户身份/授权：LangSmith 自定义 auth + authorization handlers
- 团队 RBAC：Workspace Admin / Editor / Viewer
- 终端用户凭据：**Agent Auth**（OAuth 2.0）

```typescript
import { Client } from "@langchain/auth";
const authClient = new Client();
const authResult = await authClient.authenticate({
  provider: "github",
  scopes: ["repo", "read:org"],
  userId: runtime.serverInfo.user.identity,
});
```

### 5.2 异步
LangChain 的异步方法以 `a` 前缀（如 `ainvoke`、`astream`、`abefore_agent`）。生产中创建异步工具、用异步中间件、用 async graph factory 在每次 run 时获取 sandbox。

### 5.3 持久化（Durability）
Deep Agents 跑在 LangGraph 上，每步都 checkpoint。失败 / interrupt / 超时都能从最近状态恢复。支持时间旅行（time travel）、不限时长的人审 interrupt、敏感操作审计。

### 5.4 记忆作用域

| 作用域 | 命名空间 | 用法 |
| --- | --- | --- |
| **User**（推荐默认） | `(user_id)` | 用户偏好 |
| **Assistant** | `(assistant_id)` | 单 assistant 的共享指令 |
| **Global** | `(org_id)` | 全组织只读策略 |

**用户作用域示例：**
```typescript
import { createDeepAgent, CompositeBackend, StateBackend, StoreBackend } from "deepagents";

export const agent = createDeepAgent({
  backend: new CompositeBackend(
    new StateBackend(),
    {
      "/memories/": new StoreBackend({
        namespace: (rt) => [rt.serverInfo.assistantId, rt.serverInfo.user.identity],
      }),
    },
  ),
  systemPrompt: `You have persistent memory at /memories/.
Read /memories/instructions.txt at the start of each conversation.`,
});
```

### 5.5 沙箱生命周期

| 范围 | 存放位置 | 生命周期 | 场景 |
| --- | --- | --- | --- |
| **Thread-scoped** | Thread metadata | 每会话一份，TTL 清理 | 数据分析 |
| **Assistant-scoped** | Assistant config | 所有会话共享 | 维护已克隆仓库的编码助手 |

**Thread-scoped 沙箱（最常见）：**

```typescript
import { Daytona } from "@daytonaio/sdk";
import { DaytonaSandbox } from "@langchain/daytona";
import { createDeepAgent } from "deepagents";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

const client = new Daytona();

export async function agent(config: LangGraphRunnableConfig) {
  const threadId = config.configurable?.thread_id as string;
  let sandbox;
  try {
    sandbox = await client.findOne({ labels: { thread_id: threadId } });
  } catch {
    sandbox = await client.create({
      labels: { thread_id: threadId },
      autoDeleteInterval: 3600,
    });
  }
  return createDeepAgent({ backend: await DaytonaSandbox.fromId(sandbox.id) });
}
```

### 5.6 沙箱文件传输与密钥
- `uploadFiles()` / `downloadFiles()` 用于 host 与 sandbox 之间搬运文件
- 用 `before_agent` / `after_agent` 中间件把 skills 与 memories 同步到 sandbox
- **不要把 secrets 塞进 sandbox**，用 **sandbox auth proxy** 自动注入认证头：

```json
{
  "proxy_config": {
    "rules": [
      {
        "name": "openai-api",
        "match_hosts": ["api.openai.com"],
        "inject_headers": { "Authorization": "Bearer ${OPENAI_API_KEY}" }
      }
    ]
  }
}
```

### 5.7 守护（Guardrails）

```typescript
import {
  createAgent,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
  modelRetryMiddleware,
  modelFallbackMiddleware,
  toolRetryMiddleware,
  piiMiddleware,
} from "langchain";

const agent = createAgent({
  model: "claude-sonnet-4-6",
  middleware: [
    modelCallLimitMiddleware({ runLimit: 50 }),
    toolCallLimitMiddleware({ runLimit: 200 }),
    modelRetryMiddleware({ maxRetries: 3, backoffFactor: 2.0, initialDelayMs: 1000 }),
    modelFallbackMiddleware("gpt-4.1"),
    toolRetryMiddleware({ maxRetries: 2, tools: ["search", "fetch_url"], retryOn: [TimeoutError, TypeError] }),
    piiMiddleware("email", { strategy: "redact", applyToInput: true }),
    piiMiddleware("credit_card", { strategy: "mask", applyToInput: true }),
  ],
});
```
PII 策略：`redact`、`mask`、`hash`、`block`。

### 5.8 前端连接

```typescript
import { useStream } from "@langchain/react";

function App() {
  const stream = useStream<typeof agent>({
    apiUrl: "https://your-deployment.langsmith.dev",
    assistantId: "agent",
    reconnectOnMount: true,
    fetchStateHistory: true,
  });
}

stream.submit(
  { messages: [{ type: "human", content: text }] },
  { streamSubgraphs: true, config: { recursionLimit: 10000 } },
);
```

---

## 6. 核心能力概览（Harness）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/harness

"Agent Harness（套壳）" 是把多种能力封装到一起：规划、虚拟文件系统、任务派发、上下文管理、代码执行、人审。

### 6.1 规划
内置 `write_todos`：维护 `pending / in_progress / completed` 三态的结构化任务列表，持久化到 Agent state。

### 6.2 虚拟文件系统工具

| 工具 | 说明 |
| --- | --- |
| `ls` | 列目录元信息 |
| `read_file` | 读文件（带行号、可 offset/limit；支持 png/jpg/jpeg/gif/webp 多模态） |
| `write_file` | 创建文件 |
| `edit_file` | 精确字符串替换（支持全局替换） |
| `glob` | `**/*.py` 等模式匹配 |
| `grep` | 内容搜索（多种输出模式） |
| `execute` | 执行 shell（仅 sandbox 后端） |

### 6.3 子 Agent
`task` 工具派发子 Agent。优点：上下文隔离、并行、专门化、用一个最终报告替代大量中间步骤。默认存在 `general-purpose` 子 Agent。

### 6.4 上下文管理
**输入上下文** 拼接顺序：
1. 用户自定义 `systemPrompt`
2. 基础 Agent prompt
3. Todo prompt
4. Memory prompt（仅当配置 memory）
5. Skills prompt（仅当配置 skills）
6. 虚拟文件系统 prompt
7. 子 Agent prompt
8. 自定义中间件 prompt
9. 人审 prompt（仅当配置 `interrupt_on`）
10. CLI 本地上下文（仅 CLI）

**运行时上下文压缩**：
- **卸载（Offloading）**：tool call 输入或结果超过 20,000 token（`tool_token_limit_before_evict`）时，旧的 tool call 被替换为文件路径引用 + 前 10 行预览
- **摘要（Summarization）**：上下文越过模型 `max_input_tokens` 的 85% 时，把对话历史压缩为结构化摘要；同时原文写入文件系统留档；保留 10% 作近期上下文

### 6.5 代码执行
仅当后端实现 `SandboxBackendProtocol` 时才暴露 `execute` 工具。输出含 stdout/stderr、退出码，过大时自动落盘。

### 6.6 长期记忆
要跨线程持久化，必须用 `CompositeBackend` 把某个路径（通常 `/memories/`）路由到 LangGraph Store。

### 6.7 技能 vs. 记忆
- **技能**：进步式披露（progressive disclosure），需要时才加载
- **记忆**（`AGENTS.md`）：每次启动总是加载

---

## 7. 模型（Models）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/models

支持任何具备 tool-calling 的 LangChain Chat Model。两种用法：

**字符串短写：**

```typescript
const agent = createDeepAgent({ model: "openai:gpt-5.3-codex" });
```

**通过 initChatModel 配置参数：**

```typescript
import { initChatModel } from "langchain/chat_models/universal";
import { createDeepAgent } from "deepagents";

const model = await initChatModel("anthropic:claude-sonnet-4-6", {
  maxTokens: 16000,
  thinking: { type: "enabled", budgetTokens: 10000 },
});
const agent = createDeepAgent({ model });
```

### 推荐模型（评测套件通过）
- **Anthropic**：`claude-opus-4-6`、`claude-sonnet-4-6`、`claude-sonnet-4-5`、`claude-haiku-4-5`、`claude-opus-4-1`
- **OpenAI**：`gpt-5.4`、`gpt-4o`、`gpt-4.1`、`o4-mini`、`gpt-5.2-codex`、`o3`
- **Google**：`gemini-3-flash-preview`、`gemini-3.1-pro-preview`
- **开源权重**：`GLM-5`、`Kimi-K2.5`、`MiniMax-M2.5`、`qwen3.5-397B-A17B`、`devstral-2-123B`

---

## 8. 上下文工程（Context Engineering）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/context-engineering

五种上下文：

| 类型 | 控制对象 | 范围 |
| --- | --- | --- |
| 输入上下文 | systemPrompt / memory / skills | 静态，每次 run 应用 |
| 运行时上下文 | invoke 时传入的 context | 单次 run，传播给子 Agent |
| 上下文压缩 | offload + summarize | 自动 |
| 上下文隔离 | 子 Agent | 单个子 Agent |
| 长期记忆 | StoreBackend | 跨会话 |

### 8.1 动态 system prompt
静态 `systemPrompt` 不够时用 `dynamicSystemPromptMiddleware`：

```typescript
const agent = await createDeepAgent({
  model: "claude-sonnet-4-6",
  systemPrompt: `You are a research assistant specializing in scientific literature.
  Always cite sources. Use subagents for parallel research on different topics.`,
});
```

### 8.2 运行时上下文（context）
工具通过 `config.context` 接收。注意：**context 不会自动注入 prompt**，需要工具/中间件主动读取再放进 messages。

```typescript
import { tool } from "langchain";
import { z } from "zod";

const fetchUserData = tool(
  (input, config) => {
    const userId = config.context?.userId;
    return `Data for user ${userId}: ${input.query}`;
  },
  {
    name: "fetch_user_data",
    description: "Fetch data for the current user",
    schema: z.object({ query: z.string() }),
  }
);

const contextSchema = z.object({ userId: z.string(), apiKey: z.string() });

const agent = await createDeepAgent({
  model: "claude-sonnet-4-6",
  tools: [fetchUserData],
  contextSchema,
});

const result = await agent.invoke(
  { messages: [{ role: "user", content: "Get my recent activity" }] },
  { context: { userId: "user-123", apiKey: "sk-..." } },
);
```
运行时 context 会自动传播到所有子 Agent。

### 8.3 长期记忆配置
```typescript
import { createDeepAgent, CompositeBackend, StateBackend, StoreBackend } from "deepagents";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

const agent = await createDeepAgent({
  model: "claude-sonnet-4-6",
  store: new InMemoryStore(),
  backend: (config) => new CompositeBackend(
    new StateBackend(config),
    { "/memories/": new StoreBackend(config) },
  ),
  systemPrompt: `When users tell you their preferences, save them to /memories/user_preferences.txt so you remember them in future conversations.`,
});
```

### 8.4 最佳实践
- 输入上下文最小化：memory 只放始终相关的约定；skills 放任务相关能力
- 重活派给子 Agent
- 子 Agent 配 prompt 让它只返回精简摘要
- 大输出落盘，主上下文用 `read_file` / `grep` 按需取片段
- 给 agent 写明 `/memories/` 中文件结构

---

## 9. 后端（Backends）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/backends

后端控制 `ls / read_file / write_file / edit_file / glob / grep` 的存储与权限。`read_file` 原生支持图像/PDF/音视频等二进制。Sandbox 与 `LocalShellBackend` 还提供 `execute`。

### 9.1 内置后端

| 后端 | 描述 |
| --- | --- |
| `StateBackend`（默认） | LangGraph state 中的临时文件系统，仅单线程持久 |
| `FilesystemBackend` | 本地磁盘下的真实文件系统，按 `rootDir` 限制；务必开 `virtualMode: true` |
| `LocalShellBackend` | 本地 shell + 文件，**不做隔离**，仅本地开发可控环境用 |
| `StoreBackend` | 用 LangGraph Store 做跨线程持久存储 |
| `CompositeBackend` | 路由不同路径到不同后端 |
| 沙箱后端 | Modal / Daytona / Deno / Node VFS（见 [沙箱](#15-沙箱sandboxes)） |

### 9.2 典型 TypeScript 示例

```typescript
// 1. StateBackend
import { createDeepAgent, StateBackend } from "deepagents";
const agent = createDeepAgent({ backend: new StateBackend() });

// 2. FilesystemBackend（务必 virtualMode 防越权）
import { FilesystemBackend } from "deepagents";
const agent2 = createDeepAgent({
  backend: new FilesystemBackend({ rootDir: ".", virtualMode: true }),
});

// 3. LocalShellBackend
import { LocalShellBackend } from "deepagents";
const agent3 = createDeepAgent({
  backend: new LocalShellBackend({ workingDirectory: "." }),
});

// 4. StoreBackend（多用户必须设 namespace）
import { StoreBackend } from "deepagents";
import { InMemoryStore } from "@langchain/langgraph";
const store = new InMemoryStore();
const agent4 = createDeepAgent({
  backend: new StoreBackend({
    namespace: (ctx) => [ctx.runtime.context.userId],
  }),
  store,
});

// 5. CompositeBackend（最常用）
import { CompositeBackend } from "deepagents";
const agent5 = createDeepAgent({
  backend: new CompositeBackend(
    new StateBackend(),
    { "/memories/": new StoreBackend() },
  ),
  store,
});
```

### 9.3 命名空间工厂
```typescript
NamespaceFactory = (rt: Runtime) => string[]

// 常见模式
new StoreBackend({ namespace: (rt) => [rt.serverInfo.user.identity] });        // 按用户
new StoreBackend({ namespace: (rt) => [rt.serverInfo.assistantId] });          // 按 assistant
new StoreBackend({ namespace: (rt) => [rt.executionInfo.threadId] });          // 按 thread
```
组合：`(user_id, thread_id)`、追加 `"filesystem"` 后缀避免冲突。

### 9.4 自定义虚拟文件系统（S3 / Postgres 模式）
实现 `BackendProtocolV2` 接口的 7 个方法（`ls / read / readRaw / grep / glob / write / edit`）。外部持久化（S3/Postgres）的写操作返回 `{ path, filesUpdate: null }`。

### 9.5 政策钩子（policy hooks）
通过子类或 wrapper 实现：

```typescript
import { FilesystemBackend, type WriteResult } from "deepagents";

class GuardedBackend extends FilesystemBackend {
  private denyPrefixes: string[];
  constructor({ denyPrefixes, ...options }: { denyPrefixes: string[]; rootDir?: string }) {
    super(options);
    this.denyPrefixes = denyPrefixes.map(p => p.endsWith("/") ? p : p + "/");
  }
  async write(filePath: string, content: string): Promise<WriteResult> {
    if (this.denyPrefixes.some(p => filePath.startsWith(p))) {
      return { error: `Writes are not allowed under ${filePath}` };
    }
    return super.write(filePath, content);
  }
}
```

### 9.6 二进制 / 多模态文件
V2 后端 `read()` 对二进制返回 `Uint8Array` + `mimeType`。支持 `.png/.jpg/.gif/.webp/.svg/.heic`、`.mp3/.wav/.aac/.ogg/.flac`、`.mp4/.webm/.mov/.avi` 等。

### 9.7 工厂模式已废弃
旧：`backend: (config) => new StateBackend(config)`
新：`backend: new StateBackend()`（后端内部自动通过 `getConfig() / getStore() / getRuntime()` 获取运行时）

---

## 10. 子 Agent（Subagents）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/subagents

### 10.1 两种类型
**Dictionary `SubAgent`：**

| 字段 | 必选 | 说明 |
| --- | --- | --- |
| `name` | ✓ | 唯一名 |
| `description` | ✓ | 决定主 Agent 何时派发 |
| `systemPrompt` | ✓ | 子 Agent 提示词 |
| `tools` | ✓ | 工具列表 |
| `model` | | 覆盖主 Agent 模型 |
| `middleware` | | 自定义中间件 |
| `interruptOn` | | 子 Agent 单独的人审配置 |
| `skills` | | 子 Agent 专属技能 |

**CompiledSubAgent**：直接传一个编译好的 LangGraph 图（state 必须有 `messages`）。

### 10.2 TypeScript 示例

```typescript
import { createDeepAgent, CompiledSubAgent } from "deepagents";
import { createAgent } from "langchain";

// Dictionary 形式
const researchSubagent = {
  name: "researcher",
  description: "Conducts in-depth research using web search and synthesizes findings",
  systemPrompt: `You are a thorough researcher. Return only the essential summary (under 500 words).
  Do NOT include raw search results.`,
  tools: [internetSearch],
  model: "openai:gpt-5.2",
};

// CompiledSubAgent 形式
const customGraph = createAgent({
  model: yourModel,
  tools: specializedTools,
  prompt: "You are a specialized agent for data analysis...",
});

const customSubagent: CompiledSubAgent = {
  name: "data-analyzer",
  description: "Specialized agent for complex data analysis tasks",
  runnable: customGraph,
};

const agent = createDeepAgent({
  model: "claude-sonnet-4-6",
  tools: [internetSearch],
  subagents: [researchSubagent, customSubagent],
});
```

### 10.3 通用子 Agent（general-purpose）
默认存在；与主 Agent 共享 system prompt、tools、model、skills。可以传同名 spec 替换它（例如让它换更便宜的模型）。

### 10.4 技能继承
- general-purpose 子 Agent **继承**主 Agent 的 skills
- 自定义子 Agent **不继承**，必须自己传 `skills`
- 技能状态完全隔离

### 10.5 上下文管理
父 Agent 的 `config.context` 自动传到所有子 Agent。要给特定子 Agent 单独传配置，用命名空间前缀：

```typescript
const result = await agent.invoke(
  { messages: [new HumanMessage("Research this and verify the claims")] },
  {
    context: {
      userId: "user-123",                  // 共享
      "researcher:maxDepth": 3,            // 仅 researcher
      "fact-checker:strictMode": true,     // 仅 fact-checker
    },
  },
);
```

工具中可通过 `config.metadata?.lc_agent_name` 判断调用者：

```typescript
const sharedLookup = tool(
  (input, config) => {
    const agentName = config.metadata?.lc_agent_name;
    if (agentName === "fact-checker") return strictLookup(input.query);
    return generalLookup(input.query);
  },
  {
    name: "shared_lookup",
    description: "Look up information from various sources",
    schema: z.object({ query: z.string() }),
  }
);
```

### 10.6 调试技巧
- 子 Agent 没被调用：写更清晰的 description、在主 prompt 里要求"复杂任务必须委派"
- 上下文还是膨胀：在子 Agent prompt 里强制 500 字内、用文件系统存大数据
- 选错子 Agent：让 description 互相鲜明区分

---

## 11. 异步子 Agent（Async Subagents）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/async-subagents

> 预览特性，目标版本 `deepagents@1.9.0-alpha.0`。**必须部署到 LangSmith Deployments** 才能工作。

| 维度 | 同步子 Agent | 异步子 Agent |
| --- | --- | --- |
| 执行 | 阻塞 | 立即返回 task ID |
| 并发 | 并行但阻塞 | 并行 + 非阻塞 |
| 中途更新 | 不可 | 可 `update_async_task` |
| 取消 | 不可 | 可 `cancel_async_task` |
| 状态 | 无 | 在自己的 thread 上有状态 |

### 11.1 配置

```typescript
import { createDeepAgent, AsyncSubAgent } from "deepagents";

const asyncSubagents: AsyncSubAgent[] = [
  {
    name: "researcher",
    description: "Research agent for information gathering and synthesis",
    graphId: "researcher",
    // 没有 url → ASGI（同部署内）
  },
  {
    name: "coder",
    description: "Coding agent for code generation and review",
    graphId: "coder",
    // url: "https://coder-deployment.langsmith.dev"  // HTTP 远程
  },
];

const agent = createDeepAgent({
  model: "claude-sonnet-4-6",
  subagents: [...asyncSubagents],
});
```

`langgraph.json` 注册：
```json
{
  "graphs": {
    "supervisor": "./src/supervisor.ts:graph",
    "researcher": "./src/researcher.ts:graph",
    "coder": "./src/coder.ts:graph"
  }
}
```

### 11.2 五个工具
| 工具 | 用途 |
| --- | --- |
| `start_async_task` | 启动后台任务，立即返回 task ID |
| `check_async_task` | 查询状态/结果 |
| `update_async_task` | 给运行中的任务追加指令 |
| `cancel_async_task` | 取消 |
| `list_async_tasks` | 列出全部任务 |

### 11.3 状态管理
异步任务元数据存在专用 state channel `asyncTasks`，**与消息历史隔离**——这样上下文摘要不会丢失 task ID。

### 11.4 部署拓扑
- **单部署**：所有图在一个 `langgraph.json`（ASGI，零延迟）
- **拆分部署**：supervisor 和 subagent 分开，HTTP transport
- **混合**：部分 ASGI + 部分 HTTP

本地测试时增大 worker 池：`langgraph dev --n-jobs-per-worker 10`。

### 11.5 常见问题
- supervisor 启动后立即轮询 check：在 prompt 中强调"启动后必须把控制权交还用户，不要立刻 check"
- 报告过时状态：在 prompt 中要求"对话历史中的状态总是过时的，必须用 check / list"

参考实现：https://github.com/langchain-ai/async-deep-agents

---

## 12. 人机协作（Human-in-the-loop）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop

通过 `interruptOn` 配置某些工具调用前需要审批。**必须传 `checkpointer`。**

### 12.1 基础配置

```typescript
import { tool } from "langchain";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";

const deleteFile = tool(
  async ({ path }: { path: string }) => `Deleted ${path}`,
  {
    name: "delete_file",
    description: "Delete a file from the filesystem.",
    schema: z.object({ path: z.string() }),
  },
);

const checkpointer = new MemorySaver();

const agent = createDeepAgent({
  model: "google_genai:gemini-3.1-pro-preview",
  tools: [deleteFile /* ... */],
  interruptOn: {
    delete_file: true,                                                   // 默认全决策
    read_file: false,                                                    // 不中断
    send_email: { allowedDecisions: ["approve", "reject"] },             // 只允许批准/拒绝
  },
  checkpointer,
});
```

### 12.2 决策类型
- `approve`：用原参数执行
- `edit`：修改参数后执行
- `reject`：跳过
- `respond`：把人类回复直接当工具结果（适合"问用户"型工具）

### 12.3 处理中断 + 恢复

```typescript
import { v7 as uuid7 } from "uuid";
import { Command } from "@langchain/langgraph";

const config = { configurable: { thread_id: uuid7() } };

let result = await agent.invoke(
  { messages: [{ role: "user", content: "Delete the file temp.txt" }] },
  config
);

if (result.__interrupt__) {
  const interrupts = result.__interrupt__[0].value;
  const actionRequests = interrupts.actionRequests;
  const reviewConfigs = interrupts.reviewConfigs;

  const configMap = Object.fromEntries(reviewConfigs.map((cfg) => [cfg.actionName, cfg]));

  for (const action of actionRequests) {
    console.log(`Tool: ${action.name}, Args: ${JSON.stringify(action.args)}`);
    console.log(`Allowed: ${configMap[action.name].allowedDecisions}`);
  }

  const decisions = [{ type: "approve" }];

  result = await agent.invoke(
    new Command({ resume: { decisions } }),
    config        // 必须用同一 config
  );
}
```

### 12.4 编辑参数

```typescript
const decisions = [{
  type: "edit",
  editedAction: {
    name: actionRequest.name,
    args: { to: "team@company.com", subject: "...", body: "..." }
  }
}];
```

### 12.5 子 Agent 中断
子 Agent 可在工具内直接调用 `interrupt()` 暂停：

```typescript
import { interrupt, Command } from "@langchain/langgraph";

const requestApproval = tool(
  async ({ actionDescription }: { actionDescription: string }) => {
    const approval = interrupt({
      type: "approval_request",
      action: actionDescription,
      message: `Please approve or reject: ${actionDescription}`,
    }) as { approved?: boolean; reason?: string };

    return approval.approved
      ? `Action '${actionDescription}' was APPROVED.`
      : `Action '${actionDescription}' was REJECTED. Reason: ${approval.reason || "none"}`;
  },
  {
    name: "request_approval",
    description: "Request human approval before proceeding with an action.",
    schema: z.object({ actionDescription: z.string() }),
  }
);

// 恢复
const result2 = await parentAgent.invoke(
  new Command({ resume: { approved: true } }),
  config
);
```

### 12.6 多工具调用
全部 interrupt 被打包成一个，要按 `actionRequests` 的顺序提供同样多的 decisions。

---

## 13. 记忆（Memory）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/memory

记忆 = 文件系统中的文件 + 你选择的后端控制存储位置与权限。

### 13.1 工作流
1. 通过 `memory` 参数传文件路径
2. Agent 启动时把这些文件灌进系统 prompt（或运行中按需读取）
3. Agent 用 `edit_file` 自我更新（也可后台 consolidation）

### 13.2 Agent 作用域（共享身份）

```typescript
import { createDeepAgent, CompositeBackend, StateBackend, StoreBackend } from "deepagents";

const agent = createDeepAgent({
  memory: ["/memories/AGENTS.md"],
  skills: ["/skills/"],
  backend: new CompositeBackend(
    new StateBackend(),
    {
      "/memories/": new StoreBackend({
        namespace: (ctx) => [ctx.runtime.serverInfo.assistantId],
      }),
      "/skills/": new StoreBackend({
        namespace: (ctx) => [ctx.runtime.serverInfo.assistantId],
      }),
    },
  ),
});
```

### 13.3 用户作用域（每个用户独立）

```typescript
const agent = createDeepAgent({
  memory: ["/memories/preferences.md"],
  skills: ["/skills/"],
  backend: new CompositeBackend(
    new StateBackend(),
    {
      "/memories/": new StoreBackend({
        namespace: (ctx) => [ctx.runtime.context.userId],
      }),
      "/skills/": new StoreBackend({
        namespace: (ctx) => [ctx.runtime.context.userId],
      }),
    },
  ),
});
```

### 13.4 完整示例：seed + 多用户

```typescript
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { createDeepAgent, CompositeBackend, StateBackend, StoreBackend, createFileData } from "deepagents";
import { InMemoryStore } from "@langchain/langgraph";

const contextSchema = z.object({ userId: z.string() });
const store = new InMemoryStore();

await store.put(["user-alice"], "/memories/preferences.md", createFileData(`## Preferences
- Likes concise bullet points
- Prefers Python examples
`));

await store.put(["user-bob"], "/memories/preferences.md", createFileData(`## Preferences
- Likes detailed explanations
- Prefers TypeScript examples
`));

const agent = createDeepAgent({
  memory: ["/memories/preferences.md"],
  skills: ["/skills/"],
  contextSchema,
  backend: (rt) => new CompositeBackend(
    new StateBackend(rt),
    {
      "/memories/": new StoreBackend(rt, { namespace: (ctx) => [ctx.runtime.context.userId] }),
      "/skills/": new StoreBackend(rt, { namespace: (ctx) => [ctx.runtime.context.userId] }),
    },
  ),
  store,
});

await agent.invoke(
  { messages: [{ role: "user", content: "How do I read a CSV file?" }] },
  { configurable: { thread_id: uuidv4() } },
  { context: { userId: "user-alice" } },
);
```

### 13.5 进阶
| 维度 | 选项 |
| --- | --- |
| 时长 | 短期（单会话）/ 长期（跨会话） |
| 类型 | episodic（经历）/ procedural（流程，由 skills 承载）/ semantic（事实） |
| 作用域 | user / assistant / organization |
| 写入时机 | 对话中 / 后台合并 |
| 检索 | 进 prompt / 按需 |
| 权限 | 读写 / 只读 |

### 13.6 情节记忆（episodic）
利用 checkpointer 的 thread 列表 + 一个搜索工具：

```typescript
import { Client } from "@langchain/langgraph-sdk";
import { tool } from "@langchain/core/tools";

const client = new Client({ apiUrl: "<DEPLOYMENT_URL>" });

const searchPastConversations = tool(
  async ({ query }, runtime) => {
    const userId = runtime.serverInfo.user.identity;
    const threads = await client.threads.search({
      metadata: { userId },
      limit: 5,
    });
    const results = [];
    for (const thread of threads) {
      const history = await client.threads.getHistory(thread.threadId);
      results.push(history);
    }
    return JSON.stringify(results);
  },
  {
    name: "search_past_conversations",
    description: "Search past conversations for relevant context.",
  }
);
```

### 13.7 后台合并（sleep time compute）
另起一个 deep agent，cron 周期内读取最近会话、提炼事实、合并到 memory store。注意 cron 间隔与查询 lookback 窗口要一致。

---

## 14. 技能（Skills）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/skills

要求：`deepagents>=1.7.0`，遵循 [Agent Skills 标准](https://agentskills.io/specification)。

### 14.1 结构
```
skills/
├── langgraph-docs
│   └── SKILL.md
└── arxiv_search
    ├── SKILL.md
    └── arxiv_search.ts
```

`SKILL.md` 必有 frontmatter：
```yaml
---
name: langgraph-docs
description: Use this skill for requests related to LangGraph in order to fetch relevant documentation.
license: MIT
compatibility: Requires internet access
metadata:
  author: langchain
  version: "1.0"
allowed-tools: fetch_url
---
```

约束：`description` 截断到 1024 字符；`SKILL.md` 单文件 < 10 MB。

### 14.2 工作原理（progressive disclosure）
启动时只读所有 SKILL.md 的 frontmatter；命中后才读完整内容；最后按指令执行。

### 14.3 使用 — StateBackend

```typescript
import { createDeepAgent, type FileData } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();

function createFileData(content: string): FileData {
  const now = new Date().toISOString();
  return { content: content.split("\n"), created_at: now, modified_at: now };
}

const skillsFiles: Record<string, FileData> = {};

const skillUrl = "https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/examples/skills/langgraph-docs/SKILL.md";
const response = await fetch(skillUrl);
const skillContent = await response.text();
skillsFiles["/skills/langgraph-docs/SKILL.md"] = createFileData(skillContent);

const agent = await createDeepAgent({
  checkpointer,
  skills: ["/skills/"],   // 注意是虚拟 POSIX 路径
});

const result = await agent.invoke(
  {
    messages: [{ role: "user", content: "what is langgraph? Use the langgraph-docs skill if available." }],
    files: skillsFiles,
  },
  { configurable: { thread_id: `thread-${Date.now()}` } },
);
```

### 14.4 使用 — StoreBackend

```typescript
import { createDeepAgent, StoreBackend, type FileData } from "deepagents";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();
const store = new InMemoryStore();

await store.put(["filesystem"], "/skills/langgraph-docs/SKILL.md", createFileData(skillContent));

const agent = await createDeepAgent({
  backend: new StoreBackend(),
  store,
  checkpointer,
  skills: ["/skills/"],
});
```

### 14.5 使用 — FilesystemBackend

```typescript
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();
const backend = new FilesystemBackend({ rootDir: process.cwd() });

const agent = await createDeepAgent({
  backend,
  skills: ["./examples/skills/"],
  interruptOn: { read_file: true, write_file: true, delete_file: true },
  checkpointer,
});
```

### 14.6 源优先级
`skills: [A, B]`，B 中同名技能覆盖 A。SDK 不会自动扫描 `~/.deepagents/...`，需要 CLI 风格层叠就显式传所有路径。

### 14.7 子 Agent 技能
- general-purpose 子 Agent 自动继承
- 自定义子 Agent 不继承，自己传 `skills`

### 14.8 沙箱中执行技能脚本
当 skills 文件在 StoreBackend 中、代码运行在 sandbox 时，需要中间件在 `beforeAgent` hook 把技能脚本上传到 sandbox。完整流程见原文。

### 14.9 Skills vs. Memory
| | Skills | Memory |
| --- | --- | --- |
| 目的 | 按需能力 | 永久上下文 |
| 加载时机 | 命中才加载 | 启动总注入 |
| 文件 | `SKILL.md` | `AGENTS.md` |
| 适用 | 大型/任务相关流程 | 通用偏好/约定 |

---

## 15. 沙箱（Sandboxes）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/sandboxes

沙箱是一种特殊的 backend：在文件系统工具之外**额外暴露 `execute` 工具**，把 Agent 与 host 系统隔离。

### 15.1 基础用法

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { DenoSandbox } from "@langchain/deno";

const sandbox = await DenoSandbox.create({ memoryMb: 1024, lifetime: "10m" });

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-opus-4-6" }),
    systemPrompt: "You are a JavaScript coding assistant with sandbox access.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Create a simple HTTP server using Deno.serve and test it with curl" }],
  });
} finally {
  await sandbox.close();
}
```

### 15.2 支持的提供商
Modal、Daytona、Deno、Node VFS、LangSmith。要使用其他需要按 `BaseSandbox` 协议实现 `execute()` 方法（`read/write/edit/ls/glob/grep` 由基类基于 `execute()` 自动生成）。

### 15.3 生命周期
- **Thread-scoped（默认）**：每会话一个，TTL 清理
- **Assistant-scoped**：所有会话共享同一沙箱，保留克隆仓库 / 已装依赖

```typescript
import { Daytona } from "@daytonaio/sdk";
import { DaytonaSandbox } from "@langchain/daytona";

const client = new Daytona();
const threadId = randomUUID();
let sandbox;
try {
  sandbox = await client.findOne({ labels: { thread_id: threadId } });
} catch {
  sandbox = await client.create({
    labels: { thread_id: threadId },
    autoDeleteInterval: 3600,
  });
}
const backend = await DaytonaSandbox.fromId(sandbox.id);
```

### 15.4 两种集成模式
- **Agent in sandbox**：Agent 进程跑在 sandbox 中；优点贴近本地开发；缺点 API Key 必须在 sandbox 内（风险大）
- **Sandbox as tool（推荐）**：Agent 在 host，工具调用通过 SDK 进 sandbox；API Key 留在 host，agent 状态独立

### 15.5 两个文件平面
- **Agent 文件系统工具**：`read_file / write_file / edit_file / ls / glob / grep / execute` 是 LLM 的工具
- **文件传输 API**：`uploadFiles() / downloadFiles()` 是你的应用代码用的，用于种子文件 / 取回产物

```typescript
const encoder = new TextEncoder();
await sandbox.uploadFiles([
  ["src/index.js", encoder.encode("console.log('Hello')")],
  ["package.json", encoder.encode('{"name": "my-app"}')],
]);

const results = await sandbox.downloadFiles(["src/index.js", "output.txt"]);
const decoder = new TextDecoder();
for (const r of results) {
  if (r.content) console.log(`${r.path}: ${decoder.decode(r.content)}`);
}
```

### 15.6 安全
**永远不要把 secrets 放进 sandbox**。沙箱隔离 host，但不能防 prompt injection 在 sandbox 内执行任意命令。推荐：
1. 凭据相关的工具放 host，agent 只看到工具名
2. 用 auth proxy 在出站请求上注入凭据（部分提供商）
3. 必要时禁用 sandbox 网络（如 Modal 的 `blockNetwork: true`）
4. 全部工具调用都过 human-in-the-loop

---

## 16. 流式输出（Streaming）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/streaming

Deep Agent 基于 LangGraph 流式基础设施，**首要特性是子图（subgraph）流**：每个子 Agent 独立可流。

### 16.1 启用 subgraph 流

```typescript
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt: "You are a helpful research assistant",
  subagents: [
    { name: "researcher", description: "Researches a topic in depth", systemPrompt: "You are a thorough researcher." },
  ],
});

for await (const [namespace, chunk] of await agent.stream(
  { messages: [{ role: "user", content: "Research quantum computing advances" }] },
  { streamMode: "updates", subgraphs: true }
)) {
  if (namespace.length > 0) console.log(`[subagent: ${namespace.join("|")}]`, chunk);
  else console.log("[main agent]", chunk);
}
```

### 16.2 命名空间
| Namespace | 来源 |
| --- | --- |
| `()` | 主 Agent |
| `("tools:abc123",)` | 主 Agent task 工具派发的子 Agent |
| `("tools:abc123", "model_request:def456")` | 子 Agent 内的 model_request |

### 16.3 4 种流模式

| 模式 | 用途 |
| --- | --- |
| `updates` | 每个节点完成后的状态更新（最常用） |
| `messages` | LLM token 级流 |
| `messages` + tool_call_chunks | 工具调用与结果 |
| `custom` | 工具内用 `config.writer({...})` 发自定义事件 |

### 16.4 LLM token 流示例

```typescript
let currentSource = "";
for await (const [namespace, chunk] of await agent.stream(
  { messages: [{ role: "user", content: "Research quantum computing advances" }] },
  { streamMode: "messages", subgraphs: true },
)) {
  const [message] = chunk;
  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));
  const source = isSubagent ? namespace.find((s: string) => s.startsWith("tools:"))! : "main";
  if (source !== currentSource) {
    process.stdout.write(`\n\n--- [${source}] ---\n`);
    currentSource = source;
  }
  if (message.text) process.stdout.write(message.text);
}
```

### 16.5 工具调用 + 工具结果流

```typescript
import { AIMessageChunk, ToolMessage } from "langchain";

for await (const [namespace, chunk] of await agent.stream(
  { messages: [{ role: "user", content: "Research recent quantum computing advances" }] },
  { streamMode: "messages", subgraphs: true },
)) {
  const [message] = chunk;
  if (AIMessageChunk.isInstance(message) && message.tool_call_chunks?.length) {
    for (const tc of message.tool_call_chunks) {
      if (tc.name) console.log(`Tool call: ${tc.name}`);
      if (tc.args) process.stdout.write(tc.args);
    }
  }
  if (ToolMessage.isInstance(message)) {
    console.log(`Tool result [${message.name}]: ${message.text?.slice(0, 150)}`);
  }
}
```

### 16.6 自定义事件

```typescript
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

const analyzeData = tool(
  async ({ topic }: { topic: string }, config: ToolRuntime) => {
    const writer = config.writer;
    writer?.({ status: "starting", topic, progress: 0 });
    await new Promise((r) => setTimeout(r, 500));
    writer?.({ status: "analyzing", progress: 50 });
    await new Promise((r) => setTimeout(r, 500));
    writer?.({ status: "complete", progress: 100 });
    return `Analysis of "${topic}": ...`;
  },
  {
    name: "analyze_data",
    description: "Run a data analysis on a given topic",
    schema: z.object({ topic: z.string() }),
  },
);

for await (const [namespace, chunk] of await agent.stream(
  { messages: [{ role: "user", content: "Analyze customer satisfaction trends" }] },
  { streamMode: "custom", subgraphs: true },
)) { console.log(namespace, chunk); }
```

### 16.7 多模式组合
`streamMode: ["updates", "messages", "custom"]` + `subgraphs: true`，元组是 `[namespace, mode, data]`。

---

## 17. 前端概览（Frontend Overview）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/frontend/overview

Deep Agent 采用 coordinator-worker 架构。前端通过 `useStream` 同时拿到协调者消息与每个子 Agent 的流式状态。

```typescript
import { useStream } from "@langchain/react";

function App() {
  const stream = useStream<typeof agent>({
    apiUrl: "http://localhost:2024",
    assistantId: "agent",
  });

  const todos = stream.values?.todos;
  const subagents = stream.subagents;
}
```

LangChain 通用前端模式（markdown、tool calling、HITL）都兼容 Deep Agent。

---

## 18. 前端：子 Agent 流式渲染

**原文：** https://docs.langchain.com/oss/javascript/deepagents/frontend/subagent-streaming

### 18.1 关键配置
**总是设置 `filterSubagentMessages: true`**，否则子 Agent token 会和主 Agent 混在一起。

```typescript
import { useStream } from "@langchain/react";
import type { myAgent } from "./agent";

export function DeepAgentChat() {
  const stream = useStream<typeof myAgent>({
    apiUrl: "http://localhost:2024",
    assistantId: "deep_agent_subagent_cards",
    filterSubagentMessages: true,
  });

  return (
    <div>
      {stream.messages.map((msg) => (
        <MessageWithSubagents
          key={msg.id}
          message={msg}
          subagents={stream.getSubagentsByMessage(msg.id)}
        />
      ))}
    </div>
  );
}
```

提交时启用 subgraph：
```typescript
stream.submit(
  { messages: [{ type: "human", content: text }] },
  { streamSubgraphs: true }
);
```

### 18.2 SubagentStreamInterface

```typescript
interface SubagentStreamInterface {
  id: string;
  status: "pending" | "running" | "complete" | "error";
  messages: BaseMessage[];
  result: string | undefined;
  toolCall: {
    id: string;
    name: string;
    args: { description: string; subagent_type: string; [key: string]: unknown };
  };
  startedAt: number | undefined;
  completedAt: number | undefined;
}
```

### 18.3 子 Agent 卡片组件

```typescript
import { AIMessage } from "@langchain/core/messages";

function SubagentCard({ subagent }: { subagent: SubagentStreamInterface }) {
  const [expanded, setExpanded] = useState(true);
  const title = subagent.toolCall?.args?.subagent_type ?? `Agent ${subagent.id}`;
  const description = subagent.toolCall?.args?.description ?? "";
  const lastAIMessage = subagent.messages.filter(AIMessage.isInstance).at(-1);
  const displayContent = subagent.status === "complete"
    ? subagent.result
    : typeof lastAIMessage?.content === "string" ? lastAIMessage.content : "";

  const elapsed = getElapsedTime(subagent.startedAt, subagent.completedAt);

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <StatusIcon status={subagent.status} />
          <div>
            <h4 className="font-semibold capitalize">{title}</h4>
            <p className="text-xs text-gray-500">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {elapsed && <span className="text-xs text-gray-400">{elapsed}</span>}
          <StatusBadge status={subagent.status} />
        </div>
      </button>
      {expanded && displayContent && (
        <div className="border-t px-4 py-3">
          <div className="prose prose-sm max-w-none line-clamp-6">
            {displayContent}
            {subagent.status === "running" && <span className="inline-block h-4 w-1 animate-pulse bg-blue-500" />}
          </div>
        </div>
      )}
    </div>
  );
}
```

### 18.4 综合：消息 + 子 Agent 卡片

```typescript
function MessageWithSubagents({ message, subagents }: { message: BaseMessage; subagents: SubagentStreamInterface[] }) {
  if (message.type === "human") return <HumanMessage content={message.content} />;
  return (
    <div className="space-y-3">
      {message.content && <div className="prose prose-sm max-w-none">{message.content}</div>}
      {subagents.length > 0 && (
        <div className="ml-4 space-y-3 border-l-2 border-blue-200 pl-4">
          <SubagentProgress subagents={subagents} />
          {subagents.map((subagent) => <SubagentCard key={subagent.id} subagent={subagent} />)}
        </div>
      )}
    </div>
  );
}
```

### 18.5 最佳实践
- 总是 `filterSubagentMessages: true`
- 显示 `toolCall.args.description`
- 5+ 子 Agent 时自动折叠完成项
- 显示耗时
- `recursionLimit` 设大点（10000）
- 单个子 Agent 失败不要让整个 UI 崩

---

## 19. 前端：Todo 列表

**原文：** https://docs.langchain.com/oss/javascript/deepagents/frontend/todo-list

Agent 用 `write_todos` 维护的 todo 数组通过 `stream.values.todos` 暴露。

```typescript
interface Todo {
  status: "pending" | "in_progress" | "completed";
  content: string;
}
```

### 19.1 基础用法

```typescript
import { useStream } from "@langchain/react";
import type { myAgent } from "./agent";

export function TodoAgent() {
  const stream = useStream<typeof myAgent>({
    apiUrl: "http://localhost:2024",
    assistantId: "deep_agent_todo_list",
  });
  const todos = stream.values?.todos ?? [];
  return (
    <div>
      <TodoList todos={todos} />
      {stream.messages.map((msg) => <Message key={msg.id} message={msg} />)}
    </div>
  );
}
```

### 19.2 TodoItem 组件

```typescript
function TodoItem({ todo }: { todo: Todo }) {
  const config = {
    pending: { icon: "○", textClass: "text-gray-600", bgClass: "bg-gray-50", iconClass: "text-gray-400" },
    in_progress: { icon: "◉", textClass: "text-amber-800", bgClass: "bg-amber-50 border-amber-200", iconClass: "text-amber-500 animate-pulse" },
    completed: { icon: "✓", textClass: "text-green-800 line-through", bgClass: "bg-green-50 border-green-200", iconClass: "text-green-500" },
  };
  const style = config[todo.status];
  return (
    <li className={`flex items-start gap-3 rounded-md border px-3 py-2 ${style.bgClass}`}>
      <span className={`mt-0.5 text-lg leading-none ${style.iconClass}`}>{style.icon}</span>
      <span className={`text-sm ${style.textClass}`}>{todo.content}</span>
    </li>
  );
}
```

### 19.3 同样的思路适用于
`stream.values` 可以暴露任意自定义状态：`stream.values.document`、`stream.values.sources`、`stream.values.confidence_score` 等。

### 19.4 最佳实践
- 显著位置展示
- 平滑过渡动画
- 同时只高亮一个 in_progress
- 完成项淡化
- 显示百分比

---

## 20. 协议：ACP（Agent Client Protocol）

**原文：** https://docs.langchain.com/oss/javascript/deepagents/acp

ACP 是 Agent ↔ 编辑器/IDE 通信的标准协议。`deepagents-acp` 包同时提供 CLI 与编程 API。

### 20.1 最快上手

```bash
npm install deepagents-acp
```

```typescript
import { startServer } from "deepagents-acp";

await startServer({
  agents: {
    name: "coding-assistant",
    description: "AI coding assistant with filesystem access",
  },
  workspaceRoot: process.cwd(),
});
```

或者直接命令行：
```bash
npx deepagents-acp
```

### 20.2 客户端
Zed、JetBrains IDE、VS Code（via vscode-acp）、Neovim。

### 20.3 Zed 集成示例

```json
{
  "agent": {
    "profiles": {
      "deepagents": {
        "name": "DeepAgents",
        "command": "npx",
        "args": ["deepagents-acp", "--name", "my-assistant", "--skills", "./skills", "--debug"],
        "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
      }
    }
  }
}
```

### 20.4 CLI 参数

| 参数 | 短写 | 说明 |
| --- | --- | --- |
| `--name <n>` | `-n` | Agent 名（默认 `"deepagents"`） |
| `--description <d>` | `-d` | 描述 |
| `--model <m>` | `-m` | 默认 `"claude-sonnet-4-5-20250929"` |
| `--workspace <p>` | `-w` | 工作目录 |
| `--skills <p>` | `-s` | 技能路径，逗号分隔 |
| `--memory <p>` | | AGENTS.md 路径，逗号分隔 |
| `--debug` | | stderr 调试日志 |

环境变量：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEBUG`、`WORKSPACE_ROOT`。

### 20.5 编程 API（DeepAgentsServer）

```typescript
import { DeepAgentsServer } from "deepagents-acp";

const server = new DeepAgentsServer({
  agents: [
    {
      name: "code-agent",
      description: "Full-featured coding assistant",
      model: "claude-sonnet-4-5-20250929",
      skills: ["./skills/"],
      memory: ["./.deepagents/AGENTS.md"],
    },
    {
      name: "reviewer",
      description: "Code review specialist",
      systemPrompt: "You are a code review expert...",
    },
  ],
  serverName: "my-deepagents-acp",
  serverVersion: "1.0.0",
  workspaceRoot: process.cwd(),
  debug: true,
});

await server.start();
```

### 20.6 自定义 slash 命令、人审、工具、后端

```typescript
const server = new DeepAgentsServer({
  agents: {
    name: "my-agent",
    commands: [
      { name: "test", description: "Run the project's test suite" },
      { name: "lint", description: "Run linter and fix issues" },
      { name: "deploy", description: "Deploy to staging", input: { hint: "environment" } },
    ],
    interruptOn: {
      execute: { allowedDecisions: ["approve", "edit", "reject"] },
      write_file: true,
    },
    tools: [searchTool],
    backend: new CompositeBackend({
      routes: [
        { prefix: "/workspace", backend: new FilesystemBackend({ rootDir: "./workspace" }) },
        { prefix: "/", backend: (config) => new StateBackend(config) },
      ],
    }),
  },
});
```

内置 slash 命令：`/plan`、`/agent`、`/ask`、`/clear`、`/status`。

---

## 21. CLI 使用指南

**原文：** https://docs.langchain.com/oss/javascript/deepagents/cli/overview

Deep Agents CLI 是基于 SDK 的开源终端编码 agent，自带：文件操作、shell 执行、Web 搜索、HTTP 请求、规划/追踪、记忆、上下文压缩、人审、技能、MCP 工具、LangSmith 追踪。

> CLI 在 Windows 上未官方支持，建议在 WSL 中使用。

### 21.1 内置工具

| 工具 | 是否需人审 |
| --- | --- |
| `ls / read_file / glob / grep / write_todos / ask_user` | 否 |
| `write_file / edit_file / execute / web_search / fetch_url / task` | 是（除非 `-y`） |
| `compact_conversation` | 混合 |

### 21.2 快速开始

```bash
export ANTHROPIC_API_KEY="your-api-key"
curl -LsSf https://raw.githubusercontent.com/langchain-ai/deepagents/refs/heads/main/libs/cli/scripts/install.sh | bash
deepagents
```

### 21.3 交互模式 slash 命令
`/model`、`/remember`、`/skill:<name>`、`/skill-creator`、`/offload`、`/tokens`、`/clear`、`/threads`、`/mcp`、`/reload`、`/theme`、`/update`、`/auto-update`、`/trace`、`/editor`、`/changelog`、`/docs`、`/feedback`、`/version`、`/help`、`/quit`。

按 `!` 进入 shell 模式。

### 21.4 键盘快捷键
- `Enter` 提交；`Shift+Enter` 换行
- `@filename` 文件自动补全
- `Shift+Tab` 切换 auto-approve
- `Ctrl+X` 外部编辑器
- `Ctrl+O` 展开/折叠最近工具输出
- `Escape / Ctrl+C / Ctrl+D` 中断/退出

### 21.5 非交互模式 + 管道

```bash
deepagents -n "Write a Python script that prints hello world"
echo "Explain this code" | deepagents
cat error.log | deepagents -n "What's causing this error?"
git diff | deepagents --skill code-review -n 'summarize changes'

# 干净输出（适合管道）
deepagents -n "Generate a .gitignore for Python" -q > .gitignore
deepagents -n "List dependencies" -q --no-stream | sort

# Shell 白名单
deepagents -n "Run the tests" -S "pytest,git,make"
deepagents -n "Build the project" -S recommended
deepagents -n "Fix the build" -S all   # ⚠️ 任意命令
```

非交互模式下 shell 默认禁用，必须 `-S` 才能用。

### 21.6 切换模型
```bash
deepagents --model openai:gpt-5.4
# 会话中
> /model anthropic:claude-opus-4-6
> /model openai:gpt-5.4
```
`--model-params '{"temperature":0.7}'` 传额外构造参数。

### 21.7 记忆
- 自动记忆：`~/.deepagents/<agent>/memories/*.md`
- 全局 `AGENTS.md`：`~/.deepagents/<agent>/AGENTS.md`
- 项目 `AGENTS.md`：`.deepagents/AGENTS.md`（项目根需有 `.git`）

`/remember` 显式让 agent 提炼记忆。

### 21.8 技能

```bash
# 创建技能
deepagents skills create test-skill
deepagents skills create test-skill --project

# 列出
deepagents skills list
deepagents skills list --project
deepagents skills info test-skill
```

社区技能（Vercel Skills CLI）：
```bash
npx skills add vercel-labs/agent-skills --skill web-design-guidelines -a deepagents -g -y
```

技能发现目录：
```
~/.deepagents/<agent_name>/skills/
~/.agents/skills/
.deepagents/skills/
.agents/skills/
~/.claude/skills/   (实验)
.claude/skills/     (实验)
```

启动时调用技能：`deepagents --skill code-review -m 'review the auth module'`

### 21.9 子 Agent
项目级：`.deepagents/agents/{name}/AGENTS.md`，用户级：`~/.deepagents/{agent}/agents/{name}/AGENTS.md`。frontmatter 要 `name`、`description`，可选 `model`。

例：用更便宜模型覆盖 general-purpose：
```markdown
---
name: general-purpose
description: General-purpose agent for research and multi-step tasks
model: anthropic:claude-haiku-4-5-20251001
---

You are a general-purpose assistant. Complete the task efficiently and return a concise summary.
```

### 21.10 远程沙箱
`--sandbox langsmith|agentcore|modal|daytona|runloop`，`--sandbox-id` 复用、`--sandbox-setup ./setup.sh` 启动后跑脚本。

### 21.11 LangSmith 追踪
```env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=optional-project-name
DEEPAGENTS_CLI_LANGSMITH_PROJECT=my-agent-traces  # 与父应用拆分
```

### 21.12 命令参考

| 命令 | 说明 |
| --- | --- |
| `deepagents agents list` | 列所有 agent |
| `deepagents agents reset --agent NAME` | 重置 |
| `deepagents skills list / create / info / delete` | 技能管理 |
| `deepagents threads list / delete` | 会话管理 |
| `deepagents deploy` | 部署到 LangSmith |
| `deepagents update` | 检查更新 |

CLI 选项：`-a/--agent`、`-M/--model`、`--model-params`、`-r/--resume`、`-m/--message`、`-n/--non-interactive`、`-q/--quiet`、`--no-stream`、`-y/--auto-approve`、`-S/--shell-allow-list`、`--json`、`--sandbox`、`--mcp-config`、`--no-mcp`、`--profile-override`、`--acp`。

---

## 22. CLI 模型提供商

**原文：** https://docs.langchain.com/oss/javascript/deepagents/cli/providers

OpenAI / Anthropic / Google 默认安装；其他作为可选 extra：

```bash
uv tool install 'deepagents-cli[anthropic,openai,groq]'
uv tool upgrade deepagents-cli --with langchain-ollama
# 全装
uv tool install 'deepagents-cli[anthropic,bedrock,cohere,deepseek,fireworks,google-genai,groq,huggingface,ibm,mistralai,nvidia,ollama,openai,openrouter,perplexity,vertexai,xai]'
```

### 22.1 内置提供商表

| Provider | Package | Env Var | Profile |
| --- | --- | --- | --- |
| OpenAI | `langchain-openai` | `OPENAI_API_KEY` | ✅ |
| Anthropic | `langchain-anthropic` | `ANTHROPIC_API_KEY` | ✅ |
| Google Gemini | `langchain-google-genai` | `GOOGLE_API_KEY` | ✅ |
| Vertex AI | `langchain-google-vertexai` | `GOOGLE_CLOUD_PROJECT` | ✅ |
| AWS Bedrock | `langchain-aws` | `AWS_ACCESS_KEY_ID` | ✅ |
| Ollama | `langchain-ollama` | 可选 | ❌ |
| Groq | `langchain-groq` | `GROQ_API_KEY` | ✅ |
| Cohere | `langchain-cohere` | `COHERE_API_KEY` | ❌ |
| Fireworks | `langchain-fireworks` | `FIREWORKS_API_KEY` | ✅ |
| DeepSeek | `langchain-deepseek` | `DEEPSEEK_API_KEY` | ✅ |
| xAI | `langchain-xai` | `XAI_API_KEY` | ✅ |
| Perplexity | `langchain-perplexity` | `PPLX_API_KEY` | ✅ |

### 22.2 解析顺序
`--model` flag > `[models].default` > `[models].recent` > 环境自动检测（OPENAI_API_KEY → ANTHROPIC_API_KEY → GOOGLE_API_KEY → GOOGLE_CLOUD_PROJECT）。

### 22.3 config.toml

```toml
[models]
default = "ollama:qwen3:4b"
recent = "anthropic:claude-sonnet-4-5"

[models.providers.ollama]
models = ["llama3", "mistral", "codellama"]
api_key_env = "OLLAMA_API_KEY"
base_url = "http://localhost:11434"

[models.providers.ollama.params]
temperature = 0
num_ctx = 8192

[models.providers.ollama.params."qwen3:4b"]
temperature = 0.5
num_ctx = 4000

[models.providers.anthropic.profile]
max_input_tokens = 4096

[models.providers.anthropic.profile."claude-sonnet-4-5"]
max_input_tokens = 8192
```

### 22.4 模型路由器
OpenRouter：`uv tool install 'deepagents-cli[openrouter]'`。

兼容 OpenAI / Anthropic 接口的服务，直接复用其包：
```toml
[models.providers.openai]
base_url = "https://api.example.com/v1"
api_key_env = "EXAMPLE_API_KEY"
models = ["my-model"]
```

### 22.5 任意模型（class_path）
```toml
[models.providers.my_custom]
class_path = "my_package.models:MyChatModel"
api_key_env = "MY_API_KEY"
base_url = "https://my-endpoint.example.com"

[models.providers.my_custom.params]
temperature = 0
max_tokens = 4096
```

切换：`/model my_custom:my-model-v1`。⚠️ `class_path` 会执行任意 Python 代码。

---

## 23. CLI 配置

**原文：** https://docs.langchain.com/oss/javascript/deepagents/cli/configuration

配置文件：

| 文件 | 格式 | 用途 |
| --- | --- | --- |
| `~/.deepagents/config.toml` | TOML | 模型默认、Provider、主题、更新、MCP trust |
| `~/.deepagents/.env` | Dotenv | API key |
| `~/.deepagents/hooks.json` | JSON | 生命周期钩子 |
| `~/.deepagents/.mcp.json` | JSON | 全局 MCP |

### 23.1 .env 优先级
shell env > 项目 .env > 全局 .env。已 export 的 shell 变量永不被覆盖（包括 `/reload`）。

### 23.2 DEEPAGENTS_CLI_ 前缀
所有 CLI 专属变量用 `DEEPAGENTS_CLI_` 前缀。该前缀也是覆盖第三方凭据的方式：
```env
# 仅给 CLI 用单独的 key
DEEPAGENTS_CLI_OPENAI_API_KEY=sk-cli-only

# 屏蔽 shell 已 export 的 key
DEEPAGENTS_CLI_ANTHROPIC_API_KEY=
```

### 23.3 主题
`/theme` 打开交互选择器；自定义：
```toml
[themes.my-solarized]
label = "My Solarized"
dark = true
primary = "#268BD2"
warning = "#B58900"

[themes.langchain]
primary = "#FF5500"   # 覆盖内置主题颜色
```

### 23.4 自动更新
```toml
[update]
auto_update = true
```
或 `DEEPAGENTS_CLI_AUTO_UPDATE=1`。`/update` 手动检查；`/auto-update` 切换。

### 23.5 Hooks（生命周期钩子）
`~/.deepagents/hooks.json`：
```json
{
  "hooks": [
    {
      "command": ["bash", "-c", "cat >> ~/deepagents-events.log"],
      "events": ["session.start", "session.end"]
    },
    {
      "command": ["python3", "my_handler.py"],
      "events": ["session.start", "task.complete"]
    }
  ]
}
```

事件类型：`session.start`、`session.end`、`user.prompt`、`input.required`、`permission.request`、`tool.error`、`task.complete`、`context.compact`。

负载（stdin JSON）：
```json
{ "event": "session.start", "thread_id": "abc123" }
```

执行模型：后台线程，并发派发，5 秒超时，fire-and-forget，配置懒加载并缓存到会话末。命令直接执行不经 shell，需 pipe 用 `["bash", "-c", "..."]`。

macOS 通知示例：
```json
{
  "hooks": [
    {
      "command": [
        "bash", "-c",
        "osascript -e 'display notification \"Agent finished\" with title \"Deep Agents\"'"
      ],
      "events": ["task.complete"]
    }
  ]
}
```

### 23.6 外部编辑器
按 `Ctrl+X` 或 `/editor`，按顺序检查 `$VISUAL` → `$EDITOR` → `vi`/`notepad`。GUI 编辑器（VS Code、Cursor、Zed、Sublime、Windsurf）自动注入 `--wait`。

### 23.7 完整环境变量参考
`DEEPAGENTS_CLI_AUTO_UPDATE`、`DEEPAGENTS_CLI_DEBUG`、`DEEPAGENTS_CLI_DEBUG_FILE`、`DEEPAGENTS_CLI_EXTRA_SKILLS_DIRS`、`DEEPAGENTS_CLI_LANGSMITH_PROJECT`、`DEEPAGENTS_CLI_NO_UPDATE_CHECK`、`DEEPAGENTS_CLI_SHELL_ALLOW_LIST`、`DEEPAGENTS_CLI_USER_ID`。

---

## 24. CLI MCP 工具

**原文：** https://docs.langchain.com/oss/javascript/deepagents/cli/mcp-tools

通过 MCP 把外部工具接入 CLI。

### 24.1 配置文件

`.mcp.json`（项目根）：
```json
{
  "mcpServers": {
    "docs-langchain": {
      "type": "http",
      "url": "https://docs.langchain.com/mcp"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "your-token" }
    },
    "remote-api": {
      "type": "sse",
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

### 24.2 自动发现优先级（低 → 高）
1. `~/.deepagents/.mcp.json`（用户级）
2. `<project>/.deepagents/.mcp.json`
3. `<project>/.mcp.json`（Claude Code 兼容）

项目根通过最近的 `.git` 目录确定。同名 server 高优先级覆盖低优先级。

### 24.3 标志
- `--mcp-config PATH`：显式追加，最高优先级
- `--no-mcp`：完全禁用
- `--trust-project-mcp`：信任项目级 stdio servers，跳过审批（适合 CI）

### 24.4 项目级 trust 模型
项目 stdio server 默认被拒；交互模式弹审批对话框；非交互模式静默跳过除非 `--trust-project-mcp`。审批后用 SHA-256 fingerprint 持久化到 `config.toml` 中 `[mcp_trust.projects]`，配置改动即失效。

### 24.5 三种 server 类型

| Type | 必填 | 选填 |
| --- | --- | --- |
| stdio（默认） | `command` | `args`、`env` |
| sse | `type: "sse"`、`url` | `headers` |
| http | `type: "http"`、`url` | `headers` |

`type` 也可以写作 `transport`。

---

## 25. CLI 数据存放位置

**原文：** https://docs.langchain.com/oss/javascript/deepagents/data-locations

```
~/.deepagents/
├── .state/                  # 由 CLI 管理
│   ├── sessions.db          # SQLite checkpoint
│   ├── history.jsonl        # 输入历史
│   └── ...                  # 标记 & 凭据
└── {agent}/                 # 每个 agent 一个子目录（默认 "agent"）
    ├── AGENTS.md            # 用户自定义指令
    ├── skills/              # 用户级 skills
    │   └── {skill-name}/SKILL.md
    └── agents/              # 自定义 subagent
        └── {subagent-name}/AGENTS.md

~/.agents/                   # 工具无关，跨 AI CLI 共享
└── skills/
    └── {skill-name}/SKILL.md

{project}/
├── AGENTS.md                # 项目根指令
└── .deepagents/
    ├── AGENTS.md            # 项目首选位置
    ├── skills/
    │   └── {skill-name}/SKILL.md
    └── agents/
        └── {subagent-name}/AGENTS.md
└── .agents/
    └── skills/
        └── {skill-name}/SKILL.md
```

### 25.1 数据位置对照表

| 数据 | 位置 | R/W |
| --- | --- | --- |
| 会话 | `~/.deepagents/.state/sessions.db` | R/W |
| 输入历史 | `~/.deepagents/.state/history.jsonl` | R/W |
| 基础提示 | 包内 `default_agent_prompt.md` | R |
| 用户自定义 | `~/.deepagents/{agent}/AGENTS.md` | R/W |
| 项目指令 | `.deepagents/AGENTS.md` 或 `AGENTS.md` | R |
| 用户 skills | `~/.deepagents/{agent}/skills/` | R/W |
| 共享 skills | `~/.agents/skills/` | R |
| 项目 skills | `.deepagents/skills/` 或 `.agents/skills/` | R |
| 自定义 subagents | `~/.deepagents/{agent}/agents/` | R/W |
| 项目 subagents | `.deepagents/agents/` | R |

### 25.2 优先级
**完全覆盖（不合并）**：

**Skills**（低 → 高）：
1. `~/.deepagents/{agent}/skills/`
2. `~/.agents/skills/`
3. `.deepagents/skills/`
4. `.agents/skills/`（最高）

**Subagents**（低 → 高）：
1. `~/.deepagents/{agent}/agents/`
2. `.deepagents/agents/`（最高）

**Instructions** 全部**合并**（不覆盖）：包内 base prompt → 用户 AGENTS.md → `.deepagents/AGENTS.md` → 项目根 `AGENTS.md`。

### 25.3 `.deepagents` vs `.agents`
- `.deepagents/`：CLI 专属
- `.agents/`：工具无关，跨多个 AI CLI 共享

### 25.4 清理

| 需求 | 命令 |
| --- | --- |
| 全部清空 | `rm -rf ~/.deepagents` |
| 仅清会话 | `rm ~/.deepagents/.state/sessions.db*` |
| 清输入历史 | `rm ~/.deepagents/.state/history.jsonl` |
| 清 API key | `rm ~/.deepagents/.state/auth.json` |
| 清 MCP OAuth | `rm -rf ~/.deepagents/.state/mcp-tokens` |
| 重新走 onboarding | `rm ~/.deepagents/.state/onboarding_complete` |
| 重置 agent 指令 | `deepagents agents reset --agent {name}` |
| 删除 skill | `rm -rf ~/.deepagents/{agent}/skills/{skill-name}` |

---

## 附：常用 npm 包

```bash
# 核心
npm install deepagents langchain @langchain/core @langchain/langgraph

# 模型
npm install @langchain/anthropic
npm install @langchain/openai
npm install @langchain/google-genai
npm install @langchain/aws        # Bedrock
npm install @langchain/azure
npm install @langchain/langgraph-checkpoint  # InMemoryStore 等

# 搜索/工具
npm install @langchain/tavily
npm install @langchain/auth

# 沙箱
npm install @langchain/daytona
npm install @langchain/deno
npm install @daytonaio/sdk

# 协议
npm install deepagents-acp

# 前端
npm install @langchain/react   # useStream（也支持 Vue/Svelte/Angular 入口）
npm install @langchain/langgraph-sdk

# SDK 与服务器侧
npm install @langchain/langgraph-sdk
```

## 附：环境变量速查

```env
# 模型
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
TAVILY_API_KEY=tvly-...

# 追踪
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=my-project
DEEPAGENTS_CLI_LANGSMITH_PROJECT=my-cli-traces

# CLI
DEEPAGENTS_CLI_AUTO_UPDATE=1
DEEPAGENTS_CLI_DEBUG=1
DEEPAGENTS_CLI_SHELL_ALLOW_LIST=pytest,git,make
DEEPAGENTS_CLI_EXTRA_SKILLS_DIRS=~/shared-skills:/opt/team-skills
```
