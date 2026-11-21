import type { CanvasIoType, CanvasNodeType } from "@agent-test/canvas-schema";

import type { CanvasLocale } from "../platform";

/**
 * 画布界面的全部文案（三种语言各一份）。en 是基准：web 传 locale "en"，措辞必须与搬家前的 web 逐字一致。
 * 带参数的文案写成函数，复数 / 量词等语法差异各语言自己处理。
 *
 * 例外：参考素材的叫法 `Image 1` / `Video 1` / `Audio 1` 不在这里——它是写提示词时引用素材的约定写法
 * （后端按入边顺序对应，见 media.processor），任何语言下都保持英文。
 */
const en = {
  nodeType: {
    image_upload: "Image upload",
    video_upload: "Video upload",
    audio_upload: "Audio upload",
    image_gen: "Image",
    video_gen: "Video",
    video_concat: "Merge",
  } satisfies Record<CanvasNodeType, string>,
  /** 端口上流动的资源类型（小写，嵌进句子里用） */
  ioType: {
    image: "image",
    video: "video",
    audio: "audio",
  } satisfies Record<CanvasIoType, string>,
  board: {
    agentSettingUp: "The agent is setting things up…",
    empty: "This canvas is empty",
    emptyHint:
      "Right-click anywhere to add a node, or ask the agent to build the board for you.",
  },
  connectMenu: {
    addNode: "Add node",
    sendInto: "Send into",
    feedFrom: "Feed from",
  },
  zoom: {
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fitView: "Fit view",
  },
  selection: {
    inChatContext: "In chat context",
    addToChat: "Add to chat",
    focusedTooltip: "Agent sees only these nodes — click to undo",
    addTooltip: "Limit the agent to these nodes",
  },
  actions: {
    duplicate: "Duplicate",
    delete: "Delete",
    download: "Download",
    retry: "Retry",
    merge: "Merge",
    replaceFile: "Replace file",
    viewFullSize: "View full size",
    playFullSize: "Play full size",
    pauseWithDownstream: "Pause (with downstream)",
    resumeWithDownstream: "Resume (with downstream)",
  },
  node: {
    inChatTitle: "In chat context",
    inChat: "In chat",
    saving: "Saving",
    saved: "Saved",
    notSaved: "Not saved",
    titleAria: "Node title",
    generatedImageAlt: "Generated image",
    previewFailedRetry: "Preview failed — retry",
    mock: "Mock",
  },
  status: {
    generating: "Generating",
    generatingEllipsis: "Generating…",
    merging: "Merging",
    mergingEllipsis: "Merging…",
    queued: "Queued",
    paused: "Paused",
    failed: "Failed",
    cancelled: "Cancelled",
    notGenerated: "Not generated",
    notGeneratedYet: "Not generated yet",
    noFileYet: "No file yet",
    renderCancelled: "Render cancelled",
    renderFailed: "Render failed",
    mergeCancelled: "Merge cancelled",
    mergeFailed: "Merge failed",
  },
  upload: {
    uploading: (percent: number) => `Uploading ${percent}%`,
    noneYet: (kind: string) => `No ${kind} uploaded yet`,
    choose: (kind: string) => `Choose ${kind}`,
    orDrop: "or drop a file here",
    wrongType: (file: string, kind: string) =>
      `${file}: this node takes ${kind} files`,
    failed: "Upload failed",
    unsupported: (file: string) =>
      `${file}: unsupported format (images: JPEG/PNG/WebP, videos: MP4/MOV, audio: MP3/WAV/M4A)`,
    tooLarge: (file: string, maxMb: number, kind: string) =>
      `${file}: too large (max ${maxMb}MB for ${kind})`,
  },
  concat: {
    generateUpstreamFirst: (n: number) =>
      `Generate ${n} upstream ${n === 1 ? "video" : "videos"} first`,
    connectAtLeastTwo: (n: number) => `Connect at least two videos (${n})`,
    stillGenerating: (total: number, pending: number) =>
      `${total} clips — ${pending} still generating`,
    hoverToPreview: (n: number) => `${n} clips — hover to preview`,
    emptyClips: "Connect video nodes to line them up here.",
    openVideoNode: "Open this video node",
  },
  /** 卡片底部 / 面板参数条上的上游摘要：`From 2 image, 1 waiting` */
  inputs: {
    summary: (
      parts: readonly { type: CanvasIoType; count: number }[],
      waiting: number,
    ) => {
      const items = parts.map((p) => `${p.count} ${p.type}`);
      if (waiting > 0) items.push(`${waiting} waiting`);
      return `From ${items.join(", ")}`;
    },
    heading: (n: number) => `Inputs · ${n}`,
    notReadyYet: "Not ready yet",
    notUsedInGeneration: "Not used in generation",
    previewFailed: "Preview failed",
    linkedInputAlt: "Linked input",
  },
  composer: {
    drawerTitle: "Node prompt",
    collapse: "Collapse",
    promptAria: "Prompt",
    promptPlaceholder: "Describe what to generate…",
  },
  mediaDialog: {
    description: "Full-size preview of this node's output",
  },
  attachments: {
    listAria: "Attachments",
    skip: {
      pending: "Not ready yet",
      type: "This node doesn't take this kind of input",
      frame: "This model starts from one frame — only the first image is used",
      limit: "Over this model's limit — not used",
    },
    goToNode: (name: string) => `${name}. Go to node`,
    mockOutput: "Mock output · ",
    previewUnavailable: "Preview unavailable · click to open the node",
    clickToOpen: "Click to open the node",
    stateClickToOpen: (state: string) => `${state} · click to open the node`,
  },
  model: {
    generating: "Generating…",
    regenerate: "Regenerate",
    generate: "Generate",
    loading: "Loading models…",
    none: "No model",
    pickerTitle: "Model",
    settingsTitle: "Generation settings",
    modeFrames: "First/last frame",
    modeFramesShort: "Frames",
    modeReference: "Reference",
    modeReferenceShort: "Reference",
    mode: "Mode",
    modeHelp:
      "Reference: upstream images guide the subject and style. First/last frame is not available yet.",
    modeFirstFrameOnly:
      "This model only takes the upstream image as its first frame.",
    audioTitle: (value: string) => `Audio: ${value}`,
    audioOff: "Audio off",
    audioAria: (value: string) => `Audio ${value}`,
    notUsedWithInputs: "Not used with the current inputs",
    someLimited: "Some options are limited by your other settings or inputs",
    about: (label: string) => `About ${label}`,
    notAvailable: "Not available with current settings",
  },
  /** 档位的展示文本（目录里没有英文 label 时的退路） */
  params: {
    auto: "Auto",
    on: "On",
    off: "Off",
    labels: {
      aspect_ratio: "Ratio",
      resolution: "Resolution",
      duration: "Duration",
      with_audio: "Audio",
      thinking: "Thinking",
      background: "Background",
      quality: "Quality",
    } as Record<string, string>,
    /** 目录 label 是中日韩文字时能否直接用（英文界面不用，退回由 param_type 推出的英文） */
    acceptsCjkLabels: false,
  },
  /** 板上操作失败 / 部分生效的提示（useCanvasBoard 里的 toast） */
  boardToast: {
    retryFailed: "Retry failed",
    generationFailed: "Generation failed",
    mergeFailed: "Merge failed",
    pauseFailed: "Pause failed",
    resumeFailed: "Resume failed",
    focusFailed: "Could not update focus",
    pausedSome: (paused: number, skipped: number) =>
      `Paused ${paused} · ${skipped} already submitted will finish`,
    cannotPause: "Already submitted to the model — it can't be paused",
    notLoaded: "Canvas not loaded",
  },
  saveStatus: {
    saving: "Saving…",
    saved: "Saved",
    failed: "Save failed, reloaded",
  },
};

