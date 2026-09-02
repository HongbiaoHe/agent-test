"use client";

import { useEffect, useRef, useState } from "react";

import { ThinkingGrid } from "./thinking-indicator";

/**
 * 骨架屏最短驻留（毫秒）。快照秒回时也要撑满这段——不然骨架屏只闪一帧，
 * 用户读到的是"页面抖了一下"，比不做还差。
 */
const MIN_HOLD_MS = 500;
/** 退场动画时长。⚠️ 必须与 globals.css `.canvas-boot[data-phase="out"]` 的动画时长一致。 */
const OUT_MS = 560;

type Phase =
  /** 数据在路上（或最短驻留还没走完）：方阵斜向扫动 */
  | "hold"
  /** 数据已就绪：九格爆开放大到透明，露出真画布 */
  | "out"
  /** 播完，卸载 */
  | "done";

/**
 * 画布骨架屏。刷新 /canvas/[id] 时盖在画布之上，等快照与历史消息都落地
 * （且至少驻留 MIN_HOLD_MS）再爆开退场。
 *
 * 做成「盖在上面的一层」而不是「加载完再挂 FlowCanvas」：画布下面的
 * react-flow、socket 订阅、对话面板照常挂载与首帧 fitView，退场那一刻
 * 看到的已经是排布好的画布，不会先空一帧再跳位。
 *
 * 动效全部围绕方阵编排——它是 agent 在这块画布上的固定化身（右侧入口、
 * 对话里的思考指示器都是它），所以「进画布」这件事就该由它让开来完成：
 * 九格先微收蓄力，再向各自方向放大冲出画面、淡到透明。
 *
 * ⚠️ 由调用方用 `key={sessionId}` 挂载：切换画布要从 hold 重新走一遍。
 */
export function CanvasBoot({ loading }: { loading: boolean }) {
  // 首帧就有数据（react-query 缓存命中，如从索引页点进刚看过的画布）→ 整个不出现。
  // 那种情况下本来没有等待，硬塞 500ms 骨架屏只是白挡。
  const [phase, setPhase] = useState<Phase>(loading ? "hold" : "done");
  // 起算点在挂载后记（渲染期不许调 Date.now——react-hooks/purity）。
  // 这个 effect 必须排在下面那个之前：effect 按声明序执行，晚了就读到 0。
  const startedAt = useRef(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // 数据就绪 → 补齐最短驻留的剩余时间再开始退场
  useEffect(() => {
    if (loading || phase !== "hold") return;
    const rest = Math.max(0, MIN_HOLD_MS - (Date.now() - startedAt.current));
    const timer = setTimeout(() => setPhase("out"), rest);
    return () => clearTimeout(timer);
  }, [loading, phase]);

  // 退场播完再卸载：CSS 动画结束不会自己通知 React
  useEffect(() => {
    if (phase !== "out") return;
    const timer = setTimeout(() => setPhase("done"), OUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div className="canvas-boot" data-phase={phase} role="status" aria-live="polite">
      {/* 点阵底纹：与画布内 react-flow <Background> 同一套暗号（20px 网格、1px 点、
          border 色），退场时两层点阵重合，读起来是同一块板而不是换了一屏 */}
      <div className="canvas-boot__grain" aria-hidden />

      {/* 悬浮控件的位置占位。位置刻意与真控件一致（见 canvas-header 的 inset-x-3 top-3、
          canvas-zoom-controls 的 bottom-center + mb-3、panel-trigger 的右侧竖轨），
          于是骨架屏一淡出，真的岛就出现在原地，而不是从别处冒出来。
          ⚠️ 改那几处的尺寸/边距时，这里的占位要跟着改。 */}
      <div className="canvas-boot__chrome" aria-hidden>
        <div className="canvas-boot__island canvas-boot__island--title" />
        <div className="canvas-boot__island canvas-boot__island--theme" />
        <div className="canvas-boot__island canvas-boot__island--zoom" />
        <div className="canvas-boot__rail">
          <div className="canvas-boot__trigger" />
          <div className="canvas-boot__trigger" />
        </div>
      </div>

      <div className="canvas-boot__stage">
        {/* wave：沿主对角线推进的斜向波，读作「在装载」而不是「在转圈」 */}
        <ThinkingGrid
          size={92}
          animation="wave"
          className="canvas-boot__grid"
        />
        <p className="canvas-boot__label">Loading canvas</p>
      </div>
    </div>
  );
}
