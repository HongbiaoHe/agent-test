# Spark 接入 aigc 音频：配音 + 克隆音色 设计

> 状态：**待确认**（未动代码）· 2026-10-24 · v3（克隆改用 byteplus，产物当参考音色）
> 范围：Spark 对话 agent（`/agent`），**不含**画布（canvas）。

## 0. 结论先行

| 能力 | 怎么做 |
|---|---|
| **配音（TTS）** | 新工具 `generate_audio`，复用现有的媒体生成链路 |
| **克隆音色** | 新工具 `clone_voice`，调用 byteplus `voice-replication-2.0`：拿用户的录音复刻音色，念一段 4~80 字的文案，**产物是一段音频** |
| **用克隆音色配音** | 把克隆产出的那段音频，作为 `seed-audio-1.0` 的**参考音频**（`referenceVersionIds`），让它照这个音色念新文本 |
| 音效 / 配乐 | 做不了：上游 `audio` 类型只有 TTS 模型 |

这条路线的好处：

- **几乎不花钱**：一次克隆约等于 demo 文案字数 × $0.00003，14 个字约 $0.0004；也不产生音色位费用，因为上游刻意丢弃了 speaker_id。依据是 aigc `doc/2026-08-14-byteplus-audio-integration-design.md:52-64,152-159`。
- **没有 7 天失效之类的生命周期问题**：产物就是一个普通音频文件，永久保存在 GCS。
- **不用建新表、不用迁移**：克隆结果就是一条媒体生成记录，参考素材链路原样可用。
- 这正是 aigc 设计这条能力时设想的用法：「我的音色」由业务方保存为音频资产，生成时只需要给 aigc 一个 `audio_url`（同一份文档 :64）。

顺带说明：用户的原始录音其实也能直接当 seed-audio 的参考音频。先克隆一遍的额外价值有两点：
1. `.m4a` / `.aac` 录音克隆后变成 `.wav`，就能被 seed-audio 接收了（seed-audio 的参考音频不收 m4a，见 §1.1）。
2. 产出的是一段干净、长度合适（≤80 字，大约 17 秒）的标准音色样本。

## 1. 上游契约（已核对 aigc 源码、对接指南和 dev 目录）

上游指 `buzz-video/aigc/aigc_service` 的分支 `origin/aigc-dev-new`。「指南」指 `doc/2026-08-18-音频音色对接指南.md`。dev 目录是 2026-10-24 用 `GET /channels?type=audio|voice` 实测的。

### 1.1 配音 `POST /tasks/audios`

| 渠道 / 模型 | 定位 | 可选维度（options） | 区间维度（range） | 参考素材上限 |
|---|---|---|---|---|
| byteplus `seed-audio-1.0` | TTS。不给参考用默认音色；**给 1~3 段音频就照这些音色念**；给 1 张图就按画面配旁白 | `format`、`sample_rate` | `speech_rate`（-50~100）、`loudness_rate`（-50~100）、`pitch_rate`（-12~12） | 图 1 / 音频 3 |
| fal `minimax-speech-2.8-hd` | TTS，17 个预置音色，**不收参考音频** | `voice_id`（必填）、`emotion`、`language_boost`、`format`、`sample_rate`、`bitrate`、`audio_channel` | `speed`（0.5~2）、`volume`（0.01~10）、`pitch_rate`（-12~12） | 无 |

- 正文字段叫 **`text_prompt`**（不是 `prompt`），档位一律传**字符串**。依据：上游 `src/tasks/dto/create-audio-task.dto.ts:36,68,181-265`。
- 产物：`output_data.audio_url`，另有 `duration`（指南 :168-187）。
- 参考音频的规则（指南 :133-139）：
  - `role` 必须是 `reference`。
  - **音频和图片不能混传**。
  - 音频只收 `.wav / .mp3 / .pcm / .ogg / .opus`，**不收 `.m4a`**，按 URL 后缀判断。
- 单次中文大约 ≤400 字（指南 :149-155），耗时 50~80 秒（指南 :19）。

### 1.2 克隆 `POST /tasks/voices`（byteplus `voice-replication-2.0`）

