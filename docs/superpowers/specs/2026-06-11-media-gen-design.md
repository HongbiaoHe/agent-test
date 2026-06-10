# 生图/生视频模块设计 + 实施计划

日期：2026-06-11 ｜ 分支：feat/skills-sandbox-media-gen ｜ 状态：待评审

## 需求（用户原话归纳）

1. 暂只支持 Google 模型（GOOGLE_API_KEY 已有）；先支持流行模型。
2. agent 回答中涉及生图/生视频时智能判断调用；**拟好提示词后先提问用户是否生成**，确认后才生成。
3. 对话中出现**生成动画卡片**（生成中动效 → 完成展示资产）。
4. 生图/生视频都**异步执行**。
5. 记录**持久化**；支持**重新生成**；可查看**生成历史**——重新生成后仍能看到上一版本资产。

## 模型选型（2026-06 已核实）

- 图：`gemini-3.1-flash-image-preview`（Nano Banana 2，2026-02-26 发布，当前流行款）
- 视频：`veo-3.1-generate-preview`（Veo 3.1，8s 720p/1080p，原生音频）
- env 可覆盖：`MEDIA_IMAGE_MODEL` / `MEDIA_VIDEO_MODEL`
- SDK：`@google/genai`（原生 SDK；现有 @langchain/google-genai 只覆盖对话，不做图/视频）

## 数据模型

```prisma
/** 一个"生成位"= 对话里的一张媒体卡片；重新生成在同一 generation 下叠 version。 */
model MediaGeneration {
  id             String         @id @default(cuid())
  conversationId String
  userId         String
  type           String // image | video
  versions       MediaVersion[]
  createdAt      DateTime       @default(now())

  @@index([conversationId])
}

/** 一次生成尝试；历史版本永不删除（用户要求重生成后仍可看旧版）。 */
model MediaVersion {
  id           String          @id @default(cuid())
  generationId String
  generation   MediaGeneration @relation(fields: [generationId], references: [id])
  prompt       String          @db.Text
  model        String
  status       String          @default("queued") // queued | generating | done | failed
  filePath     String? // MEDIA_DATA_DIR 下相对路径，如 <versionId>.png / .mp4
  error        String?         @db.Text
  createdAt    DateTime        @default(now())
  completedAt  DateTime?

  @@index([generationId])
}
```

## 后端 `src/media/`（高内聚：模块一个目录收口）

```
media/
├── media.module.ts      # registerQueue('media-gen')；providers/exports MediaService；controller
├── media.service.ts     # createGeneration / regenerate / listForConversation / getAssetPath
├── media.processor.ts   # @Processor('media-gen')：调 @google/genai，落盘，更新 DB，推流
├── media.tools.ts       # createMediaTools(svc)：generate_image / generate_video（langchain tool()）
├── google-media.client.ts # @google/genai 封装：generateImage(prompt)→bytes、generateVideo(prompt)→bytes（轮询 operation）
└── dto/
```

- **MediaService.createGeneration(conversationId, userId, type, prompt)**：建 generation+version(queued) → `queue.add('generate', { versionId })` → 返回 `{ generationId, versionId }`。
- **regenerate(generationId, userId, prompt?)**：校验归属 → 同 generation 新 version（prompt 缺省沿用上一版）→ 入队 → 返回新 versionId。旧版本行与资产文件不动（历史可见）。
- **MediaProcessor**：version → generating（推流）→ google-media.client 生成 → 资产写 `MEDIA_DATA_DIR`（默认 `data/media/`）`/<versionId>.<png|mp4>` → done/failed + completedAt/error → 推流。
  - 视频是长任务：SDK operation 轮询（10s 间隔，上限 10min）。**只在状态变更时推流**（每 version 至多 generating/done|failed 两次 + 入队时一次 queued），轮询 tick 不推送——避免前端失效风暴（评审 Issue 9）。
  - 推流事件：`{ type: 'media_update', payload: { generationId, versionId, type, status, error? } }` 经 StreamService 进会话流（与 agent 事件同一 Redis Stream key，EventsGateway 原样下发——评审已核实跨模块 publish 运行时可达）。
  - `'media_update'` 必须加入 `ConversationEventType` 联合（types.ts:1-9 是闭合联合，不加 publish 编译不过——评审 Issue 1）。
- **media_update 不落 messages 表**（规避与 agent processor 的 seq 竞争）。**前端职责划分（评审 Issue 3/4/7 决议）**：
  - **锚点**：`generate_image/generate_video` 的 tool_end 消息（role:tool 已持久化，前端 GET /conversations/:id 会返回）。注意 LangChain 把工具返回值序列化为 **JSON 字符串**——reducer 需 `JSON.parse(content)`（try/catch，失败回退普通 tool chip）取 `generationId`，并把该 `kind:'tool'` item **原位变为 `kind:'media'`**（同数组位置，保持会话顺序；不产生第二个 item）。
  - **卡片状态一律来自 React Query**（`GET /conversations/:id/media`），reducer 不存储生成状态：`media_update` 事件处理只做一件事——invalidate 该 query。由此 media_update 先于 tool_end 到达的竞态自然消解（锚点何时出现都从 query 读到最新状态）；每 version 至多 3 次事件 → 至多 3 次 refetch，无风暴。
