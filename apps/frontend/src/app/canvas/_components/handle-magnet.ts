/**
 * 端点磁吸：指针靠近某个端点时，端点整枚迎上来贴住指针并长成「+」；离开就弹回原位。
 *
 * 判定放在**画布层**（flow-canvas 的容器上监听 pointermove）而不是每张卡片上：
 * 触发范围是围着端点画的圆，一半落在卡片外面，挂在卡片上的话从外侧靠近永远不触发。
 *
 * 距离一律在**画布坐标**里算，所以范围随画布缩放——「离卡片多远算靠近」在任何缩放层级
 * 下都是同一个相对距离。位移写进 CSS 变量由 CSS 承担（见 globals.css 的
 * .react-flow__handle-left/right），不走 React 状态：pointermove 每秒几十上百次，
 * 走状态会把整张卡片连同主视觉重渲一遍。
 */

/** 触发半径（画布坐标）。50 = 直径 100 的圆。 */
export const MAGNET_RADIUS = 50;
/** 离开触发范围后弹回原位的时长；跟随期间不给过渡（要贴着指针走）。 */
const RETURN = "0.18s";

/** 参与判定的节点几何（画布坐标）。 */
export interface MagnetNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function clear(h: HTMLElement) {
  h.style.transitionDuration = RETURN;
  h.style.removeProperty("--h-near");
  h.style.removeProperty("--h-dx");
  h.style.removeProperty("--h-dy");
}

/**
 * 按指针的画布坐标更新所有端点。返回这一帧被吸住的端点，调用方留到下一帧用来清理
 * （只清上一帧吸住过的，不必每次遍历全部端点的 DOM）。
 */
export function applyMagnet(
  root: HTMLElement,
  pointer: { x: number; y: number },
  nodes: MagnetNode[],
  prev: Set<HTMLElement>,
): Set<HTMLElement> {
  const now = new Set<HTMLElement>();

  for (const n of nodes) {
    // 先用矩形粗筛：绝大多数节点离得远，不必去查 DOM
    if (
      pointer.x < n.x - MAGNET_RADIUS ||
      pointer.x > n.x + n.width + MAGNET_RADIUS ||
      pointer.y < n.y - MAGNET_RADIUS ||
      pointer.y > n.y + n.height + MAGNET_RADIUS
    ) {
      continue;
    }
    const midY = n.y + n.height / 2;
    for (const side of ["left", "right"] as const) {
      // 端点原位 = 卡片左/右边的中点。距离从**原位**算，不是它此刻被拉走后的位置——
      // 否则端点一动距离就跟着变，会自己把自己甩出触发范围来回抖。
      const homeX = side === "left" ? n.x : n.x + n.width;
      const dx = pointer.x - homeX;
      const dy = pointer.y - midY;
      const dist = Math.hypot(dx, dy);
      if (dist > MAGNET_RADIUS) continue;

      const h = root.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(n.id)}"] .react-flow__handle-${side}`,
      );
      if (!h) continue; // 这一侧没有端口（文本节点只有出口）

      // 中心贴中心：位移就是指针相对原位的偏移，不打折
      h.style.transitionDuration = "0s";
      h.style.setProperty("--h-near", (1 - dist / MAGNET_RADIUS).toFixed(3));
      h.style.setProperty("--h-dx", `${dx.toFixed(1)}px`);
      h.style.setProperty("--h-dy", `${dy.toFixed(1)}px`);
      now.add(h);
    }
  }

  for (const h of prev) if (!now.has(h)) clear(h);
  return now;
}

/** 指针离开画布：把还吸着的端点全放回去。 */
export function releaseMagnet(prev: Set<HTMLElement>) {
  for (const h of prev) clear(h);
}