| 字段 | 说明 |
|---|---|
| `source_audio_url` | 必填。公网 URL，建议 10~15 秒，**≤10MB**，支持 wav / mp3 / ogg / m4a / aac / pcm（指南 §3.1）。aigc 接单阶段还限制**≤60 秒**（上游设计文档 D7，:295） |
| `language` | 必填。取值以 dev 目录为准，**目前是 `0`~`11`**（0 中文、1 英语、2 日语……，指南 §3.1.1 有完整对照表）。**不支持跨语言复刻**：录音里的语言必须和这里选的一致 |
| `demo_text` | 必填，**4~80 字符**（dev 目录 `max_prompt=80`）。产物就是「用复刻出的音色念这段话」 |

- 源录音走 `source_audio_url` 这个独立字段，**不用** `reference_resources`（传了会被白名单拒绝）。
- 产物**只有** `output_data.audio_url`，后缀是 `.wav`。没有 duration，也没有 speaker_id（指南 §3.2）。
- 耗时 7~70 秒，同样支持 `callback_url` 回调和轮询。

## 2. 现状：要改的分叉点

本项目的媒体链路目前写死只有 image / video：

| 位置 | 现状 |
|---|---|
| `apps/backend/src/aigc/aigc.types.ts:12` | `AigcMediaType = 'image' \| 'video'` |
| `apps/backend/src/aigc/aigc.types.ts:24-30` | 参数 schema 没有解析 `range` |
| `apps/backend/src/aigc/aigc.types.ts:82-87` | `output_data` 只取 `image_url` / `video_url` |
| `apps/backend/src/aigc/aigc.catalog.ts:17-22` | `selectableParams` 丢掉 range 和布尔维度 |
| `apps/backend/src/aigc/aigc.catalog.ts:200-212` | `PARAM_FIELDS` 白名单没有音频字段 |
| `apps/backend/src/aigc/aigc.catalog.ts:232` | 正文字段固定写成 `prompt` |
| `apps/backend/src/aigc/aigc.catalog.ts:244-250` | 参考一律放进 `reference_resources` |
| `apps/backend/src/aigc/aigc.catalog.ts:259-261` | `taskPath` 只有 images / videos |
| `apps/backend/src/aigc/aigc.controller.ts:18` | `/aigc/models?type=` 非 video 一律当 image |
| `apps/backend/src/media/media.service.ts:21` | `MediaType = 'image' \| 'video'` |
| `apps/backend/src/media/media.service.ts:56-61` | `extFromUrl` 不认识音频后缀 |
| `apps/backend/src/media/media.service.ts:337`、`:471-473`、`:761-765` | 重新生成、回调落库、同步到沙箱三处写死二分 |
| `apps/backend/src/media/media.service.ts:890-894` | `asAssetType` 只认 image / video / audio |
| `apps/backend/src/media/media.processor.ts:267` | 认不出的类型**兜底当成 image**（`?? 'image'`） |
| `apps/backend/src/media/media.processor.ts:325`、`:358` | 回取参考地址、对账超时两处写死二分 |
| `apps/backend/src/media/media.tools.ts:108`、`:146-171` | `list_media_models` 的 type 枚举，生成工具只有两个 |
| `apps/backend/src/agent/agent.factory.ts:46-54` | 系统提示词「生图 / 生视频」段 |
| `apps/frontend/src/lib/api.ts:437`、`:460-465`、`:881` | `MediaType`、`MediaGeneration.type`、`listAigcModels` |
| `apps/frontend/src/app/agent/_lib/thread.ts:253-254` | 工具名 → mediaType 映射 |
| `apps/frontend/src/app/agent/_components/media-card.tsx:34-37`、`:672-686` | `TYPE_META`、产物渲染（`video` 或 `img` 二选一） |

可以直接复用的部分：

- `MediaGeneration.type` 在库里是 `String`（`apps/backend/prisma/schema.prisma:138`），**不用迁移**。
- 参考素材链路已经支持 audio：
  - 校验按 `asAssetType` 计数，并核对归属同一 userId（`media.service.ts:616-664`）。
  - 组装时按素材所属 generation 的类型提交，audio 的 role 恒为 `reference`（`media.processor.ts:240-242,295-300`）。
  - agent 层按模型的 `*_input_number` 逐类校验参考数量（`aigc.agent.ts:351-365`）。所以 minimax 模型的 `audio_input_number=0` 会**自动拒收**音频参考，并给 agent 返回「不支持参考音频」，不用另写规则。
