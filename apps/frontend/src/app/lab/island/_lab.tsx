"use client";

import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { PALETTES, PALETTE_ORDER, skyGradient, type PaletteId } from "./_scene/palettes";
import { IslandStage } from "./_stage";

/**
 * 悬浮岛 3D 实验页。
 *
 * 全屏沉浸：天空渐变铺底 + 透明画布的实时三维场景，控制条压在底部一张卡片里。
 * 卡片与开关全部走设计系统语义 token，亮暗两套都成立；天空与动物配色属于
 * 「被验收的产物」自身的数据（_scene/palettes.ts），不参与 UI 主题。
 */
export function IslandLab() {
  const [paletteId, setPaletteId] = useState<PaletteId>("A");
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [animals, setAnimals] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReducedMotion(query.matches);
      if (query.matches) {
        setAnimals(false);
        setAutoRotate(false);
      }
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const palette = PALETTES[paletteId];

  return (
    <main className="fixed inset-0 overflow-hidden bg-background">
      {/* 天空渐变：由当前配色驱动，作为透明画布的底 */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: skyGradient(palette.sky) }}
      />

      <IslandStage
        palette={palette}
        wireframe={wireframe}
        autoRotate={autoRotate}
        animals={animals}
        reducedMotion={reducedMotion}
      />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 md:p-6">
        <section
          aria-label="场景控制"
          className="pointer-events-auto w-full max-w-3xl rounded-xl border border-border bg-card/85 p-3 text-card-foreground shadow-lg backdrop-blur-md md:p-4"
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
            <div className="min-w-0">
              <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                AgentSpark Lab · #002
              </p>
              <h1 className="mt-1 truncate text-sm font-medium">低多边形悬浮岛</h1>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                拖拽旋转 · 滚轮缩放
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                  配色
                </span>
                <div role="group" aria-label="配色方案" className="flex items-center gap-1.5">
                  {PALETTE_ORDER.map((id) => {
                    const option = PALETTES[id];
                    const active = id === paletteId;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        aria-label={`配色 ${option.name}`}
                        title={`${id} · ${option.name}`}
                        onClick={() => setPaletteId(id)}
                        className={cn(
                          "grid size-9 place-items-center rounded-full border transition-colors outline-none",
                          "focus-visible:ring-3 focus-visible:ring-ring/50",
                          active
                            ? "border-foreground/60"
                            : "border-border hover:border-foreground/30",
                        )}
                      >
                        <span
                          aria-hidden
                          className="size-6 rounded-full ring-1 ring-foreground/15"
                          style={{
                            background: `linear-gradient(to top, ${option.sky.join(", ")})`,
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {palette.name}
                </span>
              </div>

              <div className="flex items-center gap-4 border-border md:border-l md:pl-6">
                <div className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label="线框"
                    checked={wireframe}
                    onCheckedChange={setWireframe}
                  />
                  <span className="text-xs text-muted-foreground">线框</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label="自动旋转"
                    checked={autoRotate}
                    disabled={reducedMotion}
                    onCheckedChange={setAutoRotate}
                  />
                  <span className="text-xs text-muted-foreground">自动旋转</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label="动物动画"
                    checked={animals}
                    disabled={reducedMotion}
                    onCheckedChange={setAnimals}
                  />
                  <span className="text-xs text-muted-foreground">动物动画</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
