# 雨夜便利店街角 · 场景实现规范

> 这是 `/lab/rainy-store` 微缩场景的共享施工图。Lead 已完成「底座 + 材质 + 灯光 + 湿地面反射 + 雨 + 相机 + 组装动画框架」，
> 本规范定义三块待建模块（store / street / props）的坐标、尺寸、视觉要求与动画时序。
> **先读代码再动手**，所有 API 都是现成的，禁止另起炉灶。

## 0. 硬约束（违者返工）

- 场景是一个 **12×12 正方形底座上的微缩模型**，第三人称观察，**页面没有任何 UI**（无文字浮层、无按钮、无 loading 文案）。
- 风格：**三渲二 / 日式动画夜景**。低模、硬边色阶、深色外轮廓、冷色夜景 + 暖色便利店灯光。
- 不做真实感写实材质，不用 PBR 贴图集；颜色一律从 `core/scene-config.ts` 的 `PALETTE` 取，最多允许在**调色板基础上 ±10% 明度**做材质变化，不引入新的高饱和色（霓虹点缀除外）。
- **不要加光源**（ambient / point / spot / directional 都不行）——灯光由 `core/lights.tsx` 统一控制，每个模块自己加灯会失控。发光用 `NeonPanel`、`Glow`、`GlowPuddle`。
- **不要用 `MeshReflectorMaterial`**（three r186 下有兼容问题，已放弃）。湿地反射由 `core/wet-ground.tsx` 统一提供。
- 不要修改 `core/` 下的任何文件；不要在 `_scene/` 之外创建文件。三块模块各自只写自己的目录：
  - `apps/frontend/src/app/lab/_scene/store/` → 导出 `Store`
  - `apps/frontend/src/app/lab/_scene/street/` → 导出 `Street`
  - `apps/frontend/src/app/lab/_scene/props/` → 导出 `Props`
- TypeScript strict：禁止 `any` / `as any` / `@ts-ignore`；不用 `eslint-disable`。
- 所有坐标最终都落在底座范围内（x、z ∈ [-6, 6]，y ≥ 0.18 的地面上），不要穿出底座边缘。
- 组件拆分保持克制：每块 5~8 个文件以内，能复用 `ToonBox` 就不要手写 mesh。

## 1. 先读这些文件（务必）

```
core/scene-config.ts   // 坐标、调色板、时间轴、点位 ANCHOR / PUDDLES
core/materials.tsx     // Toon / ToonBox / ToonCylinder / ToonSphere / NeonPanel / Glow / GlowPuddle / GlassPanel
core/textures.ts       // canvasTexture / createStoreSignTexture / createPylonTexture / createPosterTexture / createMatTexture / createTileTexture / createTextPanelTexture / JP_FONT / fitFontSize
core/assembly.tsx      // Part / Power / easeOutCubic ...
core/lights.tsx        // 灯光位置（你的发光面尽量和这些位置对齐）
core/wet-ground.tsx    // 前场/马路的湿反射位置
```

快速 API：

```tsx
<Part delay={1.1} duration={0.8} mode="rise">…</Part>      // 从地面升起
<Part delay={2.5} mode="pop">…</Part>                       // 弹性放大出现
<Part delay={2.5} mode="drop" distance={0.8}>…</Part>       // 从上方落下
<Power delay={3.9}>…</Power>                                // 通电：子树里的灯/自发光/光晕闪烁亮起
<ToonBox size={[w,h,d]} position={[x,y,z]} rotation={[rx,ry,rz]} color={PALETTE.x} outline={0.02} />
<ToonCylinder radiusTop={r} radiusBottom={r} height={h} position={...} color={...} />
<NeonPanel width={w} height={h} map={texture} position={...} rotation={...} />   // 不受光发光面
<Glow color={PALETTE.neonCyan} size={2} opacity={0.4} position={...} />          // 空气光晕 sprite
<GlowPuddle color={...} size={1.5} opacity={0.3} position={...} rotation={[-Math.PI/2,0,0]} /> // 贴地光斑
```

`position` / `rotation` / `size` 都是 `[x, y, z]` 数组；圆柱轴向默认 y；`NeonPanel` 默认朝 +z。

## 2. 总平面（俯视，+z 朝南 = 店门正面，−x 朝西 = 十字路口）

