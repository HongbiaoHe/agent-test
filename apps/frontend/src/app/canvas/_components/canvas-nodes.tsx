"use client";

import {
  Handle,
  Position,
  useConnection,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Download,
  Layers,
  Link2,
  Loader2,
  Maximize2,
  MessagesSquare,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useContext, useRef, useState } from "react";

import type { CanvasNodeDto, CanvasNodeType } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useMediaAsset } from "../_hooks/use-media-asset";
import {
  canConnectNodeTypes,
  type NodeInputSource,
} from "../_lib/node-io";
import {
  CanvasToolbar,
  CanvasToolbarButton,
  CanvasToolbarSeparator,
} from "./canvas-toolbar";
import { CanvasEditorContext } from "./flow-canvas";
import {
  NodeComposer,
  type ClipSource,
  type NodeBodyField,
} from "./node-composer";
import { NodeTitleField } from "./node-inline-field";
import { NodeMediaDialog } from "./node-media-dialog";
import { NodeModelControls } from "./node-model-controls";
import { NODE_META, NodeTypeIcon } from "./node-meta";
import { VideoSequence } from "./video-sequence";

/** react-flow 节点 data 即后端 CanvasNodeDto。 */
type NodeData = CanvasNodeDto & Record<string, unknown>;

/**
 * 拖线过程中，本节点相对于「线从哪儿出发」的关系：
 * 起点自己 / 能接 / 接不了。用来在拖拽期直接把接不了的节点压暗——
 * 光靠 isValidConnection 拦截，用户要拖到才知道不行。
 */
type ConnectFit = "idle" | "self" | "valid" | "invalid";

/**
 * 订阅「当前是否在拖线、从哪个节点的哪种端口出发」。
 *
 * 只取一个字符串而不是整个 connection 对象：connection 里带鼠标坐标，每一帧都变，
 * 直接订阅会让画布上每个节点都按帧重渲染。
 */
function useConnectFit(nodeId: string, nodeType: CanvasNodeType): ConnectFit {
  const from = useConnection((c) =>
    c.inProgress && c.fromNode
      ? `${c.fromNode.id}|${c.fromNode.type}|${c.fromHandle?.type ?? "source"}`
      : null,
  );
  if (!from) return "idle";
  const [id, type, handle] = from.split("|");
  if (id === nodeId) return "self";
  const source = handle === "source" ? (type as CanvasNodeType) : nodeType;
  const target = handle === "source" ? nodeType : (type as CanvasNodeType);
  return canConnectNodeTypes(source, target) ? "valid" : "invalid";
}

/**
 * 节点外壳：所有类型共用同一套骨架，只有「有没有主视觉」这一处差别。
 *
 * 结构自上而下固定为
 *   [标题行]（在卡片**外**的上方）身份色类型图标 + 标题（点一下就地改）+ 保存指示，
 *            hover 时操作药丸绝对定位盖在标题上
 *   [主视觉]（媒体节点出图/出片时才有）
 *   [正文] 文本节点是正文，媒体节点是这次会用的提示词
 *   [状态条] 未就绪 / 排队 / 生成中 / 失败 —— 一行说清，不再用整块灰色占位撑高卡片
 *   [关联输入]
 *
 * 标题为什么在卡外：出片后的媒体卡卡面只剩画面（mediaOnly），卡里没有标题的位置——
 * 而每个节点都该有名字。放到上方那行，四类节点的标题就在同一个地方、同一套改法。
 *
 * 之所以要统一：早先文本节点把类型压成 11px 灰字放最上面，媒体节点却把类型做成浮在封面上的
 * 深色胶囊，同一张画布上两套语言；而「还没生成」时那块 128px 的纯灰占位块信息量为零，
 * 几十个节点铺开就是几十个空洞。现在没有产出就不占那块高度。
 */
