"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 对话流的滚动编排：发消息把这条消息顶到视口顶部，回复在其下方生长而视图不动。
 *
 * 四件事，互相咬合：
 * 1. **锚定**：发送后把最后一条用户消息滚到距视口顶 `--chat-top-gap` 处（平滑）。
 * 2. **不动**：回复流式生长期间不做任何滚动——跟随默认关。
 * 3. **底部留白**：撑出「让那条消息够得着顶部」所需的滚动余量，回复长出来就等量收窄，
 *    填满一屏归零。**同一轮内只缩不涨**：否则回复每长一行留白跟着抖，scrollHeight 来回变。
 * 4. **回到最新**：看不到内容末尾时露出按钮，点它才开启跟随底部。
 *
 * ⚠️ 全程只动 ScrollArea 自己的 viewport（`scrollTo`/`scrollTop`），**绝不用
 * `scrollIntoView`**：后者会向上遍历、把每个可滚祖先都滚一遍，在内层尚未 clamp 到最终高度
 * 的那一帧会把 `.h-screen` 外壳一起顶上去（顶栏侧栏全被推走且滚不回来）。
 *
 * 留白高度**不走 React state**，直接写 DOM：流式期间每秒好几次重算，走 state 等于给整条
 * 消息流加一轮重渲染；而且锚定要在同一次布局里「先撑高、再滚动」，state 会拆成两帧。
 */

/** 没给 `--chat-top-gap` 时的顶距兜底（px）。 */
const TOP_GAP_FALLBACK = 68;
/** 顶距上限 = 视口高度的这个比例。画布侧栏、手机抽屉只有几百 px 高，68px 会吃掉小半屏。 */
const TOP_GAP_MAX_RATIO = 0.25;
/** 「已看到内容末尾」的容差（px）：差这么点不该让「回到最新」跳出来。 */
const AT_LATEST_SLACK = 24;

/** SSR 期没有布局可测；用 useEffect 顶替，避免 Next 的 useLayoutEffect 警告。 */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 顶距：从 viewport 上读 `--chat-top-gap`（**只认 px**），读不到用兜底值，
 * 再按视口高度封顶。放 CSS 里是为了各处对话能各自调、也能跟断点走，JS 不写死数字。
 */
function topGapOf(vp: HTMLElement): number {
  const raw = getComputedStyle(vp).getPropertyValue("--chat-top-gap").trim();
  const px = Number.parseFloat(raw);
  const gap = raw.endsWith("px") && Number.isFinite(px) ? px : TOP_GAP_FALLBACK;
  return Math.min(gap, vp.clientHeight * TOP_GAP_MAX_RATIO);
}