```
z=-6  ┌────────────────────────────────────┐  x=-6 .. 6
      │  后巷围挡    便利店主体               │
      │              x -1.8..4.2             │  东侧小巷
      │              z -4.9..-0.6            │  x 4.2..6
z=-0.6│  ┌──────────┘                        │
      │  │ 西侧人行道   ┃前场（湿反射）       │
z=0.8 │  │ 贩卖机/猫    ┃雨棚·门垫·自行车     │
      │  │ 立柱灯箱     ┃垃圾桶·伞架·A字牌    │
z=2.8 ├──┴──────斑马线────┴───────────────────┤
      │         南侧马路（湿反射）              │
z=6   └────────────────────────────────────┘
      x=-6        x=-3.6      x=0        x=6
```

- 底座：12×12，顶面 y=0，厚 0.6。马路顶面 y=0.02；人行道顶面 y=0.18（`SIDEWALK`）。
- 便利店：`STORE` = x[-1.8, 4.2] / z[-4.9, -0.6] / 地面 y=0.18；墙顶/女儿墙 3.35；玻璃顶 2.48；招牌带 2.55~3.15。
- 店前场（湿反射面）：x[-3.6, 6] / z[-0.6, 2.8]，面层 y≈0.19。湿反射面只反射、不挡光，**不要在 y<0.19 放东西**（除路缘/排水沟）。
- 相机默认从西南方看：**南立面（店门正面）+ 西侧路口**是主要观赏面，优先保证这两面的细节密度。

## 3. 三个模块的分工

### A. `store/` —— 便利店建筑（视觉中心）

必须包含（按重要性排序）：

1. **建筑体块**：x[-1.8,4.2] × z[-4.9,-0.6]，墙体从 y=0.18 到 3.23；女儿墙到 3.35。
   - 南立面（z=-0.6）与西立面（x=-1.8）的前半段是玻璃橱窗；西立面后半段（z≤-2.9）为实墙；东立面、北立面为实墙。
   - 踢脚板 0~0.35（深色 `PALETTE.darkMetal` 或 `storeWallShade`），白色竖梃（mullion）分隔玻璃，顶部横梁。
   - 建筑不要一整块大白盒：用「深色踢脚 + 玻璃 + 白色框架 + 招牌带 + 屋顶女儿墙」分出层次。墙色用 `storeWall`，受光后会呈现暖白。
2. **玻璃橱窗**：`GlassPanel` 叠在开口上（透明度 0.12~0.2），玻璃上贴 2~3 张海报（`createPosterTexture`），加一条斜向高光细条（薄 `NeonPanel`，白色低透明度）。
3. **室内**（从玻璃能看清，别做得太满）：暖光货架 3~4 排（零食/饮料色块）、靠后墙的发光冷柜、收银台 + 收银机、天花板 2~3 块发光灯板（`NeonPanel` 朝下 + `Glow`）。室内地面/墙用暖色调低饱和。
4. **自动门**：南立面 x 0.15~1.75，双扇玻璃门（一扇略错开 0.08 表示开启），门框、门贴（「自動ドア」「24時間営業」）、门上方传感器。
5. **招牌带**：x[-1.7,4.1] × y[2.55,3.15]，`createStoreSignTexture()` 用 `NeonPanel`，外框薄盒；西立面也来一条缩小版（同贴图，宽度约 2.4，高度 0.33）。招牌前方 2~3 个 `Glow` 做辉光，招牌整体包在 `<Power delay={TIMING.power + 0.7}>` 里。
6. **雨棚**：x[-0.7,2.55]，y≈2.32，从墙面伸出到 z≈0.52，白色帆布+品牌色前缘条，两根支撑杆；底面一条暖光带（`NeonPanel` 朝下 + 小 `Glow`），下雨天要有氛围。
7. **屋顶**：女儿墙、2 台空调外机、排气管、细天线、检修门；从上方旋转观看时也要有东西。
8. **东侧服务面/小巷墙**：2 台空调外机、落水管、电表箱、配管、摄像头、「関係者以外立入禁止」小牌（用 `createTextPanelTexture`）。
9. **门口**：`ANCHOR.mat` 处铺地垫（`createMatTexture`，plane 1.5×0.95，y=0.187）。

动画：