function NodeShell({
  nodeId,
  nodeType,
  selected,
  dragging,
  label,
  body,
  clips,
  modelControls,
  composerMeta,
  hero,
  mediaOnly,
  heroActions,
  status,
  footer,
  children,
  hasTarget,
  hasSource,
}: {
  nodeId: string;
  nodeType: CanvasNodeType;
  /** react-flow 选中态：决定编辑浮窗是否浮出 */
  selected: boolean;
  /** 正在拖拽：拖动期间隐藏浮窗 */
  dragging: boolean;
  label: string;
  /** composer 里的可编辑提示词（生成节点的 prompt） */
  body?: NodeBodyField;
  /** composer 里的待拼接视频序列（video_concat 专有） */
  clips?: ClipSource[];
  /** composer 里的模型区（生成节点专有）：选模型 / 选档位 / Generate */
  modelControls?: React.ReactNode;
  /** composer 参数条上的补充胶囊（上游来源摘要） */
  composerMeta?: React.ReactNode;
  /** 主视觉：出图/出片或生成中的骨架；没有产出时不传，卡片就不占那块高度 */
  hero?: React.ReactNode;
  /**
   * 出片之后卡面只留画面：标题、提示词、来源摘要一概不上卡。
   * 画面本身已经把"这是什么"说清楚了，再压三行字只会让一屏铺开的卡片糊成一片；
   * 那些信息点开编辑面板就有（同类画布一致的做法）。
   */
  mediaOnly?: boolean;
  /** 主视觉专属的悬浮操作（看大图 / 下载），排在通用操作左边 */
  heroActions?: React.ReactNode;
  /** 状态条：未就绪 / 排队 / 生成中 / 失败 */
  status?: React.ReactNode;
  /** 卡片最后一行的注脚（上游摘要）——永远排在状态条之后 */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  hasTarget?: boolean;
  hasSource?: boolean;
}) {
  const meta = NODE_META[nodeType];
  const fit = useConnectFit(nodeId, nodeType);
  // 被「加入对话」圈中的节点：卡片描一圈主色，标签行左侧多一枚对话角标——
  // agent 这一轮只看得到这些节点，得让人一眼认出是哪几张
  const { focusedNodeIds, selectedCount, readOnly, multiSelecting, groupSelect } =
    useContext(CanvasEditorContext);
  const focused = focusedNodeIds.has(nodeId);
  // 单选中的节点才进入可编辑态：标题就地可改，提示词面板浮出。
  // 两种情况不进：多选手势进行中（框到第一个节点时面板就弹出来挡路），
  // 以及选区是「按组选的」（那一个是被挑进组里的，该出多选工具条）。
  const single =
    selected && selectedCount <= 1 && !multiSelecting && !groupSelect;

  return (
    <div
      className={cn(
        "canvas-node group/node w-64 rounded-lg border border-border bg-card text-card-foreground",
        // 拖线中：接不了的节点整体压暗、能接的描一圈自己的端口色，
        // 于是「这根线能落在哪」在松手之前就看得见
        fit === "invalid" && "canvas-node--muted",
        fit === "valid" && "canvas-node--eligible",
        focused && "canvas-node--focused",
      )}
      // 内联设置 CSS 自定义属性 --tone；CSSProperties 不含自定义属性键，故就近断言（安全：仅注入颜色变量）
      style={{ "--tone": meta.tone } as React.CSSProperties}
    >
      {/* 选中时浮出的提示词面板（运行期不显示，见 NodeComposer）。
          触屏没有 hover，操作组改由面板（底部抽屉）承载，故一并传进去 */}
      <NodeComposer
        nodeId={nodeId}
        nodeType={nodeType}
        // 多选时不弹单节点面板：每个选中的节点都弹一个会糊满画布，
        // 这时该出现的是那条多选工具条（见 SelectionToolbar）
        selected={single}
        dragging={dragging}
        body={body}
        clips={clips}
        model={modelControls}
        meta={composerMeta}
        actions={<NodeActions nodeId={nodeId} extra={heroActions} plain />}
      />

      {/* 卡片外的上方一行：类型图标 + **标题**（点一下就地改），操作组 hover 才浮出、
          绝对定位盖在标题上。卡面因此只留内容本身——这是同类画布（Flora、即梦）的共同做法。
          标题放这儿而不是卡里：出片后的媒体卡卡面只剩画面，卡里没有它的位置。 */}
      <div className="canvas-node__above">
        <NodeTypeIcon type={nodeType} />
        <NodeTitleField
          nodeId={nodeId}
          value={label}
          placeholder={meta.label}
          editable={!readOnly}
        />
        {focused && (
          <span className="canvas-node__focus-tag" title="In chat context">
            <MessagesSquare className="size-2.5" aria-hidden />
            In chat
          </span>
        )}
        <SaveIndicator nodeId={nodeId} />
        <NodeActions nodeId={nodeId} extra={heroActions} />
      </div>

      {hasTarget && (
        <PlusHandle nodeId={nodeId} kind="target" />
      )}

      {hero}

      {!mediaOnly && (
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          {children}
          {status}
          {footer}
        </div>
      )}

      {hasSource && <PlusHandle nodeId={nodeId} kind="source" />}
    </div>
  );
}

