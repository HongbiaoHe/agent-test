# desktop 视频剪辑器 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan.

**Goal:** desktop 新增 `create_video_project` / `check_video_project` 两个工具，把生成的视频、音频（及工作区文件）转成一份可编辑的剪辑工程；新增一个轻量剪辑器视图，支持调时长、背景音乐、字幕、多段分镜拼接、预览与导出。

**约束：** 不自动 commit（CLAUDE.md）；命令前 `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH`；禁 `any` / `as any` / `@ts-ignore`；desktop 渲染层只用语义 token、lucide 图标、`renderer/src/components/ui` 原语，文案走三语 i18n（renderer 禁中文字面量）；起 dev server 只用 preview_start；测试用 vitest + Playwright Electron e2e（`pnpm --filter desktop e2e`）。

---

## 已确认的设计决策（grilling 结论）

1. **数据**：工程是工作区里的文件 `videos/<名字>.sparkvideo.json`；schema 在共享包 `packages/video-schema`（zod，带 `version`），工具、剪辑器、导出器三方共用。素材 `src` 一律是工作区相对路径。
2. **引擎**：打包 `ffmpeg-static` + `ffprobe-static`（extraResources，附 GPL 许可证说明）负责探测与导出；预览在渲染层用原生 `<video>` / `<audio>` 按时间线播放，字幕 DOM 叠加。
3. **工具输入**：`create_video_project` 的片段既可以是生成产物 `{ versionId }`（下载进 `media/<versionId>/`，复用 sync_media 的下载逻辑），也可以是工作区文件 `{ path }`；ffprobe 读时长与尺寸写进工程。
4. **时间线固定三轨**：视频轨（首尾相接、可裁入出点、原声音量、支持图片片段）+ 音频轨（多段、各自起点、裁剪、音量、淡入淡出、可重叠、导出时混音）+ 字幕（全局一种预设样式）；画布默认取第一段尺寸，不同尺寸等比缩放补黑边；不做转场 / 画中画 / 关键帧。
5. **字幕**：agent 经工具参数写入 + 编辑器手动改；不做语音识别。
6. **入口**：主窗口新增「剪辑器」视图（`View` 联合多一个 kind）；从对话里的工具结果卡片「打开剪辑器」或工作区文件面板点 `.sparkvideo.json` 打开；编辑器监听工程文件，外部修改自动重载。
7. **导出**：只在剪辑器里点按钮（agent 没有导出工具）；分辨率可选（原尺寸 / 1080p / 720p），mp4（H.264 + AAC），进度条 + 可取消，产物 `exports/<工程名>-<时间>.mp4`。
8. **保存**：自动保存（约 1 秒防抖）+ 撤销 / 重做（内存快照）；有未写回改动时文件被外部改了 → 顶部提示条「重新加载 / 保留我的修改」。
9. **背景音乐**：只能用户导入本机文件（复制进 `media/imports/`）或 agent 传工作区音频；不做曲库、不做音乐生成。
10. **agent 修改工程**：直接用文件工具改 JSON；新增只读 `check_video_project` 返回校验结果、缺失素材、总时长；编辑器打开时走同一套校验。

**自行定的默认值：** 工具只在 desktop 注册，requires `workspace_write`（引用 versionId 时还需 `media_api`，缺失时只接受 path）；通用模式自动带上；工具不自动打开编辑器，结果卡片给「打开剪辑器」按钮；字幕样式 3 种预设（`bottom-outline` 底部白字黑描边、`bottom-box` 底部白字半透明底、`top` 顶部）。

## 共享契约（已落地）

- `packages/video-schema/src/project.ts`：`VideoProjectSchema`、`parseProject`（结构 + id 唯一）、`layoutVideoTrack`、`projectDuration`、`clipDuration`、`emptyProject`、`PROJECT_FILE_SUFFIX` / `PROJECTS_DIR` / `EXPORTS_DIR`、`SUBTITLE_STYLES`。
- `apps/desktop/src/shared/rpc.ts`：`video.list / read / close / write / probe / importFiles / export / exportCancel` 与事件 `video-file-changed`、`video-export`（类型 `VideoProjectSummary` / `VideoProjectFile` / `VideoWriteResult` / `VideoMediaProbe` / `VideoExportStatus`）。

## 分工

- **host（agent-host + main + 打包）**：ffmpeg / ffprobe 打包与定位；探测；工具两个 + promptSection（含工程格式说明）；`video.*` RPC handler；文件监听；导出（时间线 → ffmpeg 参数的纯函数 + 进度解析 + 取消）；CSP 放行 `spark-preview:` 的 media-src。
- **渲染层**：剪辑器视图（预览播放器、时间线、片段 / 音频 / 字幕编辑、导入、导出对话框、自动保存、撤销重做、冲突提示）；工具结果卡片；工作区文件面板入口；三语文案。
- **e2e**：Playwright Electron 用例覆盖生成工程 → 打开 → 裁剪 → 背景音乐 → 字幕 → 导出（ffprobe 校验导出时长与音轨），以及外部修改重载、冲突提示。
