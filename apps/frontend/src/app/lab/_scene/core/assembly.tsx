"use client";

import { useFrame } from "@react-three/fiber";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import * as THREE from "three";

import type { Vec3 } from "./scene-config";

/**
 * 模型「从地面开始组装」的动画框架。
 *
 * - <AssemblyProvider>：所有入场动画共享一个起点时钟（reduced-motion 下直接给终态）。
 * - <Part>：让一块构件在指定延迟后从地面升起 / 原地弹出 / 从上方落下。
 * - <Power>：让一组灯与发光体在指定延迟后「通电」——带日式灯管那种闪两下的点亮。
 *
 * 所有动画都基于 performance.now() 与 useFrame，没有依赖 GSAP，
 * 这样每个构件都是独立可组合的，不受渲染顺序影响。
 */

const AssemblyContext = createContext<{ start: number; reduced: boolean }>({
  start: 0,
  reduced: false,
});

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function AssemblyProvider({
  children,
  delay = 0,
}: {
  children: ReactNode;
  /** 整体延后（秒） */
  delay?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const [start, setStart] = useState(0);

  // 不要在「组件挂载瞬间」开表：第一帧还要编译 shader、上传贴图，可能卡 1~3 秒，
  // 会导致用户看到的第一帧模型就已经组装完了。等两帧（首帧渲染完成）后再启动时间轴。
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // reduced-motion：时间轴直接推到终态（在回调里 setState，避免同步级联渲染）
        setStart(
          reduced ? performance.now() - 1000 * 1000 : performance.now() + delay * 1000,
        );
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [delay, reduced]);

  const value = useMemo(() => ({ start, reduced }), [start, reduced]);
  return (
    <AssemblyContext.Provider value={value}>
      {children}
    </AssemblyContext.Provider>
  );
}

export function useAssemblyClock(): { start: number; reduced: boolean } {
  return useContext(AssemblyContext);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutBounce(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** 0~1 的本地进度 */
function localProgress(start: number, delay: number, duration: number): number {
  if (start <= 0) return 0;
  const elapsed = (performance.now() - start) / 1000;
  if (elapsed <= delay) return 0;
  return clamp01((elapsed - delay) / duration);
}

export type PartMode = "rise" | "pop" | "drop" | "grow";

/**
 * 单块构件的入场动画。
 * - rise：从下方升起（建筑 / 大件的主力）
 * - pop：从 0 弹性放大（小道具 / 招牌）
 * - drop：从上方落下（雨棚 / 悬挂物）
 * - grow：原地从 0 长出来（电线 / 串灯）
 */
export function Part({
  children,
  delay,
  duration = 0.75,
  mode = "rise",
  distance = 1.4,
  position,
  rotation,
  scale,
}: {
  children: ReactNode;
  delay: number;
  duration?: number;
  mode?: PartMode;
  /** rise/drop 的距离（世界单位） */
  distance?: number;
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
}) {
  const inner = useRef<THREE.Group>(null);
  const rise = useRef(distance);
  const { start, reduced } = useAssemblyClock();

  // 自动测量这组构件的高度：升起的距离必须盖过最高点，否则 delay 之前
  // 高处的东西会从地面/底座里戳出来，看起来像"悬空穿模"。
  useEffect(() => {
    const group = inner.current;
    if (!group || mode !== "rise") return;
    const box = new THREE.Box3().setFromObject(group);
    const origin = new THREE.Vector3();
    group.getWorldPosition(origin);
    const top = box.max.y - origin.y;
    if (Number.isFinite(top)) {
      rise.current = Math.max(distance, top + 0.3);
    }
  }, [mode, distance]);

  useFrame(() => {
    const group = inner.current;
    if (!group) return;
    const p = reduced ? 1 : localProgress(start, delay, duration);
    // 还没到登场时间的构件直接不渲染，避免它们在底座下面露头
    group.visible = reduced || p > 0;
    if (mode === "pop") {
      const e = reduced ? 1 : easeOutBack(p);
      group.scale.setScalar(Math.max(0.001, e));
      group.position.y = -0.06 * (1 - p);
    } else if (mode === "drop") {
      const e = reduced ? 1 : easeOutBounce(p);
      group.position.y = distance * (1 - e);
      group.scale.setScalar(0.94 + 0.06 * e);
    } else if (mode === "grow") {
      const e = reduced ? 1 : easeOutCubic(p);
      group.scale.setScalar(Math.max(0.001, e));
    } else {
      const e = reduced ? 1 : easeOutCubic(p);
      group.position.y = -rise.current * (1 - e);
      group.scale.setScalar(0.86 + 0.14 * e);
    }
  });

  return (
    <group position={position} rotation={rotation} scale={scale}>
      <group ref={inner}>{children}</group>
    </group>
  );
}

type PowerEntry =
  | { kind: "light"; target: THREE.Light; base: number }
  | {
      kind: "emissive";
      target: THREE.MeshToonMaterial | THREE.MeshStandardMaterial;
      base: number;
    }
  | {
      kind: "opacity";
      target: THREE.SpriteMaterial | THREE.MeshBasicMaterial;
      base: number;
    };

function collectPowerEntries(root: THREE.Object3D): PowerEntry[] {
  const entries: PowerEntry[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Light) {
      entries.push({ kind: "light", target: object, base: object.intensity });
      return;
    }
    if (object instanceof THREE.Sprite && object.material instanceof THREE.SpriteMaterial) {
      entries.push({ kind: "opacity", target: object.material, base: object.material.opacity });
      return;
    }
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => {
        if (
          material instanceof THREE.MeshToonMaterial ||
          material instanceof THREE.MeshStandardMaterial
        ) {
          if (material.emissive && material.emissive.getHex() !== 0) {
            entries.push({
              kind: "emissive",
              target: material,
              base: material.emissiveIntensity,
            });
          }
        } else if (
          material instanceof THREE.MeshBasicMaterial &&
          material.transparent
        ) {
          entries.push({
            kind: "opacity",
            target: material,
            base: material.opacity,
          });
        }
      });
    }
  });
  return entries;
}