/**
 * 端口。一枚控件两种手势：
 *  - 拖出去   = 连线（react-flow 原生行为）
 *  - 原地点击 = 在这一侧接一个新节点（弹出按类型过滤的菜单，同拖到空白处那一个）
 *
 * 点击必须显式处理：零位移的按下-抬起不会走 react-flow 的连接流程，事件会冒泡成
 * 「点了节点」→ 只是把节点选中。用按下点与抬起点的位移判断是不是「点」，
 * 超过 4px 就认定用户在拖线，交回 react-flow，不弹菜单。
 */
function PlusHandle({
  nodeId,
  kind,
}: {
  nodeId: string;
  kind: "source" | "target";
}) {
  const { readOnly, openConnectMenu } = useContext(CanvasEditorContext);
  const down = useRef<{ x: number; y: number } | null>(null);
  return (
    <Handle
      type={kind}
      position={kind === "source" ? Position.Right : Position.Left}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const from = down.current;
        down.current = null;
        if (readOnly || !from) return;
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;
        e.stopPropagation(); // 别让这一下连带把节点选中、弹出编辑面板
        openConnectMenu({
          nodeId,
          direction: kind === "source" ? "downstream" : "upstream",
          clientX: e.clientX,
          clientY: e.clientY,
        });
      }}
    />
  );
}

/**
 * 节点的操作组（看大图 / 下载 | 复制 / 删除）。
 *
 * 位置在**卡片外的上方**而不是压在卡面右上角：卡片右上角正好是媒体主视觉的位置，
 * 一浮出来就遮住画面；同类产品（n8n / Flora / 即梦）都把它做成脱离卡片的一条浮动药丸。
 * 显隐纯 CSS（见 globals.css .canvas-node__actions），不用 JS 判断断点——避免水合首帧的跳变。
 *
 * 药丸与按钮的样式/交互走 CanvasToolbar，与选区工具条（Add to chat 那条）同一套：
 * 两者停在同一个位置、做同一类事，长成两副样子只会让人以为它们不是一回事。
 *
 * 触屏没有 hover，改由编辑面板（底部抽屉）用 plain 形态承载。
 * 运行期（readOnly）只保留看图/下载这类只读操作，改结构的一律不渲染。
 */
function NodeActions({
  nodeId,
  extra,
  plain,
}: {
  nodeId: string;
  extra?: React.ReactNode;
  /** 平铺形态：不套药丸、不做 hover 显隐，供抽屉里直接摆一排 */
  plain?: boolean;
}) {
  const { readOnly, deleteNode, duplicateNode } =
    useContext(CanvasEditorContext);
  if (readOnly && !extra) return null;
  const structure = !readOnly && (
    <>
      <CanvasToolbarButton
        label="Duplicate"
        icon={<Copy className="size-3.5" />}
        onClick={() => duplicateNode(nodeId)}
      />
      <CanvasToolbarButton
        label="Delete"
        icon={<Trash2 className="size-3.5" />}
        danger
        onClick={() => deleteNode(nodeId)}
      />
    </>
  );
  const items = (
    <>
      {extra}
      {/* 看图类与改结构类之间划一道：误点删除的代价比误点下载大得多 */}
      {extra && structure && <CanvasToolbarSeparator />}
      {structure}
    </>
  );
  if (plain) {
    return <div className="nodrag flex items-center gap-0.5">{items}</div>;
  }
  return <CanvasToolbar className="canvas-node__actions">{items}</CanvasToolbar>;
}