- **REST**：
  - `GET /conversations/:id/media` → generation 列表（含全部 versions，desc）
  - `POST /media/generations/:id/regenerate` `{ prompt? }`（≤2000 字符；缺省沿用上一版 prompt）
  - `GET /media/versions/:id/asset` → 二进制流：JwtAuthGuard + 归属校验后用 `@Res()` 原始响应（StreamableFile 或 res.sendFile）**绕过 JSON ResponseInterceptor**（评审 Issue 10）；前端 fetch+Authorization → blob URL 给 `<img>/<video>`（不开放无鉴权静态路由）
- **事件类型**：`'media_update'` 加入 `ConversationEventType`（types.ts）；不进 ROLE_BY_TYPE（不落库）。

## Agent 接线（低耦合：agent.factory 不依赖 media 模块；耦合点收敛在 worker）

- `agent.factory.ts`：新增 `BuildAgentOptions.extraTools?: unknown[]`（现无此字段，tools 现为硬编码数组——评审 Issue 6），`tools: [...内置, ...(opts.extraTools ?? [])]`。
- worker：`WorkerModule` **imports MediaModule**（这是有意接受的模块依赖，耦合点只在 worker——评审 Issue 5 决议）；注入 MediaService → `createMediaTools(svc, conversationId, userId)`（闭包带上下文）→ 传 extraTools。
- 工具定义（media.tools.ts，langchain `tool()` + zod，与 get-weather.tool 同款）：
  - `generate_image({ prompt })` / `generate_video({ prompt })`：调 svc.createGeneration，**立即**返回 `{ generationId, versionId, status: 'queued' }` JSON——不等待生成完成。
  - description 写清触发与禁区（§7 规范）："仅在用户明确确认要生成时调用；拟好提示词但用户尚未确认时，先把提示词展示给用户并询问，不要调用本工具"。
- 系统提示新增 `## 生图/生视频` 区块（无条件注入，工具常驻）：拟好提示词→先问用户→确认后调用对应工具→告知用户卡片将异步更新，不要等待或轮询。

## 前端（卡片随对话流）

- `_lib/thread.ts`：
  - `tool_end` 且 name 为 generate_image/generate_video → 解析 content JSON → 产出 `kind:'media'` item（generationId 锚点）。
  - `case 'media_update'` → 按 generationId 更新对应 media item 的 status/versionId（live）。
- `_components/media-card.tsx`（新）：
  - 数据：`GET /conversations/:id/media` query（React Query）按 generationId 取 generation+versions；live media_update → invalidate。
  - 生成中：shimmer 渐变 + 转圈（CSS 动画，与现有 chat 动效体系一致）；类型图标（lucide Image/Video）。
  - 完成：fetch asset（带 token）→ blob URL → `<img>` / `<video controls>`。
  - 失败：错误文案 + 重试（= regenerate）。
  - 操作（评审 Issue 8 决议）：「重新生成」点击后在卡片内**行内展开**一个 Textarea（默认值 = 当前所看版本的 prompt）+「生成/取消」；提交时**总是发送输入框当前值**作为 prompt（即使未改动——语义一致，后端 `prompt?` 的缺省路径只服务 API 直调）。**版本切换**（‹ v2/3 ›）在 generation.versions 内切换，旧版本资产可随时回看。
- `lib/api.ts`：listConversationMedia / regenerateMedia / fetchMediaAsset(blob)。

## 安全 / 约束

- regenerate 与 asset 路由校验归属（userId/tenant 经 conversation 关联）。
- prompt 长度上限 2000 字符（DTO 校验）；单会话 generation 数不设限（YAGNI）。
- 资产目录 `MEDIA_DATA_DIR` 默认 `apps/backend/data/media/`，文件名 = versionId（cuid，不可枚举）。
- Veo 可能需要付费层：失败 → version=failed + error 原文 → 卡片展示，可重试。不做预检。

## 不做（YAGNI）

- 多提供商抽象（仅 Google，client 文件即边界，将来换/加提供商只动 google-media.client.ts）
- 资产 CDN/对象存储、缩略图、配额、并发限速
- 图生图/参考图输入（首版纯文生图/文生视频）

## 实施任务

- M1 Prisma 两模型 + migration → tsc
- M2 后端 media 模块（service/processor/controller/tools/client + queue 注册 + 'media_update' 类型）+ service/tools 单测（mock 队列与 genai client）→ jest 全绿
- M3 agent/worker 接线（extraTools + 系统提示区块 + worker 闭包注入）+ processor spec 增断言 → jest 全绿
- M4 前端（thread reduce + media-card + api + regenerate/版本切换）→ tsc/lint/build
- M5 e2e：真实会话「帮我想一张海报的提示词」→ agent 拟词并询问 → 用户确认 → generate_image → 卡片 queued→generating→done 展示图片 → 重新生成 → 版本历史可回看上一版。preview 浏览器验证 + 截图。视频链路同流程（若 Veo 因付费层失败，验证 failed 卡片 + 重试 UX 并如实汇报）。
