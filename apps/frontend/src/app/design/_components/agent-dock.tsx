"use client";

import {
  DESIGN_MODELS,
  type DesignModel,
  type ImageLayer,
  type ImageModelChoice,
  type Layer,
} from "@agent-test/design-schema";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Hourglass,
  ImagePlus,
  Layers,
  Lightbulb,
  Loader2,
  Paperclip,
  ScanEye,
  Scissors,
  Settings2,
  Square,
  Wand2,
  X,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { type DesignAttachment, type DesignImageModel, designApi } from "../_lib/api";
import { type ChatItem, type ChatState, describeTool } from "../_lib/chat";
import { type DesignStore, useEditor } from "../_lib/store";

interface PendingAttachment {
  key: string;
  file: File;
  preview: string;
  progress: number;
  uploaded?: DesignAttachment;
  error?: string;
}

/** 外部（属性面板的「拆分」等）直接替用户发一条请求。 */
export interface AgentDockController {
  sendExternal: (req: { text: string; splitLayerId?: string }) => void;
}

const TOOL_ICON: Record<string, typeof Layers> = {
  add_layers: Layers,
  update_layers: Settings2,
  generate_layer_image: Wand2,
  wait_for_layers: Hourglass,
  render_preview: ScanEye,
  decompose_layer: Scissors,
  inspect_layers: ScanEye,
};

/**
 * 底部居中的 agent 输入框（问题 15）：默认收起成一颗状态胶囊，聚焦后向上展开成对话浮层。
 * 收起时也能看出 agent 在干什么（当前步骤流光文字 + 生成进度），这是「智能感」的主要出口之一。
 */