/**
 * 这个节点自己的保存进度。画布左上角那枚是全局聚合的，看不出「刚才改的是哪张卡」，
 * 所以在类型行末尾补一枚——只在保存中/失败时出现，成功后短暂显示一个勾再消失。
 */
function SaveIndicator({ nodeId }: { nodeId: string }) {
  const { saveStates } = useContext(CanvasEditorContext);
  const state = saveStates[nodeId];
  if (!state) return null;
  if (state === "saving") {
    return (
      <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Saving
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
        <Check className="size-3" aria-hidden />
        Saved
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-1 text-[10px] text-destructive">
      <AlertTriangle className="size-3" aria-hidden />
      Not saved
    </span>
  );
}

/**
 * 状态条：一行说清这个节点此刻处在什么状态，必要时带一个能立刻按的按钮。
 * 只在「有话要说」时渲染——已经出图的节点不需要状态条，图本身就是状态。
 */
function StatusLine({
  icon,
  text,
  tone = "muted",
  action,
}: {
  icon?: React.ReactNode;
  text: string;
  tone?: "muted" | "danger";
  action?: { label: string; icon: React.ReactNode; onClick: () => void };
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[11px]",
        tone === "danger" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {action && (
        <button
          type="button"
          className="nodrag flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 font-medium underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </span>
  );
}

/** 主视觉外框：只收上面两角（下面接卡片正文），加载中/生成中叠一层高光横扫。 */
function HeroFrame({
  busy,
  full,
  onZoom,
  children,
}: {
  busy?: boolean;
  /** 媒体独占整张卡：四角都圆 */
  full?: boolean;
  /** 双击看大图（单击留给「选中 → 出编辑面板」） */
  onZoom?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn("canvas-node__hero", full && "canvas-node__hero--full")}
      onDoubleClick={
        onZoom &&
        ((e) => {
          e.stopPropagation(); // 别冒泡到画布容器，那里不该再收到这次双击
          onZoom();
        })
      }
    >
      {busy && <span className="canvas-node__shimmer" aria-hidden />}
      {children}
    </div>
  );
}

/**
 * 生成中 / 排队中 / 资产在途的主视觉骨架：一块会扫光的占位。
 * 视频比图更宽，按各自常见比例占位，出片时高度跳变小一些。
 *
 * 「在跑」这件事交给扫光动画本身表达，不再另起一行文字——一屏几十张卡时，
 * 每张都顶着一句「Rendering video…」只是噪音。到底是在跑还是在排队，
 * 用角上一枚小标签区分就够了（排队要等前面跑完，与"已经在跑"是两回事，不能不分）。
 */
function HeroSkeleton({
  kind,
  state,
  runningLabel = "Generating",
  full,
}: {
  kind: "image" | "video";
  /** 不传 = 只是资产在途（已 done，正在拉 blob），不必标注 */
  state?: "generating" | "queued";
  /** 「在跑」的措辞：生成说 Generating，拼接说 Merging */
  runningLabel?: string;
  /** 骨架就是卡面的全部（在跑时正文不渲染）：四角都要圆 */
  full?: boolean;
}) {
  return (
    <HeroFrame busy full={full}>
      <div className={kind === "video" ? "aspect-video" : "aspect-[4/3]"} />
      {state && <BusyBadge state={state} runningLabel={runningLabel} />}
    </HeroFrame>
  );
}

/** 骨架角上的状态角标：转圈=在跑，钟=在排队。与序列预览的段数角标同一套形态。 */
function BusyBadge({
  state,
  runningLabel,
}: {
  state: "generating" | "queued";
  runningLabel: string;
}) {
  const running = state === "generating";
  return (
    <span className="pointer-events-none absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded-full bg-foreground/75 px-1.5 py-0.5 text-[10px] text-background">
      {running ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden />
      ) : (
        <Clock className="size-2.5" aria-hidden />
      )}
      {running ? runningLabel : "Queued"}
    </span>
  );
}

/** 资产拉不到（文件被清、鉴权过期）：说清楚并给重试，别停在永远转的圈上。 */
function HeroLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <HeroFrame>
      <div className="flex h-20 flex-col items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <AlertTriangle className="size-4" aria-hidden />
        <button
          type="button"
          className="nodrag flex items-center gap-1 font-medium underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          <RotateCcw className="size-3" aria-hidden />
          Preview failed — retry
        </button>
      </div>
    </HeroFrame>
  );
}

