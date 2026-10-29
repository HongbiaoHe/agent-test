import * as THREE from "three";

/**
 * 悬浮岛上全部动物的动画驱动。
 *
 * 这里不碰 React：只接收「已加载的模型根节点」，建立一次节点索引，
 * 之后每帧被 R3F 的 useFrame 调用。四种动物：
 * - 飞鸟 Bird_Fly_*：绕岛盘旋 + 扇翅（翅膀是独立子节点）
 * - 栖鸟 Bird_Perched_*：摇晃 + 啄食 + 跳跃（整体网格）
 * - 山羊 Goat_* / 奶牛 Cow_*：走走停停（四条腿节点对角步态）+ 低头吃草
 */

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);

const tempA = new THREE.Quaternion();
const tempB = new THREE.Quaternion();
const groundRay = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();

export type Wing = {
  obj: THREE.Object3D;
  side: number;
  base: THREE.Quaternion;
};

export type Flyer = {
  obj: THREE.Object3D;
  wings: Wing[];
  radius: number;
  height: number;
  startAngle: number;
  speed: number;
  dir: number;
  flap: number;
  phase: number;
};

export type Perched = {
  obj: THREE.Object3D;
  basePos: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  phase: number;
};

export type Leg = {
  obj: THREE.Object3D;
  phase: number;
};

export type WalkState = {
  mode: "idle" | "walk";
  timer: number;
  target: THREE.Vector3 | null;
  speed: number;
  radius: number;
  stride: number;
  blend: number;
  heading: number;
  homeX: number;
  homeZ: number;
};

export type Walker = {
  kind: "goat" | "cow";
  obj: THREE.Object3D;
  head: THREE.Object3D | null;
  tail: THREE.Object3D | null;
  tailQuat: THREE.Quaternion | null;
  basePos: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  legs: Leg[];
  baseAngle: number;
  lookAngle: number;
  phase: number;
  walk: WalkState;
};

export type Fauna = {
  flyers: Flyer[];
  perched: Perched[];
  goats: Walker[];
  cows: Walker[];
  /** 累计动画时间（秒），受 dt 驱动，便于暂停/定格 */
  time: number;
};

function ease(value: number): number {
  return value * value * (3 - 2 * value);
}

/** 从导出的四元数反推头部的俯仰角（绕 X 轴） */
function pitchOf(head: THREE.Object3D): number {
  return 2 * Math.asin(Math.max(-1, Math.min(1, head.quaternion.x)));
}

function makeWalker(
  obj: THREE.Object3D,
  kind: "goat" | "cow",
  speed: number,
  radius: number,
  phase: number,
): Walker {
  const head = obj.children.find((child) => child.name.startsWith("Head_")) ?? null;
  const tail =
    kind === "cow" ? (obj.children.find((child) => child.name.startsWith("Tail_")) ?? null) : null;
  const baseAngle = head ? pitchOf(head) : 0;
  const legs = obj.children
    .filter((child) => child.name.startsWith("Leg_"))
    .map((child) => ({
      obj: child,
      // 对角步态：左前 + 右后 同相，右前 + 左后 反相
      phase: child.name.endsWith("FL") || child.name.endsWith("BR") ? 0 : Math.PI,
    }));

  return {
    kind,
    obj,
    head,
    tail,
    tailQuat: tail ? tail.quaternion.clone() : null,
    basePos: obj.position.clone(),
    baseQuat: obj.quaternion.clone(),
    legs,
    baseAngle,
    lookAngle:
      kind === "cow"
        ? baseAngle + 0.62
        : baseAngle < -0.5
          ? baseAngle + 0.78
          : baseAngle - 0.85,
    phase,
    walk: {
      mode: "idle",
      timer: 1.5 + phase * 5,
      target: null,
      speed,
      radius,
      stride: 0,
      blend: 0,
      heading: 2 * Math.atan2(obj.quaternion.y, obj.quaternion.w),
      homeX: obj.position.x,
      homeZ: obj.position.z,
    },
  };
}