- 建筑主体 `<Part delay={TIMING.store}>`；墙体/玻璃/招牌/雨棚分别再包一层 `<Part>`，依次 +0.15 / +0.35 / +0.55 / +0.7 秒，形成「一层层搭起来」。
- 室内货架 `<Part delay={TIMING.interior}>`；招牌/雨棚/室内灯用 `<Power>` 通电。
- 玻璃、招牌、灯板这类「面」注意别和墙共面 z-fighting（沿法线偏移 0.005~0.02）。

### B. `street/` —— 街道与街道设施

必须包含：

1. **人行道**：`createTileTexture()` 地砖，覆盖 `SIDEWALK`；先铺整块（y=0.18 顶面）。前场 z[-0.6,2.8] 上方已经有湿反射面层（Lead 铺的），你的地砖在它下面即可，不要重复铺反射。
   - 路缘石：南侧 z≈2.88、西侧 x≈-3.48，宽 0.24、顶面 0.24；边缘做一圈亮色。
2. **马路标线**（全部放在湿反射面之上）：
   - 南侧斑马线：x[-1.55,1.45]，z 3.05~5.65，5 条横向白条（每条 0.42 深、0.42 间隔），带一点反光（`meshStandardMaterial` 白色 / roughness 0.3，可轻微 emissive）。
   - 西侧斑马线：z[0.5,2.5]，x -5.85~-3.8，4~5 条纵向白条。
   - 中心虚线：南侧马路 z=4.55（x 从 -5.8~-1.9、1.9~5.8），西侧马路 x=-4.8（z 从 -5.6~0.1 与 2.9~5.6），虚线段 0.8、间隔 0.8、线宽 0.15。
   - 停车位：`ANCHOR.parking`（x[4.4,5.96]，z[0.3,2.55]）画白色 U 形边线 + 轮挡（0.9×0.12×0.18 混凝土块，z≈0.45）。
   - 排水沟：沿两条路缘各一条深色凹槽（宽 0.16），每隔一段放金属格栅（x≈-2.4 / 0.6 / 3.4 与 z≈-3.2 / -0.8），格栅用深色 + 细横条。
   - 井盖 2 个：马路 (4.2, 0.04, 4.6) 与人行道 (0.2, 0.19, 1.5)，圆柱薄片 + 环形压纹。
3. **积水**：用 `PUDDLES` 的 6 个点位做不规则/椭圆水面（略高于对应地面 0.002~0.006），深色反光材质（`meshStandardMaterial` 深蓝、roughness 0.05、metalness 0.4、transparent 0.85），边缘一圈更暗的薄边。
4. **街道设施**（`<Part delay={TIMING.fixtures}>` 逐个出现）：
   - 路灯 `ANCHOR.lamp`：白色/深灰灯杆（高约 4.2），灯头（圆角盒/倒锥），底面发光面 `NeonPanel`，周围 `Glow(PALETTE.lampWarm)`，包 `<Power delay={TIMING.power + 0.25}>`。核心灯光位置 (3.35, 4.15, 2.3)，灯头请对齐。
   - 电线杆 `ANCHOR.pole`：混凝土圆柱 r≈0.14、高 5.4，顶部横担 ×2、变压器 2 个、绝缘子、脚钉、小号牌。电线用 drei `<Line>`，`lineWidth={1.4}`，颜色 `#2a3348`，做**明显下垂的弧度**，至少 4 条，分别跨向底座外缘（(−6,?), (5.95,?), (−2.4,−5.95)）与店屋顶，营造「模型边缘被裁切」的感觉。
   - 街角反光镜 `ANCHOR.mirror`：2.6 高杆 + 橙色圆环 + 凸面镜（浅蓝金属圆面），朝向西南。
   - 路牌：电线杆上挂「桜町 2丁目 / Sakura-machi 2」蓝底白字牌；斑马线旁加一块行人过街标志（蓝底白色图形，`createTextPanelTexture` 或 canvas 画）。
   - 护栏：南侧人行道 z≈2.62、x[-3.3,-1.25]；西侧 x≈-3.5、z[-2.9,0.2]。白色钢管 + 竖柱 + 反光贴，别挡住斑马线和停车位入口。
   - 小巷入口（东侧 x 4.2~6，z≈0.65）：巷口两根木柱 + 藏青色暖帘（noren，canvas 写「ひかり」）+ 小灯笼（发光方块/纸灯 + Glow，包 Power），巷内地面更深、有排水明沟。
   - 底座北侧（z≈-5.2）来一段低矮后墙/围挡 + 检修门，给从背面旋转观看时一点内容。
