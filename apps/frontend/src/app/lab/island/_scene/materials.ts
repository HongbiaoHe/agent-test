import * as THREE from "three";

import type { Palette } from "./palettes";

/**
 * 材质处理。
 *
 * three 是命令式对象图，改材质属性必然要原地修改；这些操作被刻意放在
 * React 组件之外（组件只负责调用），避免把「渲染期数据」和「命令式突变」混在一处。
 */

function eachStandardMaterial(
  root: THREE.Object3D,
  visit: (material: THREE.MeshStandardMaterial) => void,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const list: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of list) {
      if (material instanceof THREE.MeshStandardMaterial) visit(material);
    }
  });
}

/** 一次性设置：平直着色 + 高粗糙度，对齐 Blender 里低多边形的观感 */
export function prepareIslandMaterials(root: THREE.Object3D): void {
  eachStandardMaterial(root, (material) => {
    material.flatShading = true;
    material.roughness = 0.92;
    material.metalness = 0;
    material.needsUpdate = true;
  });
}

/** 按 glTF 材质名套用配色的 base color（配色数据见 palettes.ts） */
export function applyPaletteMaterials(
  root: THREE.Object3D,
  palette: Palette,
  wireframe: boolean,
): void {
  eachStandardMaterial(root, (material) => {
    const color = palette.materials[material.name];
    if (color) material.color.set(color);
    material.wireframe = wireframe;
    material.needsUpdate = true;
  });
}