export function collectFauna(root: THREE.Object3D): Fauna {
  const fauna: Fauna = { flyers: [], perched: [], goats: [], cows: [], time: 0 };

  root.traverse((obj) => {
    if (obj.name.startsWith("Bird_Fly_")) {
      const wings: Wing[] = obj.children.map((child) => ({
        obj: child,
        side: child.name.includes("_L_") ? -1 : 1,
        base: child.quaternion.clone(),
      }));
      fauna.flyers.push({
        obj,
        wings,
        radius: Math.hypot(obj.position.x, obj.position.z),
        height: obj.position.y,
        startAngle: Math.atan2(obj.position.z, obj.position.x),
        speed: 0.15 + Math.random() * 0.13,
        dir: Math.random() < 0.5 ? -1 : 1,
        flap: 7.5 + Math.random() * 2.5,
        phase: Math.random() * Math.PI * 2,
      });
      return;
    }

    if (obj.name.startsWith("Bird_Perched_")) {
      fauna.perched.push({
        obj,
        basePos: obj.position.clone(),
        baseQuat: obj.quaternion.clone(),
        phase: Math.random() * Math.PI * 2,
      });
      return;
    }

    if (obj.name.startsWith("Goat_")) {
      fauna.goats.push(makeWalker(obj, "goat", 0.3, 0.85, fauna.goats.length * 0.37));
      return;
    }

    if (obj.name.startsWith("Cow_")) {
      fauna.cows.push(makeWalker(obj, "cow", 0.34, 1.25, 0.55));
    }
  });

  return fauna;
}