5. **动画**：地面铺装 `<Part delay={TIMING.ground}>`；设施 `<Part>` 从 `TIMING.fixtures` 开始依次 +0.12s；路灯/灯笼发光用 `<Power>`。

### C. `props/` —— 街角生活物件

必须包含（数量可微调，但一个都不能少）：

1. **自动贩卖机 ×2** `ANCHOR.vending`：面向 −x（朝西侧路口），机身 0.95(z 宽)×1.85(高)×0.72(x 深)，底部坐在人行道 y=0.18。
   - 正面（−x 面）用 canvas 贴图：饮料罐矩阵（8~12 个色块 + 盖子）、按钮、投币口、取物口、「つめた〜い」「あったか〜い」字样，整体发光；机身一台白+青、一台红白，顶部小灯箱。
   - 前方 `Glow(PALETTE.neonCyan)` + 地面 `GlowPuddle` 反光；整组包 `<Power delay={TIMING.power + 0.4}>`。
2. **自行车** `ANCHOR.bike`：城市车，斜停、脚撑撑住；两个轮（torus r≈0.34）、三角车架（圆柱）、车把、车座、前车筐、后货架、挡泥板、铃铛。尺寸约 1.6 长 × 1.1 高。别做成两片圆+一根杆，要一眼是自行车。
3. **垃圾桶 ×3** `ANCHOR.bins`：并排三只（蓝/绿/灰），0.34 宽 × 0.62 高，顶部投入口，正面贴「カン / ビン / ペット」小标签（canvas 或纯色块 + 白条）。
4. **伞架** `ANCHOR.umbrella`：金属架 + 插 2~3 把伞（一把透明、一把深蓝），露出伞柄。
5. **A 字告示牌** `ANCHOR.aBoard`：木框白面，贴 `createPosterTexture({title:"本日のおすすめ", ...})`，微斜。
6. **公告栏/海报栏**：挂在东侧小巷实墙 `ANCHOR.noticeBoard`（x=4.19，朝 +x），木框软木板 + 3 张海报（`createPosterTexture`）。
7. **猫** `ANCHOR.cat`：贩卖机旁，黑色/深蓝小猫坐姿，白胸毛，眼睛暖黄微发光；`useFrame` 让尾巴轻轻摆（振幅小）。
8. **杂物**：小巷里 2~3 个啤酒箱/纸箱堆叠、门口盆栽 ×2（深色陶盆 + 低模叶子）、停车位旁一个橙色锥桶。这些用低模即可，但要拉开轮廓。

动画：每个物件单独 `<Part delay={TIMING.props + offset} mode="pop" | "rise">`，错开 0.08~0.2s；贩卖机与猫的一小块氛围光晕包 `<Power>`；不要给猫做入场以外的复杂物理动画。

## 4. 视觉质量清单（自查）

- [ ] 剪影清楚：关掉灯看轮廓也能认出「便利店 + 街角 + 贩卖机 + 自行车 + 电线杆」。
- [ ] 轮廓线没有糊成黑块（小件 outline ≤0.015，不要每颗螺丝都加 Outlines）。
- [ ] 玻璃后面真的有东西（货架/冷柜/灯板），不是一块发光板。
- [ ] 发光面周围有 `Glow`，但光晕不要盖住文字（Glow 放招牌前 0.1~0.3，size 别超过招牌宽度 2 倍）。
- [ ] 所有物件都落在底座上、贴地、不悬空、不互相穿模。
- [ ] 主视角（西南）里，南立面 + 西路口 + 前场是满的；转到背面、东侧也有细节可看。
- [ ] 夜间整体是冷暗底 + 暖光焦点：不要出现大面积高亮白墙。
- [ ] 每个组件在浏览器控制台无 error / warning（Three 自身的 Clock/PCFSoft 警告可忽略）。

## 5. 验收（必须自己跑）

1. `cd apps/frontend && npx tsc --noEmit --incremental false` → 0 error。
2. 截图（dev server 已在 3100 跑着，**不要重启**）：
   ```
   node /tmp/agent-shot/shot.mjs http://localhost:3100/lab/rainy-store /tmp/agent-shot/<你的模块>.png 9000 none 1440 900 1
   ```
   然后 read 图片检查构图、穿模、发光是否正常。组装动画完成后再截（waitMs≥9000）。
3. 回来后报告：改了哪些文件、截图路径、还有哪些已知瑕疵。