- 用户上传的录音已经存成 aigc GCS 的公网地址（`media-upload.service.ts:110-157`），可以直接作为 `source_audio_url`，不需要隧道。
- 画布不直接依赖 `AigcMediaType`（`apps/backend/src/canvas/` 里 grep 不到）。

## 3. 设计

### 3.1 数据怎么存（零迁移）

| | `MediaGeneration.type` | `MediaVersion.prompt` | `referenceVersionIds` | `url` |
|---|---|---|---|---|
| 配音 | `audio` | 要念的文本 | 可选：参考音色 / 参考图 | 产物 `.mp3` / `.wav` |
| 克隆 | **`voice`** | `demo_text` | **恰好 1 个：源录音的 versionId** | 克隆出的 `.wav` |

- **克隆单独记成 `voice` 类型**，而不是混进 `audio`。原因：
  - 重新生成、校验、提交走的都是 voice 的目录和接口。如果记成 `audio`，重新生成时会去 audio 目录里找 `voice-replication-2.0`，找不到就**静默回落到默认配音模型**（`aigc.service.ts:105-118`）。
  - 卡片要显示成「Voice clone」。
- **`asAssetType('voice')` 返回 `'audio'`**：克隆产物本身就是一个音频文件。改了这一处，参考校验、参考计数、同步到沙箱、processor 判断参考类型，四个调用点（`media.service.ts:648,659,744`、`media.processor.ts:267`）就都会把它当音频处理。否则在 `media.processor.ts:267` 会被兜底成 image。
- 源录音放进 `referenceVersionIds`：沿用这个字段「本次产出引用了哪些既有版本」的语义。拼接视频也是这么用的（`media.service.ts:211-220`）。重新生成时会自动继承源录音。

### 3.2 Agent 交互

| 工具 | 说明 |
|---|---|
| `list_media_models` | `type` 增加 `'audio'`。audio 的返回里附带 **`myVoices`**：当前用户所有已完成的克隆，格式是 `[{ versionId, demoText, createdAt }]`，按时间倒序，最多 20 条。这样**跨会话**也能找到之前克隆过的音色 |
| `generate_audio`（新） | 入参：`prompt`（要念的文本）、`model`、`channel`、`count`、`referenceVersionIds`、`params`（音频维度显式列出，值都是 string）。**用克隆音色时就是 `model=seed-audio-1.0` 加上 `referenceVersionIds=[克隆的 versionId]`**，不需要额外字段 |
| `clone_voice`（新） | 入参：`sourceVersionId`（用户上传的录音）、`language`（目录给出的值）、`demoText`（4~80 字）。模型**固定**为 byteplus `voice-replication-2.0`，不暴露 `model` 参数：dev 目录的 voice 类型下还有 fal 的克隆模型，但它的产物是 ID，不在本方案里 |

- 系统提示词扩写原来的「生图 / 生视频」段（`agent.factory.ts:46-54`）：
  - 配音同样要先给用户看文本，确认后再调用。
  - **克隆流程**：
    1. 用户上传一段 10~60 秒的清晰单人录音。
    2. 跟用户确认录音的语言，以及 demo 文案（可以由 agent 拟好）。
    3. 调用 `clone_voice`。
    4. 克隆完成后，用 `generate_audio` 配合 `seed-audio-1.0` 和这段克隆音频去配音。
  - 说明没有音效能力。
- 克隆几乎不花钱，所以**不加审批卡片**，沿用生图那套「口头确认后再调用」的纪律。

### 3.3 后端

1. **类型**：
   - `AigcMediaType` 加上 `'audio' | 'voice'`，`MediaType` 同步放宽。
   - `aigcModelParamSchema` 加可选的 `range`。
   - `output_data` 加 `audio_url`。
2. **目录与校验（`aigc.catalog.ts` / `aigc.agent.ts`）**：
   - audio：放行 range 维度并校验 min / max / step。加两条规则：图音混传报 issue；参考音频后缀是 `.m4a` / `.aac` 报 issue，提示「先 clone_voice 转一下，或者改传 mp3 / wav」（见 §5-Q3）。
   - voice：`demoText` 必须是 4~80 字（上限取目录里的 `max_prompt`）；`language` 必须在目录 options 里；源素材必须恰好 1 个，而且是 `audio` 类型。录音时长不在我们这边检查，由 aigc 接单时把关（≤60 秒），超了的话卡片会显示上游的报错。