/**
 * 已出图/出片的主视觉：满宽、按素材自己的比例铺开，**不裁切**——用户判断"这张行不行"
 * 靠的就是构图，`object-cover` 会把竖图裁成一条带。超过 224px 高的素材缩进框里留白
 * （框底色是 --muted，留白读起来像相纸边，不像缺角）。
 *
 * 视频在卡上只当静帧看（不给 controls）——小卡上的进度条既难点、又会跟拖拽抢手势，
 * 要播放点开灯箱。
 */
function HeroMedia({
  url,
  kind,
  title,
  onZoom,
}: {
  url: string;
  kind: "image" | "video";
  title: string;
  onZoom: () => void;
}) {
  // 满宽 + 高度按比例自适应：卡片高度因此**就是**素材的高度，既不留信箱黑边
  // （object-contain 撞上固定 max-height 时竖图两侧会空出灰带），也不裁掉构图
  // （object-cover 会把竖图切成一条）。卡面只剩画面之后，画面自己定卡片的形状。
  const fill = "pointer-events-none block h-auto w-full";
  return (
    <HeroFrame full onZoom={onZoom}>
      {kind === "image" ? (
        // 用原生 img：blob 源 next/image 无法优化
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={title || "Generated image"} className={fill} />
      ) : (
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          // 元数据到手前 <video> 用的是默认的 300×150（2:1），按它算出来的高度配上
          // object-fit:contain，画面上下会先留一截黑边——正是「视频没填满」。
          // 拿到真实尺寸后把比例钉死，盒子与画面从此完全同形。
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) {
              v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
            }
          }}
          className={fill}
        />
      )}
    </HeroFrame>
  );
}

/** blob mime → 下载文件名后缀。拿不到 mime 时按类型给个合理缺省。 */
function extFor(mime: string, kind: "image" | "video"): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  return kind === "video" ? "mp4" : "png";
}

/** 生成节点卡面上的提示词摘要——就是这个节点自己的 prompt 字段。 */
function NodePrompt({ prompt }: { prompt: string }) {
  if (!prompt) return null;
  return (
    <p className="line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
      {prompt}
    </p>
  );
}

/**
 * 卡片底部的关联输入摘要：这个节点由哪几路上游喂进来。
 * 按 output 类型计数；上游还没就绪的（正文为空 / 尚未生成）单独记为 waiting，
 * 因为触发生成时它们不会被引用——这一点光看连线是看不出来的。
 */
function summarizeInputs(inputs: NodeInputSource[]): string | null {
  if (inputs.length === 0) return null;

  const counts = new Map<string, number>();
  let waiting = 0;
  for (const s of inputs) {
    if (s.outputs.length === 0) {
      waiting++;
      continue;
    }
    for (const o of s.outputs) {
      counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    }
  }

  const parts = [...counts].map(([type, n]) => `${n} ${type}`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return `From ${parts.join(", ")}`;
}

function InputSummary({ inputs }: { inputs: NodeInputSource[] }) {
  const summary = summarizeInputs(inputs);
  if (!summary) return null;
  return (
    <span className="canvas-node__inputs">
      <span className="truncate">{summary}</span>
    </span>
  );
}

function ImageUploadNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  return (
    <NodeShell
      nodeId={d.id}
      nodeType="image_upload"
      selected={!!selected}
      dragging={!!dragging}
      label={d.label ?? ""}
      status={
        d.assetPath ? undefined : <StatusLine text="No image attached yet" />
      }
      hasSource
    >
      {d.assetPath && (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {d.assetPath}
        </p>
      )}
    </NodeShell>
  );
}

