"use client";

import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";

/**
 * 后期：Bloom 负责霓虹 / 招牌 / 路灯的辉光（三渲二夜景的灵魂），
 * Vignette 把四周压暗，让微缩模型像被一束舞台光罩住。
 */
export function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        intensity={0.75}
        luminanceThreshold={0.74}
        luminanceSmoothing={0.22}
        mipmapBlur
        radius={0.6}
      />
      <Vignette offset={0.26} darkness={0.62} eskil={false} />
    </EffectComposer>
  );
}