export type CanvasMessages = typeof en;

const zhCN: CanvasMessages = {
  nodeType: {
    image_upload: "上传图片",
    video_upload: "上传视频",
    audio_upload: "上传音频",
    image_gen: "图片",
    video_gen: "视频",
    video_concat: "拼接",
  },
  ioType: {
    image: "图片",
    video: "视频",
    audio: "音频",
  },
  board: {
    agentSettingUp: "Agent 正在搭建画布…",
    empty: "这块画布还是空的",
    emptyHint: "在任意空白处右键添加节点，或者让 Agent 帮你把画布搭起来。",
  },
  connectMenu: {
    addNode: "添加节点",
    sendInto: "输出到",
    feedFrom: "输入自",
  },
  zoom: {
    zoomIn: "放大",
    zoomOut: "缩小",
    fitView: "适应画布",
  },
  selection: {
    inChatContext: "已加入对话",
    addToChat: "加入对话",
    focusedTooltip: "Agent 只会看到这些节点——点击取消",
    addTooltip: "让 Agent 只关注这些节点",
  },
  actions: {
    duplicate: "复制",
    delete: "删除",
    download: "下载",
    retry: "重试",
    merge: "拼接",
    replaceFile: "替换文件",
    viewFullSize: "查看大图",
    playFullSize: "全屏播放",
    pauseWithDownstream: "暂停（连同下游）",
    resumeWithDownstream: "继续（连同下游）",
  },
  node: {
    inChatTitle: "已加入对话",
    inChat: "对话中",
    saving: "保存中",
    saved: "已保存",
    notSaved: "未保存",
    titleAria: "节点标题",
    generatedImageAlt: "生成的图片",
    previewFailedRetry: "预览加载失败——重试",
    mock: "模拟",
  },
  status: {
    generating: "生成中",
    generatingEllipsis: "生成中…",
    merging: "拼接中",
    mergingEllipsis: "拼接中…",
    queued: "排队中",
    paused: "已暂停",
    failed: "失败",
    cancelled: "已取消",
    notGenerated: "未生成",
    notGeneratedYet: "尚未生成",
    noFileYet: "还没有文件",
    renderCancelled: "生成已取消",
    renderFailed: "生成失败",
    mergeCancelled: "拼接已取消",
    mergeFailed: "拼接失败",
  },
  upload: {
    uploading: (percent) => `上传中 ${percent}%`,
    noneYet: (kind) => `还没有上传${kind}`,
    choose: (kind) => `选择${kind}`,
    orDrop: "或将文件拖到这里",
    wrongType: (file, kind) => `${file}：这个节点只接收${kind}文件`,
    failed: "上传失败",
    unsupported: (file) =>
      `${file}：不支持的格式（图片：JPEG/PNG/WebP，视频：MP4/MOV，音频：MP3/WAV/M4A）`,
    tooLarge: (file, maxMb, kind) => `${file}：文件过大（${kind}最大 ${maxMb}MB）`,
  },
  concat: {
    generateUpstreamFirst: (n) => `请先生成上游的 ${n} 段视频`,
    connectAtLeastTwo: (n) => `至少连接两段视频（当前 ${n} 段）`,
    stillGenerating: (total, pending) => `共 ${total} 段——${pending} 段仍在生成`,
    hoverToPreview: (n) => `共 ${n} 段——悬停预览`,
    emptyClips: "连接视频节点，它们会按顺序排在这里。",
    openVideoNode: "打开这个视频节点",
  },
  inputs: {
    summary: (parts, waiting) => {
      const unit: Record<CanvasIoType, string> = {
        image: "张图片",
        video: "段视频",
        audio: "段音频",
      };
      const items = parts.map((p) => `${p.count} ${unit[p.type]}`);
      if (waiting > 0) items.push(`${waiting} 路待就绪`);
      return `来自 ${items.join("、")}`;
    },
    heading: (n) => `输入 · ${n}`,
    notReadyYet: "尚未就绪",
    notUsedInGeneration: "生成时不会使用",
    previewFailed: "预览加载失败",
    linkedInputAlt: "关联的输入",
  },
  composer: {
    drawerTitle: "节点提示词",
    collapse: "收起",
    promptAria: "提示词",
    promptPlaceholder: "描述你想生成的内容…",
  },
  mediaDialog: {
    description: "这个节点产出内容的大图预览",
  },
  attachments: {
    listAria: "附件",
    skip: {
      pending: "尚未就绪",
      type: "这个节点不接收这类输入",
      frame: "这个模型从单帧起步——只会使用第一张图片",
      limit: "超出这个模型的数量上限——不会使用",
    },
    goToNode: (name) => `${name}。跳转到节点`,
    mockOutput: "模拟产出 · ",
    previewUnavailable: "预览不可用 · 点击打开节点",
    clickToOpen: "点击打开节点",
    stateClickToOpen: (state) => `${state} · 点击打开节点`,
  },
  model: {
    generating: "生成中…",
    regenerate: "重新生成",
    generate: "生成",
    loading: "正在加载模型…",
    none: "没有可用模型",
    pickerTitle: "模型",
    settingsTitle: "生成设置",
    modeFrames: "首尾帧",
    modeFramesShort: "首尾帧",
    modeReference: "参考",
    modeReferenceShort: "参考",
    mode: "模式",
    modeHelp: "参考：上游图片用来引导主体与风格。首尾帧模式暂未开放。",
    modeFirstFrameOnly: "这个模型只会把上游图片用作首帧。",
    audioTitle: (value) => `音频：${value}`,
    audioOff: "音频已关闭",
    audioAria: (value) => `音频 ${value}`,
    notUsedWithInputs: "当前输入下不会使用",
    someLimited: "部分选项受其他设置或输入限制",
    about: (label) => `关于${label}`,
    notAvailable: "当前设置下不可用",
  },
  params: {
    auto: "自动",
    on: "开",
    off: "关",
    labels: {
      aspect_ratio: "比例",
      resolution: "清晰度",
      duration: "时长",
      with_audio: "音频",
      thinking: "思考",
      background: "背景",
      quality: "质量",
    },
    acceptsCjkLabels: true,
  },
  boardToast: {
    retryFailed: "重试失败",
    generationFailed: "生成失败",
    mergeFailed: "拼接失败",
    pauseFailed: "暂停失败",
    resumeFailed: "继续失败",
    focusFailed: "更新圈定的节点失败",
    pausedSome: (paused: number, skipped: number) =>
      `已暂停 ${paused} 个 · ${skipped} 个已提交给模型，会继续跑完`,
    cannotPause: "已经提交给模型，暂停不了",
    notLoaded: "画布还没加载好",
  },
  saveStatus: {
    saving: "保存中…",
    saved: "已保存",
    failed: "保存失败，已重新加载",
  },
};