function hashNoise(n: number): number {
  const value = Math.sin(n * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

/** 日式灯管点亮：先闪两下，再稳定亮起 */
function flickerOn(elapsed: number, mode: "flicker" | "fade"): number {
  if (elapsed <= 0) return 0;
  if (mode === "fade") return easeOutCubic(clamp01(elapsed / 0.9));
  if (elapsed < 0.1) return hashNoise(Math.floor(elapsed * 60)) > 0.4 ? 1 : 0.02;
  if (elapsed < 0.2) return 0.08;
  if (elapsed < 0.3) return 0.95;
  if (elapsed < 0.4) return 0.22;
  if (elapsed < 0.52) return 1;
  if (elapsed < 0.62) return 0.4;
  return 1;
}

/**
 * 「通电」包裹层：统一驱动子树里的灯、自发光材质、光晕 Sprite 的强度。
 * 建议包在整组招牌 / 路灯 / 贩卖机外面。
 */
export function Power({
  children,
  delay,
  mode = "flicker",
  position,
  rotation,
}: {
  children: ReactNode;
  delay: number;
  mode?: "flicker" | "fade";
  position?: Vec3;
  rotation?: Vec3;
}) {
  const group = useRef<THREE.Group>(null);
  const entries = useRef<PowerEntry[] | null>(null);
  const { start, reduced } = useAssemblyClock();

  useEffect(() => {
    if (!group.current) return;
    entries.current = collectPowerEntries(group.current);
  }, []);

  useFrame(() => {
    const list = entries.current;
    if (!list || start <= 0) return;
    const elapsed = (performance.now() - start) / 1000 - delay;
    const value = reduced ? 1 : flickerOn(elapsed, mode);
    list.forEach((entry) => {
      if (entry.kind === "light") {
        entry.target.intensity = entry.base * value;
      } else if (entry.kind === "emissive") {
        entry.target.emissiveIntensity = entry.base * value;
      } else {
        entry.target.opacity = entry.base * value;
      }
    });
  });

  return (
    <group ref={group} position={position} rotation={rotation}>
      {children}
    </group>
  );
}

/**
 * 需要自己写动画时用这个：返回 0~1 的通电值（每帧更新）。
 * 例：蒸汽 / 霓虹呼吸灯 / 雨滴透明度。
 */
export function usePowerValue(delay: number, mode: "flicker" | "fade" = "fade"): RefObject<number> {
  const value = useRef(0);
  const { start, reduced } = useAssemblyClock();
  useFrame(() => {
    if (start <= 0) {
      value.current = 0;
      return;
    }
    const elapsed = (performance.now() - start) / 1000 - delay;
    value.current = reduced ? 1 : flickerOn(elapsed, mode);
  });
  return value;
}
