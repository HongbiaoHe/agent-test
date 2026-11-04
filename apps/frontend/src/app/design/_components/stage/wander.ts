/**
 * 图片生成 / 拆层期间 agent 光标的「随机游走」：不是机械地绕圈，而像人在旁边琢磨——
 * 大多数时候沿边框往前挪一段（步长随机、偶尔回退，离边距离也在浮动），
 * 偶尔探进画面里停一下看细节，偶尔原地小幅晃动。每一步的时长与停顿都随机。
 *
 * 坐标是图层框内的归一化坐标：u / v ∈ 约 [-0.05, 1.05]（略超出边框 = 光标贴在框外）。
 */

export interface WanderState {
  /** 沿边框的位置，0–1 一圈（上 → 右 → 下 → 左） */
  t: number;
  u: number;
  v: number;
}

export interface WanderStep extends WanderState {
  /** 移动用时 */
  moveMs: number;
  /** 到达后停多久再走下一步 */
  pauseMs: number;
}

/** 边框上 t 处、向外偏 outset 的点 */
export function perimeterPoint(t: number, outset: number): { u: number; v: number } {
  const lo = -outset;
  const hi = 1 + outset;
  const span = hi - lo;
  const s = (((t % 1) + 1) % 1) * 4;
  const edge = Math.floor(s);
  const f = s - edge;
  if (edge === 0) return { u: lo + f * span, v: lo };
  if (edge === 1) return { u: hi, v: lo + f * span };
  if (edge === 2) return { u: hi - f * span, v: hi };
  return { u: lo, v: hi - f * span };
}

const clamp = (n: number) => Math.min(1.05, Math.max(-0.05, n));

export function nextWanderStep(cur: WanderState, rand: () => number = Math.random): WanderStep {
  const r = rand();
  if (r < 0.18) {
    // 探进画面：在内部随机一点停留得久一些
    return {
      t: cur.t,
      u: 0.2 + rand() * 0.6,
      v: 0.2 + rand() * 0.6,
      moveMs: 650 + rand() * 600,
      pauseMs: 500 + rand() * 900,
    };
  }
  if (r < 0.3) {
    // 原地小幅晃动
    return {
      t: cur.t,
      u: clamp(cur.u + (rand() - 0.5) * 0.12),
      v: clamp(cur.v + (rand() - 0.5) * 0.12),
      moveMs: 220 + rand() * 260,
      pauseMs: 80 + rand() * 260,
    };
  }
  // 沿边框挪一段：多数往前，少数回退；离边距离随机浮动
  const dir = rand() < 0.15 ? -1 : 1;
  const t = cur.t + dir * (0.05 + rand() * 0.2);
  const { u, v } = perimeterPoint(t, -0.02 + rand() * 0.07);
  return {
    t: ((t % 1) + 1) % 1,
    u,
    v,
    moveMs: 380 + rand() * 820,
    pauseMs: 60 + rand() * 520,
  };
}