/** 尊重系统的「减少动态效果」：开了就瞬移，不做平滑。 */
function motion(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export interface ChatScroll {
  /** 挂在消息内容容器上（ScrollArea 的直接子元素，**不含**下方留白）。 */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** 挂在内容容器之后的空 div 上：本 hook 直接改它的 height。 */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** 内容末尾是否已在视口内。false 时露出「回到最新」。 */
  atLatest: boolean;
  /** 提交那一刻调用：下一次内容变化时把这条消息顶到视口顶部。 */
  armAnchor: () => void;
  /** 「回到最新」按钮：滚到内容末尾并**开启**跟随底部。 */
  jumpToLatest: () => void;
}

/**
 * @param revision 内容版本：消息数组即可（引用变了就重算）。
 * @param resetKey 会话标识：换一个会话就重置留白与跟随，并把历史直接定位到最新一条。
 */
export function useChatScroll(revision: unknown, resetKey?: string | null): ChatScroll {
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  /** 跟随底部。默认关，只有 jumpToLatest 能开、任何手动滚动都会关掉。 */
  const following = useRef(false);
  /** 已武装：下一次内容变化执行一次锚定。 */
  const armed = useRef(false);
  /** 本会话还没做过「落到最新」的首次定位（历史是异步到的，挂载那帧还是空/骨架）。 */
  const initial = useRef(true);
  /** 当前留白高度（px）。同一轮内单调不增。 */
  const spacerH = useRef(0);
  const seenKey = useRef<string | null | undefined>(undefined);
  const [atLatest, setAtLatest] = useState(true);

  /** 一次性量好后续都要用的几何量；面板收起（clientHeight 0）时返回 null，全部逻辑跳过。 */
  const measure = useCallback(() => {
    const content = contentRef.current;
    const vp = content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!content || !vp || vp.clientHeight === 0) return null;
    const vpRect = vp.getBoundingClientRect();
    const cRect = content.getBoundingClientRect();
    return {
      vp,
      content,
      vpH: vp.clientHeight,
      /** 内容顶边在滚动坐标系里的位置。 */
      contentTop: cRect.top - vpRect.top + vp.scrollTop,
      contentH: cRect.height,
      /** 内容底边探出视口底边多少（>0 = 末尾还没看到）。 */
      below: cRect.bottom - vpRect.bottom,
    };
  }, []);

  const writeSpacer = (px: number) => {
    const next = Math.max(0, Math.round(px));
    spacerH.current = next;
    if (spacerRef.current) spacerRef.current.style.height = `${next}px`;
  };

  /** 最后一条用户消息相对内容容器顶边的偏移；没有用户消息返回 null。 */
  const anchorOffset = (content: HTMLElement): number | null => {
    const all = content.querySelectorAll<HTMLElement>("[data-chat-anchor]");
    const el = all[all.length - 1];
    if (!el) return null;
    return el.getBoundingClientRect().top - content.getBoundingClientRect().top;
  };

  /**
   * 让**内容末尾**贴住视口底边——而不是滚到 scrollHeight 底。
   * 下方留白不是内容，跟到留白里会把最后一条消息推出视口上沿。
   */
  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior) => {
      const m = measure();
      if (!m) return;
      m.vp.scrollTo({ top: Math.max(0, m.contentTop + m.contentH - m.vpH), behavior });
    },
    [measure],
  );

  /** 把最后一条用户消息顶到距视口顶 gap 处。返回是否真的做成了。 */
  const anchorToLastUser = useCallback(() => {
    const m = measure();
    if (!m) return false;
    const offset = anchorOffset(m.content);
    if (offset === null) return false;
    const gap = topGapOf(m.vp);
    // 先撑够余量目标位置才够得着。这是新一轮的起点，允许比上一轮大（「只缩不涨」是一轮之内的约束）
    writeSpacer(m.vpH - gap - (m.contentH - offset));
    // 读 scrollHeight 会强制布局，此时上面写的 height 已经算进去了
    const max = m.vp.scrollHeight - m.vp.clientHeight;
    const top = Math.max(0, Math.min(m.contentTop + offset - gap, max));
    m.vp.scrollTo({ top, behavior: motion() });
    return true;
  }, [measure]);

  /** 回复长出来后等量收窄留白；只减不增，减到 0 就不再管。 */
  const shrinkSpacer = useCallback(() => {
    if (spacerH.current === 0) return;
    const m = measure();
    if (!m) return;
    const offset = anchorOffset(m.content);
    if (offset === null) {
      writeSpacer(0);
      return;
    }
    const need = m.vpH - topGapOf(m.vp) - (m.contentH - offset);
    writeSpacer(Math.min(spacerH.current, need));
  }, [measure]);

  const syncAtLatest = useCallback(() => {
    const m = measure();
    if (m) setAtLatest(m.below <= AT_LATEST_SLACK);
  }, [measure]);

  const armAnchor = useCallback(() => {
    armed.current = true;
    initial.current = false;
    following.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    following.current = true;
    scrollToLatest(motion());
  }, [scrollToLatest]);

  // 换会话：留白、跟随、首次定位全部归零，交给下面的内容效应重新落位
  useIsoLayoutEffect(() => {
    if (seenKey.current === resetKey) return;
    seenKey.current = resetKey;
    following.current = false;
    armed.current = false;
    initial.current = true;
    writeSpacer(0);
  }, [resetKey]);

  // 内容变化。三选一：本轮锚定 / 首次落到最新 / 什么都不动（只收窄留白）
  useIsoLayoutEffect(() => {
    if (armed.current) {
      armed.current = false;
      if (anchorToLastUser()) return;
    }
    // 历史是异步到的：等到真有消息渲染出来那一帧，再把位置落到最新一条
    if (initial.current && contentRef.current?.querySelector("[data-chat-anchor]")) {
      initial.current = false;
      scrollToLatest("auto");
      return;
    }
    shrinkSpacer();
    if (following.current) scrollToLatest("auto");
  }, [revision, anchorToLastUser, shrinkSpacer, scrollToLatest]);

  // 流式生长靠 ResizeObserver 兜住：图片/代码块加载完也会改高度，光盯 revision 会漏。
  // 注意只观察内容容器与视口——留白由本 hook 写，观察它会自激。
  useEffect(() => {
    const content = contentRef.current;
    const vp = content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!content || !vp) return;

    const onResize = () => {
      shrinkSpacer();
      if (following.current) scrollToLatest("auto");
      syncAtLatest();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    ro.observe(vp);

    const onScroll = () => syncAtLatest();
    // 手动滚动即收回跟随：跟随只能由「回到最新」按钮开启。
    // 用手势事件而不是 scroll 事件来判定——scroll 分不清是用户还是我们自己滚的，
    // 平滑滚动的中间帧会被当成「用户滚走了」，按钮刚点就失效。
    const release = () => {
      following.current = false;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    vp.addEventListener("wheel", release, { passive: true });
    vp.addEventListener("touchmove", release, { passive: true });

    return () => {
      ro.disconnect();
      vp.removeEventListener("scroll", onScroll);
      vp.removeEventListener("wheel", release);
      vp.removeEventListener("touchmove", release);
    };
  }, [shrinkSpacer, scrollToLatest, syncAtLatest]);

  return { contentRef, spacerRef, atLatest, armAnchor, jumpToLatest };
}