3. **提交（`buildTaskBody` / `taskPath`）**：
   - audio 路径是 `/tasks/audios`，正文写 `text_prompt`，`PARAM_FIELDS` 补上音频维度（取值原样传字符串）。
   - voice 路径是 `/tasks/voices`，正文写 `demo_text`。**第一条参考转成 `source_audio_url`**，不再放进 `reference_resources`。`language` 加进 `PARAM_FIELDS`。
4. **回调与落库**：
   - `applyTaskResult` 和 `refUrl` 取产物地址时加上 `audio_url`，覆盖 audio 和 voice。
   - 写死的 `=== 'video' ? 'video' : 'image'` 改成按 generation.type 收窄到 `AigcMediaType`。
   - `extFromUrl` 增加 `mp3 / wav / ogg / flac`。
5. **对账**：沿用现有节奏，上限 60 轮 × 30s（`media.service.ts:38-41`），够覆盖 50~80 秒的耗时。
6. **重新生成**：audio 和 voice 都允许。voice 会继承源录音、语言和文案。

### 3.4 前端（遵守 `apps/frontend/DESIGN.md` 的 token 规范）

- `api.ts`：`MediaType` 加 `"audio" | "voice"`，`listAigcModels` 放宽。
- `thread.ts:253`：`generate_audio` 映射到 `"audio"`，`clone_voice` 映射到 `"voice"`。
- `media-card.tsx`：
  - `TYPE_META` 加 `audio`（lucide `AudioLines`，"Audio"）和 `voice`（lucide `Mic`，"Voice clone"）。
  - `AssetSurface` 加音频分支：`<audio controls>`，样式参照 `message-attachments.tsx:41-49`。voice 卡片额外显示 demo 文案。
  - 参考素材行（`media-card.tsx:546-557`）现在 audio 只显示一个 Music 图标；voice 产物作为参考时也走这个分支，不需要改。
  - 生成中的占位用矮条形，不用 16:9 的 shimmer。

## 4. 测试与验证计划

- 单测：
  - `aigc.catalog.spec`：audio / voice 的路径和正文字段；voice 的第一条参考转成 `source_audio_url`、不出现 `reference_resources`；range 字段原样透传。
  - `aigc.agent.spec`：range 越界 / 步长报错；图音混传、m4a 报错；voice 的 demoText 长度、language 取值、源素材数量。
  - `media.service.spec`：`asAssetType('voice') === 'audio'`；`applyTaskResult` 的 `audio_url` 分支；`myVoices` 查询只返回本人、已完成的 voice。
  - `media.tools.spec`：两个新工具的入参。
- 检查：后端和前端都跑 `pnpm lint`，再跑 `tsc --noEmit`。
- 真机（费用很小，约几美分）：
  1. 两个配音模型各配一段，卡片能播放。
  2. 上传一段 10~60 秒的录音 → `clone_voice` → 卡片里能试听克隆出的音频。
  3. 用 `seed-audio-1.0` 加这段克隆音频配一段新文本 → 出声，并且**人工听一下音色像不像**。仿声效果上游文档没有量化，只能实测判断。
  4. 新开一个会话，确认 `myVoices` 能看到刚才克隆的音色，并且能引用它。

## 5. 需要你拍板的问题

- **Q1 范围**：配音 + byteplus 克隆（产物作为 seed-audio 的参考音色）。不做：fal 克隆、音效。可以吗？
- **Q2 区间参数（语速 / 音调 / 音量）**：建议本期就支持，大约 +60 行，外加单测。
- **Q3 直接拿 `.m4a` / `.aac` 录音当参考音频**：建议在校验层拦下，提示 agent 先 `clone_voice` 转一下（克隆接收 m4a，产物是 wav）。
- **Q4 跨会话「我的音色」**：建议只在 `list_media_models` 的返回里附带 `myVoices`，零新表；**不做**设置页、不做命名。如果你希望能给音色起名、管理，就需要建表加设置页，工作量会明显增加。

## 6. 不在本期

- 音效 / 配乐（上游没有模型）；fal `minimax-voice-clone`（产物是音色 ID，有 $1.5 / 次的费用和 7 天失效问题）。
- 「我的音色」的命名、管理页面。
- 画布接入音频节点；字幕（`enable_subtitle`）展示。