/**
 * 生图 / 生视频节点共用一套实现——两者的差别只有类型、素材种类与占位比例。
 *
 * 状态语言（按 mediaStatus）：出片即以片为主，没出片就一行状态条说清卡在哪一步，
 * 失败时给「Retry」直接重发同一版（沿用上一版的提示词与参考图，见后端 regenerate）。
 */
function MediaGenNode({
  data,
  selected,
  dragging,
  nodeType,
  kind,
}: {
  data: NodeData;
  selected: boolean;
  dragging: boolean;
  nodeType: "image_gen" | "video_gen";
  kind: "image" | "video";
}) {
  const { resolveInputs, retryMedia, readOnly } =
    useContext(CanvasEditorContext);
  const inputs = resolveInputs(data.id);
  // 提示词是这个节点自己的字段（入边只提供参考图）
  const prompt = data.prompt?.trim() ?? "";
  const title = data.label?.trim() || NODE_META[nodeType].label;
  const [zoom, setZoom] = useState(false);

  // 资产在本层取：主视觉与右上角的「看大图 / 下载」都要用同一份 blob URL，
  // 分头各取会拉两遍。未 done 时传 null，hook 不发请求。
  const done = data.mediaStatus === "done" && !!data.mediaVersionId;
  const asset = useMediaAsset(done ? data.mediaVersionId : null);

  const download = () => {
    if (asset.status !== "ready") return;
    const a = document.createElement("a");
    a.href = asset.url;
    a.download = `${title}.${extFor(asset.mime, kind)}`;
    a.click();
  };

  // 卡面只留画面的两种情形：出片且资产就绪，以及**正在跑**。
  // 在跑时同样只留骨架 + 角标——标题与提示词在这时候帮不上忙，
  // 一屏几十张卡各顶三行字，反而看不出哪几张在动。要看内容点开面板。
  const busyNow =
    data.mediaStatus === "generating" || data.mediaStatus === "queued";
  const mediaOnly = (done && asset.status === "ready") || busyNow;

  let hero: React.ReactNode = null;
  if (done) {
    hero =
      asset.status === "ready" ? (
        <HeroMedia
          url={asset.url}
          kind={kind}
          title={title}
          onZoom={() => setZoom(true)}
        />
      ) : asset.status === "error" ? (
        <HeroLoadError onRetry={asset.retry} />
      ) : (
        <HeroSkeleton kind={kind} />
      );
  } else if (
    data.mediaStatus === "generating" ||
    data.mediaStatus === "queued"
  ) {
    // 排队中同样出骨架：队列并发有限，后面的任务要等前面跑完，
    // 不给占位的话这些节点看起来像根本没被触发。两者靠骨架上的角标区分。
    hero = <HeroSkeleton kind={kind} state={data.mediaStatus} full />;
  }

  const heroActions =
    asset.status === "ready" ? (
      <>
        <CanvasToolbarButton
          label={kind === "video" ? "Play full size" : "View full size"}
          icon={<Maximize2 className="size-3.5" />}
          onClick={() => setZoom(true)}
        />
        <CanvasToolbarButton
          label="Download"
          icon={<Download className="size-3.5" />}
          onClick={download}
        />
      </>
    ) : null;

  // 在跑（generating / queued）时整条状态条都不出：骨架的扫光与角标已经说明进度。
  // 必须**整段跳过**——只删掉那两个分支的话会掉进末尾的 else，
  // 变成一边转圈一边写着「Ready — ask the agent to render it」。
  let status: React.ReactNode = null;
  if (!done && !busyNow) {
    if (data.mediaStatus === "failed") {
      status = (
        <StatusLine
          icon={<AlertTriangle className="size-3" aria-hidden />}
          tone="danger"
          text="Render failed"
          action={
            readOnly || !data.mediaGenerationId
              ? undefined
              : {
                  label: "Retry",
                  icon: <RotateCcw className="size-3" aria-hidden />,
                  onClick: () =>
                    retryMedia(data.mediaGenerationId as string),
                }
          }
        />
      );
    } else if (!prompt) {
      status = <StatusLine text="Empty prompt — click to write it" />;
    } else {
      // 生成入口在面板里（选中节点即浮出）：既能选模型也能直接按 Generate
      status = <StatusLine text="Ready — pick a model and generate" />;
    }
  }

  const shell = (
    <NodeShell
      nodeId={data.id}
      nodeType={nodeType}
      selected={selected}
      dragging={dragging}
      label={data.label ?? ""}
      // 提示词就地可编辑——它是这个节点自己的字段，不必再去别的卡上改
      body={{
        field: "prompt",
        value: data.prompt ?? "",
        placeholder: "Describe what to generate…",
      }}
      // 模型区紧跟提示词：确认了"用什么料"，接着就是"用哪个模型出"和"出"
      modelControls={
        <NodeModelControls
          nodeId={data.id}
          mediaType={kind}
          channel={data.mediaChannel}
          model={data.mediaModel}
          params={data.mediaParams}
          hasGeneration={!!data.mediaGenerationId}
          busy={busyNow}
        />
      }
      mediaOnly={mediaOnly}
      composerMeta={<InputsPill inputs={inputs} />}
      hero={hero}
      heroActions={heroActions}
      status={status}
      footer={<InputSummary inputs={inputs} />}
      hasTarget
      hasSource
    >
      <NodePrompt prompt={prompt} />
    </NodeShell>
  );

  return (
    <>
      {shell}
      {/* 灯箱挂在 NodeShell **外面**：卡面只剩画面时（mediaOnly）壳内的正文整段不渲染，
          放在里面会连它一起被跳过——表现为双击与「看大图」都没反应。
          它本身走 Portal 渲染到 body，挂在哪一层都不影响显示。 */}
      {asset.status === "ready" && (
        <NodeMediaDialog
          open={zoom}
          onOpenChange={setZoom}
          url={asset.url}
          kind={kind}
          title={title}
          onDownload={download}
        />
      )}
    </>
  );
}