function groundHeight(island: THREE.Object3D | null, x: number, z: number, fallback: number): number {
  if (!island) return fallback;
  rayOrigin.set(x, 40, z);
  groundRay.set(rayOrigin, DOWN);
  const hits = groundRay.intersectObject(island, true);
  return hits.length > 0 ? hits[0].point.y : fallback;
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

/** 推进一个会走路的动物；返回「正在走」的混合权重（0 静止，1 行走） */
function stepWalker(walker: Walker, dt: number, island: THREE.Object3D | null, time: number): number {
  const state = walker.walk;
  const position = walker.obj.position;
  let moving = false;

  if (state.mode === "idle") {
    state.timer -= dt;
    if (state.timer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 0.35 + Math.random() * state.radius;
      let tx = state.homeX + Math.cos(angle) * distance;
      let tz = state.homeZ + Math.sin(angle) * distance;
      const length = Math.hypot(tx, tz);
      if (length > 3) {
        tx *= 3 / length;
        tz *= 3 / length;
      }
      state.target = new THREE.Vector3(tx, 0, tz);
      state.mode = "walk";
      state.timer = 8;
    }
  } else if (state.target) {
    const dx = state.target.x - position.x;
    const dz = state.target.z - position.z;
    const distance = Math.hypot(dx, dz);

    if (distance < 0.07 || state.timer <= 0) {
      state.mode = "idle";
      state.timer = 4 + Math.random() * 7;
      state.target = null;
    } else {
      const dirX = dx / distance;
      const dirZ = dz / distance;
      const step = Math.min(distance, state.speed * dt);
      position.x += dirX * step;
      position.z += dirZ * step;
      state.heading = lerpAngle(state.heading, Math.atan2(-dirX, -dirZ), Math.min(1, dt * 7));
      walker.obj.quaternion.setFromAxisAngle(Y_AXIS, state.heading);
      state.timer -= dt;
      moving = true;
    }
  }

  const want = moving ? 1 : 0;
  state.blend += (want - state.blend) * Math.min(1, dt * 7);
  state.stride += dt * (moving ? 8.2 : 0);

  for (const leg of walker.legs) {
    leg.obj.quaternion.setFromAxisAngle(
      X_AXIS,
      Math.sin(state.stride + leg.phase) * 0.42 * state.blend,
    );
  }

  // 走动时踩在草坡上，停住时叠一点呼吸起伏
  const bob = Math.sin(time * 1.5 + walker.phase * 5) * 0.004 * (1 - state.blend);
  position.y = groundHeight(island, position.x, position.z, position.y) + bob;

  return state.blend;
}

/** 吃草 ↔ 抬头 的周期权重 */
function liftAmount(cycle: number, riseAt: number, lookAt: number): number {
  if (cycle >= riseAt && cycle < riseAt + 0.14) return ease((cycle - riseAt) / 0.14);
  if (cycle >= riseAt + 0.14 && cycle < lookAt) return 1;
  if (cycle >= lookAt) return 1 - ease((cycle - lookAt) / (1 - lookAt));
  return 0;
}

function updateWalker(
  walker: Walker,
  dt: number,
  island: THREE.Object3D | null,
  time: number,
): void {
  const walking = stepWalker(walker, dt, island, time);

  let lift = walking > 0.15 ? 1 : 0;
  if (walking <= 0.15) {
    const period = walker.kind === "cow" ? 0.075 : 0.11;
    const riseAt = walker.kind === "cow" ? 0.66 : 0.62;
    const lookAt = walker.kind === "cow" ? 0.92 : 0.9;
    const cycle = ((time * period + walker.phase) % 1 + 1) % 1;
    lift = liftAmount(cycle, riseAt, lookAt);
  }

  const chew =
    lift < 0.15
      ? Math.sin(time * (walker.kind === "cow" ? 4.2 : 6.5) + walker.phase * 9) *
        (walker.kind === "cow" ? 0.035 : 0.028)
      : 0;

  if (walker.head) {
    walker.head.quaternion.setFromAxisAngle(
      X_AXIS,
      walker.baseAngle + (walker.lookAngle - walker.baseAngle) * lift + chew,
    );
  }

  if (walker.tail && walker.tailQuat) {
    const swish = Math.sin(time * 1.25) * 0.28 + Math.sin(time * 3.7) * 0.06;
    const flick = Math.pow(Math.max(0, Math.sin(time * 0.4)), 18) * 0.5;
    walker.tail.quaternion
      .copy(walker.tailQuat)
      .multiply(tempA.setFromAxisAngle(Z_AXIS, swish + flick + walking * 0.15));
  }
}

function updateFlyers(flyers: Flyer[], time: number): void {
  for (const flyer of flyers) {
    const angle = flyer.startAngle + flyer.dir * flyer.speed * time;
    const radius = flyer.radius + Math.sin(time * 0.5 + flyer.phase) * 0.35;
    flyer.obj.position.set(
      Math.cos(angle) * radius,
      flyer.height + Math.sin(time * 1.3 + flyer.phase) * 0.26,
      Math.sin(angle) * radius,
    );

    // 模型正面朝 -Z：把切线方向转成 yaw，再补一点转弯侧倾
    const dx = -Math.sin(angle) * flyer.dir;
    const dz = Math.cos(angle) * flyer.dir;
    flyer.obj.quaternion
      .copy(tempA.setFromAxisAngle(Y_AXIS, Math.atan2(-dx, -dz)))
      .multiply(tempB.setFromAxisAngle(Z_AXIS, -0.2 * flyer.dir));

    const flap = Math.sin(time * flyer.flap + flyer.phase) * 0.5;
    for (const wing of flyer.wings) {
      wing.obj.quaternion
        .copy(tempA.setFromAxisAngle(Z_AXIS, flap * wing.side))
        .multiply(wing.base);
    }
  }
}

function updatePerched(perched: Perched[], time: number): void {
  for (const bird of perched) {
    const t = time + bird.phase;
    // 每约 6 秒跳一下：抛物线上升 + 轻微的落地压缩
    const cycle = ((t * 0.16) % 1 + 1) % 1;
    const hop = cycle < 0.07 ? Math.sin((cycle / 0.07) * Math.PI) * 0.085 : 0;
    const squash = cycle < 0.07 ? Math.sin((cycle / 0.07) * Math.PI * 2) * 0.06 : 0;
    const peck = -Math.pow(Math.max(0, Math.sin(t * 0.55)), 12) * 0.5;

    bird.obj.position.copy(bird.basePos);
    bird.obj.position.y += Math.sin(t * 2.2) * 0.006 + hop;
    bird.obj.quaternion
      .copy(tempA.setFromAxisAngle(Y_AXIS, Math.sin(t * 1.1) * 0.07))
      .multiply(bird.baseQuat)
      .multiply(tempB.setFromAxisAngle(X_AXIS, peck + squash));
  }
}

/** 每帧推进一次；dt 为真实帧间隔（秒），内部做上限保护避免切标签页后瞬移 */
export function updateFauna(fauna: Fauna, dt: number, island: THREE.Object3D | null): void {
  const step = Math.min(Math.max(dt, 0), 0.05);
  if (step === 0) return;
  fauna.time += step;

  updateFlyers(fauna.flyers, fauna.time);
  updatePerched(fauna.perched, fauna.time);

  for (const goat of fauna.goats) updateWalker(goat, step, island, fauna.time);
  for (const cow of fauna.cows) updateWalker(cow, step, island, fauna.time);
}