export function AgentDock({
  store,
  chat,
  model,
  onModelChange,
  imageModels,
  imageChoice,
  onImageChoiceChange,
  controllerRef,
}: {
  store: DesignStore;
  chat: ChatState;
  model: DesignModel;
  onModelChange: (m: DesignModel) => void;
  imageModels: DesignImageModel[];
  imageChoice: ImageModelChoice | null;
  onImageChoiceChange: (c: ImageModelChoice) => void;
  controllerRef: RefObject<AgentDockController | null>;
}) {
  const docId = useEditor(store, (s) => s.docId);
  const status = useEditor(store, (s) => s.status);
  const selection = useEditor(store, (s) => s.selection);
  const doc = useEditor(store, (s) => s.doc);
  const focus = useEditor(store, (s) => s.focus);
  const running = status === "running";

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [useSelection, setUseSelection] = useState(true);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const layerById = useMemo(() => new Map(doc.layers.map((l) => [l.id, l])), [doc.layers]);
  const generatingCount = doc.layers.filter((l) => l.type === "image" && l.status === "generating").length;
  const runningTool = [...chat.items].reverse().find((i) => i.kind === "tool" && i.status === "running");
  const liveLabel = running
    ? runningTool?.kind === "tool"
      ? describeTool(runningTool.name, runningTool.args)
      : (focus?.action ?? (chat.items[chat.items.length - 1]?.kind === "thinking" ? "思考中" : "理解需求"))
    : null;

  // 「/」唤起输入框（不在输入控件里时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 点外面收起（输入为空、没有附件时；运行中也允许收起，胶囊会继续显示进度）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      // 下拉菜单渲染在 portal 里，点它不算点外面
      if (e.target instanceof Element && e.target.closest("[data-slot=select-content]")) return;
      if (!text.trim() && files.length === 0) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, text, files.length]);

  // 新消息滚到底——只在本来就停在底部附近时跟随：往上翻着看思考 / 展开工具详情时别被拽走
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, open]);

  const addFiles = (list: FileList | File[]) => {
    const imgs = [...list].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (imgs.length < [...list].length) toast.message("只支持 PNG / JPG / WebP 图片");
    for (const file of imgs.slice(0, 8 - files.length)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`;
      const item: PendingAttachment = { key, file, preview: URL.createObjectURL(file), progress: 0 };
      setFiles((fs) => [...fs, item]);
      designApi
        .upload(docId, file, {
          onProgress: (p) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, progress: p } : f))),
        })
        .then((stored) =>
          setFiles((fs) =>
            fs.map((f) =>
              f.key === key
                ? {
                    ...f,
                    progress: 1,
                    uploaded: { url: stored.url, filename: file.name, width: stored.width, height: stored.height },
                  }
                : f,
            ),
          ),
        )
        .catch((e: unknown) =>
          setFiles((fs) =>
            fs.map((f) => (f.key === key ? { ...f, error: e instanceof Error ? e.message : String(e) } : f)),
          ),
        );
    }
    setOpen(true);
  };

  const uploading = files.some((f) => !f.uploaded && !f.error);

  const send = async (override?: { text: string; splitLayerId?: string }) => {
    const body = (override?.text ?? text).trim();
    const attachments = override ? [] : files.flatMap((f) => (f.uploaded ? [f.uploaded] : []));
    if ((!body && attachments.length === 0) || running || sending) return;
    setSending(true);
    try {
      await designApi.send(
        docId,
        {
          text: body,
          attachments,
          selection: useSelection ? selection : [],
          ...(override?.splitLayerId ? { splitLayerId: override.splitLayerId } : {}),
        },
        model,
      );
      if (!override) {
        setText("");
        files.forEach((f) => URL.revokeObjectURL(f.preview));
        setFiles([]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // 外部请求（属性面板的「拆分」）：展开对话浮层并直接发出
  useEffect(() => {
    controllerRef.current = {
      sendExternal: (req) => {
        setOpen(true);
        void send(req);
      },
    };
  });

  const suggestions = useMemo(() => {
    const sel = doc.layers.filter((l) => selection.includes(l.id));
    if (sel.length === 1 && sel[0].type === "image") {
      return ["把这张图拆成可编辑图层", "让这个元素更有质感", "换一个角度重新生成"];
    }
    if (sel.length === 1 && sel[0].type === "text") {
      return ["标题更有冲击力", "换一款更高级的字体", "给它配一句英文副标题"];
    }
    if (doc.layers.length === 0) {
      return [
        "为一款燕麦拿铁做 4:5 新品海报，秋季限定",
        "复刻我上传的参考图，拆成可编辑图层",
        "用我的产品图做一张电商主图",
      ];
    }
    return ["整体换成暖色调", "检查版面并优化排版", "加一个醒目的行动号召按钮"];
  }, [doc.layers, selection]);

  const imageModel = imageModels.find((m) => m.channel === imageChoice?.channel && m.model === imageChoice?.model) ?? imageModels[0];

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div
        className={cn(
          "pointer-events-auto relative w-full overflow-hidden border bg-card shadow-lg transition-[max-width,border-radius] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
          // 收起态用 24px（= 48px 高的一半）而不是 rounded-full：从 9999px 过渡到 16px 的中间帧会变成椭圆
          open ? "max-w-[720px] rounded-2xl" : "max-w-[460px] rounded-[24px]",
          running ? "border-agent/40" : "border-border",
          dragOver && "ring-2 ring-agent",
        )}
      >
        {!open ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="relative flex h-12 w-full items-center gap-3 px-4 text-left"
          >
            <AgentMark running={running} />
            {running && liveLabel ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate text-sm">
                <span className="truncate font-medium text-foreground">{liveLabel}</span>
                {generatingCount > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {generatingCount} 个图层生成中
                  </span>
                )}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                描述你想要的设计，或拖一张参考图进来…
              </span>
            )}
            <kbd className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              /
            </kbd>
          </button>
        ) : (
          <div className="relative flex max-h-[min(72vh,760px)] flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
              <AgentMark running={running} />
              <span className="text-sm font-semibold">Agent</span>
              {running && liveLabel && (
                <span className="truncate text-xs text-muted-foreground">{liveLabel}</span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="收起"
                onClick={() => setOpen(false)}
              >
                <ChevronDown />
              </Button>
            </div>

            <div
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
            >
              {chat.items.length === 0 ? (
                <EmptyState />
              ) : (
                <ChatList
                  items={chat.items}
                  layers={layerById}
                  running={running}
                  onSelectLayer={(id) => store.select([id])}
                />
              )}
            </div>

            <div className="shrink-0 space-y-2 border-t border-border px-3 pt-2.5 pb-3">
              {!running && (
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setText(s);
                        inputRef.current?.focus();
                      }}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {(files.length > 0 || (selection.length > 0 && useSelection)) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {selection.length > 0 && useSelection && (
                    <Chip onRemove={() => setUseSelection(false)}>
                      <Layers className="size-3" />
                      已选 {selection.length} 个图层
                    </Chip>
                  )}
                  {files.map((f) => (
                    <div key={f.key} className="relative size-12 overflow-hidden rounded-lg ring-1 ring-border">
                      {/* eslint-disable-next-line @next/next/no-img-element -- 本地预览 blob */}
                      <img src={f.preview} alt={f.file.name} className="size-full object-cover" />
                      {!f.uploaded && !f.error && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                          <Loader2 className="size-4 animate-spin text-agent" />
                        </div>
                      )}
                      {f.error && (
                        <div className="absolute inset-0 flex items-center justify-center bg-destructive/40" title={f.error}>
                          <CircleAlert className="size-4 text-destructive-foreground" />
                        </div>
                      )}
                      <button
                        type="button"
                        aria-label="移除附件"
                        onClick={() => {
                          URL.revokeObjectURL(f.preview);
                          setFiles((fs) => fs.filter((x) => x.key !== f.key));
                        }}
                        className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!uploading) void send();
                  }
                  if (e.key === "Escape") setOpen(false);
                }}
                rows={2}
                placeholder={running ? "Agent 正在工作，你可以继续手动编辑…" : "说说要做什么：用途、尺寸、风格、文案…（Enter 发送，Shift+Enter 换行）"}
                className="max-h-40 min-h-12 w-full resize-none bg-transparent px-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Button variant="ghost" size="icon-sm" aria-label="添加参考图" title="添加参考图 / 产品图" onClick={() => fileRef.current?.click()}>
                  <Paperclip />
                </Button>
                <Select
                  items={Object.fromEntries(DESIGN_MODELS.map((m) => [m.id, m.label]))}
                  value={model}
                  onValueChange={(v) => {
                    const m = DESIGN_MODELS.find((x) => x.id === v);
                    if (m) onModelChange(m.id);
                  }}
                >
                  <SelectTrigger size="sm" className="h-7 border-0 bg-muted/60 text-xs" aria-label="LLM 模型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DESIGN_MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="flex flex-col">
                          <span>{m.label}</span>
                          <span className="text-[10px] text-muted-foreground">{m.hint}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {imageModel && (
                  <>
                    <Select
                      items={Object.fromEntries(imageModels.map((m) => [`${m.channel}/${m.model}`, m.label]))}
                      value={`${imageModel.channel}/${imageModel.model}`}
                      onValueChange={(v) => {
                        const m = imageModels.find((x) => `${x.channel}/${x.model}` === v);
                        if (m) {
                          onImageChoiceChange({
                            channel: m.channel,
                            model: m.model,
                            resolution: imageChoice?.resolution ?? "medium",
                          });
                        }
                      }}
                    >
                      <SelectTrigger size="sm" className="h-7 border-0 bg-muted/60 text-xs" aria-label="图片生成模型">
                        <ImagePlus className="size-3.5" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {imageModels.map((m) => (
                          <SelectItem key={`${m.channel}/${m.model}`} value={`${m.channel}/${m.model}`}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      items={Object.fromEntries(imageModel.resolutions.map((r) => [r.value, r.label]))}
                      value={imageChoice?.resolution ?? "medium"}
                      onValueChange={(v) => {
                        if (typeof v === "string") {
                          onImageChoiceChange({ channel: imageModel.channel, model: imageModel.model, resolution: v });
                        }
                      }}
                    >
                      <SelectTrigger size="sm" className="h-7 border-0 bg-muted/60 text-xs" aria-label="画质">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {imageModel.resolutions.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
                <div className="ml-auto">
                  {running ? (
                    <Button
                      size="icon-sm"
                      variant="secondary"
                      aria-label="停止"
                      title="停止"
                      onClick={() => void designApi.stop(docId).catch((e: unknown) => toast.error(String(e)))}
                    >
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      size="icon-sm"
                      aria-label="发送"
                      disabled={sending || uploading || (!text.trim() && !files.some((f) => f.uploaded))}
                      onClick={() => void send()}
                      className="rounded-full"
                    >
                      {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** agent 的标识：一个 agent 色实心点（协作者的「在线点」）；运行中闪烁表示正在工作。 */
function AgentMark({ running }: { running: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full bg-agent", running && "animate-pulse motion-reduce:animate-none")}
    />
  );
}

function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-selection/10 py-0.5 pr-1 pl-2 text-xs text-selection">
      {children}
      <button type="button" aria-label="不带上选中图层" onClick={onRemove} className="rounded-full p-0.5 hover:bg-selection/15">
        <X className="size-3" />
      </button>
    </span>
  );
}

/** 空状态讲清楚怎么用（产出是什么、能怎么继续），而不是自我介绍。 */
function EmptyState() {
  return (
    <div className="max-w-[60ch] space-y-1.5 py-2 text-sm leading-relaxed text-muted-foreground">
      <p>
        写清楚<span className="text-foreground">用途、尺寸和文案</span>，Agent
        会把文字排成文字图层、把主体和装饰生成为透明图层，背景单独一层。
      </p>
      <p>拖一张参考图或产品图进来，可以让它复刻成可编辑图层，或围绕产品出海报。生成后每一层都能手动接着改。</p>
    </div>
  );
}

function ChatList({
  items,
  layers,
  running,
  onSelectLayer,
}: {
  items: ChatItem[];
  layers: Map<string, Layer>;
  running: boolean;
  onSelectLayer: (id: string) => void;
}) {
  // 相邻的思考与工具调用合并成一个可收起的活动组；正文、用户消息、提示各自单列。
  // 「等待生成」没指定图层时等的是本轮提交过的全部：按轮累计，给它补上
  const groups: (ChatItem | ActivityItem[])[] = [];
  let turnIds: string[] = [];
  for (const raw of items) {
    if (raw.kind === "user") turnIds = [];
    let it = raw;
    if (it.kind === "tool") {
      if (it.name === "wait_for_layers" && it.layerIds.length === 0) it = { ...it, layerIds: turnIds };
      else if (it.name !== "wait_for_layers") turnIds = [...new Set([...turnIds, ...it.layerIds])];
    }
    const last = groups[groups.length - 1];
    if (it.kind === "tool" || it.kind === "thinking") {
      if (Array.isArray(last)) last.push(it);
      else groups.push([it]);
    } else {
      groups.push(it);
    }
  }
  // 发出去之后、第一段思考 / 第一个工具到来之前（排队、加载上下文、模型首包）：先挂一个进行中的占位组
  const lastItem = items[items.length - 1];
  const pendingSince = running && lastItem?.kind === "user" ? lastItem.at : null;
  return (
    <div className="space-y-3">
      {groups.map((g, i) =>
        Array.isArray(g) && !g.some((x) => x.kind === "tool") ? (
          // 只有思考、没有工具调用（如最后回复前的那段）：不要组头，直接一行可展开的思考
          <ol key={g[0].id} className="space-y-2 text-xs">
            {g.map((x) => (
              <ThinkingRow
                key={x.id}
                text={x.kind === "thinking" ? x.text : ""}
                live={running && i === groups.length - 1 && x === g[g.length - 1]}
              />
            ))}
          </ol>
        ) : Array.isArray(g) ? (
          <ActivityGroup
            key={g[0].id}
            items={g}
            // 只有列表末尾那组、且本轮还在跑，才算「进行中」
            live={running && i === groups.length - 1}
            layers={layers}
            onSelectLayer={onSelectLayer}
          />
        ) : g.kind === "user" ? (
          <div key={g.id} className="flex flex-col items-end gap-1.5">
            {g.attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {g.attachments.map((a) => (
                  // eslint-disable-next-line @next/next/no-img-element -- CDN 附件缩略图
                  <img key={a.url} src={a.url} alt={a.filename} className="size-14 rounded-lg object-cover ring-1 ring-border" />
                ))}
              </div>
            )}
            {g.text && (
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                {g.text}
              </div>
            )}
          </div>
        ) : g.kind === "assistant" ? (
          <div key={g.id}>
            <div className="max-w-[65ch] min-w-0 text-sm leading-relaxed [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-4">
              <ReactMarkdown>{g.text}</ReactMarkdown>
              {g.streaming && <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-foreground align-middle motion-reduce:animate-none" />}
            </div>
          </div>
        ) : g.kind === "error" ? (
          <div key={g.id} className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" title={g.message}>
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {/* 上游报错可能是几十行的原始响应：只露前几行，完整内容在悬停提示里 */}
            <span className="line-clamp-4 break-all">{g.message}</span>
          </div>
        ) : g.kind === "note" ? (
          <p key={g.id} className="text-xs text-muted-foreground">
            {g.text}
          </p>
        ) : null,
      )}
      {pendingSince != null && <PendingActivity since={pendingSince} />}
    </div>
  );
}

/** 刚发出、还没有任何思考 / 工具事件时的占位：和活动组同款组头，计时从发送那一刻起。 */
function PendingActivity({ since }: { since: number }) {
  return (
    <div className="text-xs" aria-live="polite">
      <div className="flex items-center gap-2 border-b border-border pb-2 font-medium text-foreground">
        <StepIcon status="running" />
        <span className="tabular-nums">
          进行中 · <LiveDuration since={since} />
        </span>
      </div>
      <p className="flex items-center gap-2 pt-2.5 text-muted-foreground">
        <Lightbulb className="size-3.5 shrink-0 animate-pulse text-agent motion-reduce:animate-none" aria-hidden />
        思考中…
      </p>
    </div>
  );
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;
type ActivityItem = ToolItem | ThinkingItem;

/** 生成进度：这一步涉及的图片图层里，已经结束（成功或失败）的有几个。 */
function genProgress(ids: string[], layers: Map<string, Layer>) {
  const all = [...layers.values()];
  const tracked = [
    ...new Set(
      ids.flatMap((id) => {
        const l = layers.get(id);
        if (l) return l.type === "image" ? [l] : [];
        // 拆层完成后原图层被子图层替换：改为跟踪它拆出来的子图层
        return all.filter((c): c is ImageLayer => c.type === "image" && c.generation?.sourceLayerId === id);
      }),
    ),
  ];
  return {
    tracked,
    done: tracked.filter((l) => l.status !== "generating").length,
    failed: tracked.filter((l) => l.status === "error").length,
  };
}

/** 工具步骤的实际状态：等待类以图层真实状态为准（工具早已返回「超时」，图后来生成完也算完成）。 */
function stepStatus(it: ToolItem, layers: Map<string, Layer>): ToolItem["status"] {
  const { tracked, done, failed } = genProgress(it.layerIds, layers);
  if (it.name !== "wait_for_layers" || !tracked.length || it.status === "running" || it.status === "stopped") {
    return it.status;
  }
  return done < tracked.length ? "running" : failed ? "error" : "done";
}

/** 秒数 → 「26 秒」「1 分 05 秒」 */
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

/** 每秒跳一次的时钟（只有进行中的活动组订阅；没人订阅时计时器自动停）。 */
let clockNow = 0;
let clockTimer: number | undefined;
const clockListeners = new Set<() => void>();
function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
function LiveDuration({ since }: { since: number }) {
  const now = useSyncExternalStore(subscribeClock, () => clockNow, () => 0);
  return <>{formatDuration(now ? now - since : 0)}</>;
}

/**
 * 一组相邻的思考与工具调用：组头写「进行中 · 26 秒」/「已完成 · 7 步 · 1 分 05 秒」，可整组收起。
 * 进行中默认展开、结束后自动收起；手动点过就以用户的选择为准。
 */
function ActivityGroup({
  items,
  live,
  layers,
  onSelectLayer,
}: {
  items: ActivityItem[];
  live: boolean;
  layers: Map<string, Layer>;
  onSelectLayer: (id: string) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const tools = items.filter((i): i is ToolItem => i.kind === "tool");
  const statuses = tools.map((t) => stepStatus(t, layers));
  const busy = live || statuses.includes("running");
  const state = busy
    ? "running"
    : statuses.includes("error")
      ? "error"
      : statuses.includes("stopped")
        ? "stopped"
        : "done";
  const open = manual ?? busy;
  const start = items[0].at;
  const end = Math.max(...items.map((i) => (i.kind === "tool" ? (i.endAt ?? i.at) : i.at)));
  const steps = `${tools.length} 步`;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 pb-2 text-left font-medium",
          open && "border-b border-border",
          busy ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <StepIcon status={state} />
        <span className="tabular-nums">
          {state === "running" ? (
            <>
              进行中 · <LiveDuration since={start} />
            </>
          ) : state === "stopped" ? (
            `已停止 · ${steps}`
          ) : (
            `${state === "error" ? "部分出错" : "已完成"} · ${steps} · ${formatDuration(end - start)}`
          )}
        </span>
        <ChevronDown
          className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="space-y-2 pt-2.5">
          {items.map((it) =>
            it.kind === "tool" ? (
              <ToolStep key={it.id} item={it} layers={layers} onSelectLayer={onSelectLayer} />
            ) : (
              <ThinkingRow key={it.id} text={it.text} live={live && it === items[items.length - 1]} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

/**
 * 一步工具调用：类型图标（进行中转圈）+ 人话标签 + 结果首行；点开看完整的调用参数与返回。
 * 涉及生图的步骤下面列出相关图层，状态读画板上的实时数据。
 */
function ToolStep({
  item: it,
  layers,
  onSelectLayer,
}: {
  item: ToolItem;
  layers: Map<string, Layer>;
  onSelectLayer: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[it.name] ?? Settings2;
  const { tracked, done, failed } = genProgress(it.layerIds, layers);
  const status = stepStatus(it, layers);
  const resultLine = it.result?.split("\n").find((l) => l.trim()) ?? "";
  const args = Object.keys(it.args).length ? JSON.stringify(it.args, null, 2) : "";
  return (
    <li className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-left"
      >
        {status === "done" ? (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <StepIcon status={status} />
        )}
        <span className={cn("min-w-0", status === "running" ? "text-foreground" : "text-muted-foreground")}>
          {describeTool(it.name, it.args)}
          {tracked.length > 0 && (
            <span className="ml-1.5 tabular-nums">
              {done}/{tracked.length} 已完成{failed > 0 && ` · ${failed} 失败`}
            </span>
          )}
          {it.status === "stopped" && <span className="ml-1.5">已停止</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground/60">
          <span className="font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100 group-aria-expanded:opacity-100">
            {it.name}
          </span>
          <ChevronRight
            className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")}
            aria-hidden
          />
        </span>
      </button>
      {!open && resultLine && (
        <p className="truncate pl-5.5 text-[11px] text-muted-foreground/80">{resultLine}</p>
      )}
      {open && (
        <div className="ml-5.5 space-y-2 rounded-lg border border-border bg-muted/40 p-2.5">
          {args && <ToolDetail title="参数" body={args} />}
          {it.result ? (
            <ToolDetail title="返回" body={it.result} />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {it.status === "running" ? "执行中…" : "没有返回内容"}
            </p>
          )}
        </div>
      )}
      {tracked.length > 0 && it.name !== "wait_for_layers" && (
        <div className="flex flex-wrap gap-1.5 pl-5.5">
          {tracked.map((l) => (
            <LayerChip key={l.id} layer={l} onClick={() => onSelectLayer(l.id)} />
          ))}
        </div>
      )}
    </li>
  );
}

function ToolDetail({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground/90">
        {body}
      </pre>
    </div>
  );
}

/** 思考的一行摘要：Gemini 的思考以「**小标题**」开头，取它；没有就取第一行。 */
function thinkingTitle(text: string): string {
  const heading = text.match(/\*\*(.+?)\*\*/)?.[1];
  return (heading ?? text.split("\n").find((l) => l.trim()) ?? "").replace(/\*\*/g, "").trim();
}

/** 组里的一段思考：收起时一行摘要，点开看全文（Markdown）；正在产生的那段默认展开。 */
function ThinkingRow({ text, live }: { text: string; live: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;
  return (
    <li className="space-y-1.5">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-left text-muted-foreground"
      >
        <Lightbulb className={cn("size-3.5 shrink-0", live && "text-agent")} aria-hidden />
        <span className="shrink-0">{live ? "思考中" : "思考"}</span>
        <span className="min-w-0 truncate text-muted-foreground/70">{thinkingTitle(text)}</span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground/60 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      {open && (
        // Gemini 的思考摘要是 Markdown（**小标题** + 段落）：按 Markdown 渲染，别把星号原样露出来
        <div className="ml-5.5 border-l-2 border-border pl-3 leading-relaxed text-muted-foreground [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1.5 [&_strong]:font-medium [&_strong]:text-foreground/80 [&_ul]:list-disc [&_ul]:pl-4">
          <ReactMarkdown>{text}</ReactMarkdown>
          {live && (
            <span className="inline-block h-3 w-px animate-pulse bg-muted-foreground align-middle motion-reduce:animate-none" />
          )}
        </div>
      )}
    </li>
  );
}

function StepIcon({ status }: { status: "running" | "done" | "error" | "stopped" }) {
  if (status === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-agent" />;
  if (status === "error") return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "stopped") return <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />;
  return <Check className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** 步骤下的图层缩略：生成中转圈、失败描红、完成显示图；点一下在画板上选中它。 */
function LayerChip({ layer, onClick }: { layer: Layer; onClick: () => void }) {
  if (layer.type !== "image") return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${layer.name}${layer.status === "error" && layer.generation?.error ? `：${layer.generation.error}` : ""}`}
      className={cn(
        "relative size-9 overflow-hidden rounded-md bg-[repeating-conic-gradient(var(--checker-a)_0_25%,var(--checker-b)_0_50%)] bg-size-[8px_8px] ring-1 transition-shadow hover:ring-foreground/40",
        layer.status === "error" ? "ring-destructive" : "ring-border",
      )}
    >
      {layer.src && (
        // eslint-disable-next-line @next/next/no-img-element -- CDN 上的生成图缩略
        <img src={layer.src} alt="" className="size-full object-contain" />
      )}
      {layer.status === "generating" && (
        <span className="absolute inset-0 flex items-center justify-center bg-background/60">
          <Loader2 className="size-3.5 animate-spin text-agent" />
        </span>
      )}
      {layer.status === "error" && (
        <span className="absolute inset-0 flex items-center justify-center bg-background/50">
          <CircleAlert className="size-3.5 text-destructive" />
        </span>
      )}
    </button>
  );
}
