"use client";

import { AssemblyProvider } from "./assembly";
import { Base } from "./base";
import { CameraRig } from "./camera";
import { Effects } from "./effects";
import { Lights } from "./lights";
import { Rain } from "./rain";
import { SkyDome } from "./sky";
import { WetGround } from "./wet-ground";
import { PALETTE } from "./scene-config";
import { Props } from "../props";
import { Store } from "../store";
import { Street } from "../street";

/**
 * 场景总装。
 * 入场顺序由各部件内部的 <Part delay> 决定，这里只负责摆放与全局氛围。
 */
export function Scene() {
  return (
    <>
      <color attach="background" args={[PALETTE.background]} />
      <fogExp2 attach="fog" args={[PALETTE.fog, 0.021]} />

      <SkyDome />

      <AssemblyProvider>
        <Lights />
        <Base />
        <WetGround />
        <Street />
        <Store />
        <Props />
        <Rain />
        <CameraRig />
      </AssemblyProvider>

      <Effects />
    </>
  );
}