const zhHant: CanvasMessages = {
  nodeType: {
    image_upload: "上傳圖片",
    video_upload: "上傳影片",
    audio_upload: "上傳音訊",
    image_gen: "圖片",
    video_gen: "影片",
    video_concat: "拼接",
  },
  ioType: {
    image: "圖片",
    video: "影片",
    audio: "音訊",
  },
  board: {
    agentSettingUp: "Agent 正在搭建畫布…",
    empty: "這塊畫布還是空的",
    emptyHint: "在任意空白處按右鍵新增節點，或請 Agent 幫你把畫布搭起來。",
  },
  connectMenu: {
    addNode: "新增節點",
    sendInto: "輸出到",
    feedFrom: "輸入自",
  },
  zoom: {
    zoomIn: "放大",
    zoomOut: "縮小",
    fitView: "符合畫布",
  },
  selection: {
    inChatContext: "已加入對話",
    addToChat: "加入對話",
    focusedTooltip: "Agent 只會看到這些節點——點擊取消",
    addTooltip: "讓 Agent 只關注這些節點",
  },
  actions: {
    duplicate: "複製",
    delete: "刪除",
    download: "下載",
    retry: "重試",
    merge: "拼接",
    replaceFile: "替換檔案",
    viewFullSize: "檢視大圖",
    playFullSize: "全螢幕播放",
    pauseWithDownstream: "暫停（連同下游）",
    resumeWithDownstream: "繼續（連同下游）",
  },
  node: {
    inChatTitle: "已加入對話",
    inChat: "對話中",
    saving: "儲存中",
    saved: "已儲存",
    notSaved: "未儲存",
    titleAria: "節點標題",
    generatedImageAlt: "生成的圖片",
    previewFailedRetry: "預覽載入失敗——重試",
    mock: "模擬",
  },
  status: {
    generating: "生成中",
    generatingEllipsis: "生成中…",
    merging: "拼接中",
    mergingEllipsis: "拼接中…",
    queued: "排隊中",
    paused: "已暫停",
    failed: "失敗",
    cancelled: "已取消",
    notGenerated: "未生成",
    notGeneratedYet: "尚未生成",
    noFileYet: "還沒有檔案",
    renderCancelled: "生成已取消",
    renderFailed: "生成失敗",
    mergeCancelled: "拼接已取消",
    mergeFailed: "拼接失敗",
  },
  upload: {
    uploading: (percent) => `上傳中 ${percent}%`,
    noneYet: (kind) => `還沒有上傳${kind}`,
    choose: (kind) => `選擇${kind}`,
    orDrop: "或將檔案拖到這裡",
    wrongType: (file, kind) => `${file}：這個節點只接受${kind}檔案`,
    failed: "上傳失敗",
    unsupported: (file) =>
      `${file}：不支援的格式（圖片：JPEG/PNG/WebP，影片：MP4/MOV，音訊：MP3/WAV/M4A）`,
    tooLarge: (file, maxMb, kind) => `${file}：檔案過大（${kind}上限 ${maxMb}MB）`,
  },
  concat: {
    generateUpstreamFirst: (n) => `請先生成上游的 ${n} 段影片`,
    connectAtLeastTwo: (n) => `至少連接兩段影片（目前 ${n} 段）`,
    stillGenerating: (total, pending) => `共 ${total} 段——${pending} 段仍在生成`,
    hoverToPreview: (n) => `共 ${n} 段——滑過即可預覽`,
    emptyClips: "連接影片節點，它們會依序排在這裡。",
    openVideoNode: "開啟這個影片節點",
  },
  inputs: {
    summary: (parts, waiting) => {
      const unit: Record<CanvasIoType, string> = {
        image: "張圖片",
        video: "段影片",
        audio: "段音訊",
      };
      const items = parts.map((p) => `${p.count} ${unit[p.type]}`);
      if (waiting > 0) items.push(`${waiting} 路待就緒`);
      return `來自 ${items.join("、")}`;
    },
    heading: (n) => `輸入 · ${n}`,
    notReadyYet: "尚未就緒",
    notUsedInGeneration: "生成時不會使用",
    previewFailed: "預覽載入失敗",
    linkedInputAlt: "關聯的輸入",
  },
  composer: {
    drawerTitle: "節點提示詞",
    collapse: "收合",
    promptAria: "提示詞",
    promptPlaceholder: "描述你想生成的內容…",
  },
  mediaDialog: {
    description: "這個節點產出內容的大圖預覽",
  },
  attachments: {
    listAria: "附件",
    skip: {
      pending: "尚未就緒",
      type: "這個節點不接受這類輸入",
      frame: "這個模型從單一影格起步——只會使用第一張圖片",
      limit: "超出這個模型的數量上限——不會使用",
    },
    goToNode: (name) => `${name}。跳至節點`,
    mockOutput: "模擬產出 · ",
    previewUnavailable: "預覽無法使用 · 點擊開啟節點",
    clickToOpen: "點擊開啟節點",
    stateClickToOpen: (state) => `${state} · 點擊開啟節點`,
  },
  model: {
    generating: "生成中…",
    regenerate: "重新生成",
    generate: "生成",
    loading: "正在載入模型…",
    none: "沒有可用模型",
    pickerTitle: "模型",
    settingsTitle: "生成設定",
    modeFrames: "首尾影格",
    modeFramesShort: "首尾影格",
    modeReference: "參考",
    modeReferenceShort: "參考",
    mode: "模式",
    modeHelp: "參考：上游圖片用來引導主體與風格。首尾影格模式尚未開放。",
    modeFirstFrameOnly: "這個模型只會把上游圖片當作首格。",
    audioTitle: (value) => `音訊：${value}`,
    audioOff: "音訊已關閉",
    audioAria: (value) => `音訊 ${value}`,
    notUsedWithInputs: "目前的輸入下不會使用",
    someLimited: "部分選項受其他設定或輸入限制",
    about: (label) => `關於${label}`,
    notAvailable: "目前的設定下無法使用",
  },
  params: {
    auto: "自動",
    on: "開",
    off: "關",
    labels: {
      aspect_ratio: "比例",
      resolution: "解析度",
      duration: "長度",
      with_audio: "音訊",
      thinking: "思考",
      background: "背景",
      quality: "品質",
    },
    acceptsCjkLabels: true,
  },
  boardToast: {
    retryFailed: "重試失敗",
    generationFailed: "生成失敗",
    mergeFailed: "拼接失敗",
    pauseFailed: "暫停失敗",
    resumeFailed: "繼續失敗",
    focusFailed: "更新圈定的節點失敗",
    pausedSome: (paused: number, skipped: number) =>
      `已暫停 ${paused} 個 · ${skipped} 個已提交給模型，會繼續跑完`,
    cannotPause: "已經提交給模型，暫停不了",
    notLoaded: "畫布還沒載入好",
  },
  saveStatus: {
    saving: "儲存中…",
    saved: "已儲存",
    failed: "儲存失敗，已重新載入",
  },
};

export const CANVAS_MESSAGES: Record<CanvasLocale, CanvasMessages> = {
  en,
  "zh-CN": zhCN,
  "zh-Hant": zhHant,
};