function ImageGenNode({ data, selected, dragging }: NodeProps) {
  return (
    <MediaGenNode
      data={data as NodeData}
      selected={!!selected}
      dragging={!!dragging}
      nodeType="image_gen"
      kind="image"
    />
  );
}

function VideoGenNode({ data, selected, dragging }: NodeProps) {
  return (
    <MediaGenNode
      data={data as NodeData}
      selected={!!selected}
      dragging={!!dragging}
      nodeType="video_gen"
      kind="video"
    />
  );
}

/**
 * 视频拼接节点：把多段上游视频按入边顺序接成一条。
 *
 * 与生成节点的差别只有两处——素材来自上游视频而不是提示词，触发的是本地 ffmpeg 而不是模型；
 * 因此产物同样是一个 MediaVersion，出片后的形态（只剩画面、双击看大图、可作下游输入）
 * 与 video_gen 完全一致，这里复用同一套壳。
 *
 * 合成**不自动发生**：连上视频先给连续预览（悬停即按顺序播完），确认顺序对了再按 Merge。
 * 合成是要花时间的异步任务，和生成一样不该在连线的瞬间就替用户决定。
 */
function VideoConcatNode({ data, selected, dragging }: NodeProps) {
  const d = data as NodeData;
  const { resolveInputs, mergeVideo, readOnly } =
    useContext(CanvasEditorContext);
  const inputs = resolveInputs(d.id);
  const [zoom, setZoom] = useState(false);

  // 上游视频（按入边顺序）——顺序与后端 collectVideoSources 同源，预览与合成结果一致
  const clips = inputs.flatMap((s) =>
    s.outputs.filter((o) => o.type === "video").map((o) => o.content),
  );
  const title = d.label?.trim() || NODE_META.video_concat.label;
  const done = d.mediaStatus === "done" && !!d.mediaVersionId;
  const asset = useMediaAsset(done ? d.mediaVersionId : null);
  const busyNow = d.mediaStatus === "generating" || d.mediaStatus === "queued";
  const merged = done && asset.status === "ready";
  // 同生成节点：合成完只留成片，合成中只留骨架 + 角标
  const mediaOnly = merged || busyNow;

  const download = () => {
    if (asset.status !== "ready") return;
    const a = document.createElement("a");
    a.href = asset.url;
    a.download = `${title}.${extFor(asset.mime, "video")}`;
    a.click();
  };

  // 合成后放成片；没合成但有上游就放连续预览；都没有就不占那块高度
  let hero: React.ReactNode = null;
  if (merged) {
    hero = (
      <HeroMedia
        url={asset.url}
        kind="video"
        title={title}
        onZoom={() => setZoom(true)}
      />
    );
  } else if (done) {
    hero =
      asset.status === "error" ? (
        <HeroLoadError onRetry={asset.retry} />
      ) : (
        <HeroSkeleton kind="video" />
      );
  } else if (d.mediaStatus === "generating" || d.mediaStatus === "queued") {
    hero = (
      <HeroSkeleton
        kind="video"
        state={d.mediaStatus}
        runningLabel="Merging"
        full
      />
    );
  } else if (clips.length > 0) {
    hero = (
      <HeroFrame>
        <VideoSequence clips={clips} />
      </HeroFrame>
    );
  }

  // 在跑时整条状态条都不出（否则会掉进末尾的分支，一边合成一边还给一个 Merge 按钮）
  let status: React.ReactNode = null;
  if (!done && !busyNow) {
    if (d.mediaStatus === "failed") {
      status = (
        <StatusLine
          icon={<AlertTriangle className="size-3" aria-hidden />}
          tone="danger"
          text="Merge failed"
          action={
            readOnly
              ? undefined
              : {
                  label: "Retry",
                  icon: <RotateCcw className="size-3" aria-hidden />,
                  onClick: () => mergeVideo(d.id),
                }
          }
        />
      );
    } else if (clips.length < 2) {
      status = (
        <StatusLine text={`Connect at least two videos (${clips.length})`} />
      );
    } else {
      // 素材齐了才给 Merge：合成要花时间，不在连线的瞬间替用户决定
      status = (
        <StatusLine
          text={`${clips.length} clips — hover to preview`}
          action={
            readOnly
              ? undefined
              : {
                  label: "Merge",
                  icon: <Layers className="size-3" aria-hidden />,
                  onClick: () => mergeVideo(d.id),
                }
          }
        />
      );
    }
  }

  return (
    <>
      <NodeShell
        nodeId={d.id}
        nodeType="video_concat"
        selected={selected}
        dragging={dragging}
        label={d.label ?? ""}
        composerMeta={<InputsPill inputs={inputs} />}
        // 拼接节点没有提示词：面板里列的是待合成的视频序列（点一条跳到那个节点）
        clips={inputs
          .filter((s) => s.outputs.some((o) => o.type === "video"))
          .map((s) => ({ nodeId: s.nodeId, title: s.title }))}
        hero={hero}
        heroActions={
          asset.status === "ready" ? (
            <>
              <CanvasToolbarButton
                label="Play full size"
                icon={<Maximize2 className="size-3.5" />}
                onClick={() => setZoom(true)}
              />
              <CanvasToolbarButton
                label="Download"
                icon={<Download className="size-3.5" />}
                onClick={download}
              />
            </>
          ) : null
        }
        status={status}
        footer={<InputSummary inputs={inputs} />}
        mediaOnly={mediaOnly}
        hasTarget
        hasSource
      />
      {asset.status === "ready" && (
        <NodeMediaDialog
          open={zoom}
          onOpenChange={setZoom}
          url={asset.url}
          kind="video"
          title={title}
          onDownload={download}
        />
      )}
    </>
  );
}

export const nodeTypes: NodeTypes = {
  image_upload: ImageUploadNode,
  image_gen: ImageGenNode,
  video_gen: VideoGenNode,
  video_concat: VideoConcatNode,
};

/** composer 参数条上的上游来源胶囊：与卡片注脚同一句话，样式随参数条。 */
function InputsPill({ inputs }: { inputs: NodeInputSource[] }) {
  const summary = summarizeInputs(inputs);
  if (!summary) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-[11px] text-muted-foreground">
      <Link2 className="size-3" aria-hidden />
      {summary}
    </span>
  );
}
