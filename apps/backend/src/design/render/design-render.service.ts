import { Injectable, Logger } from '@nestjs/common';
import {
  type DesignDocument,
  type FontFamily,
  fontInfo,
  googleFontCssUrl,
  imageKonvaAttrs,
  type Layer,
  textKonvaAttrs,
} from '@agent-test/design-schema';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 后端同构渲染（问题 8）：用与前端同一个 Konva + 同一份属性映射（konva-attrs），在 skia-canvas
 * 上把设计稿渲染成 PNG，给 agent 的 render_preview 自检、列表缩略图用。
 *
 * konva 10 是纯 ESM、后端是 CJS：一律动态 import()，只在第一次渲染时加载（jest 不碰它）。
 * skia-canvas 也走 import()，与 konva/skia-backend 拿到的是同一个 ESM 实例（字体库共享）。
 */

type SkiaModule = typeof import('skia-canvas');
type KonvaNS = (typeof import('konva'))['default'];

const FONT_DIR = join(process.cwd(), 'data', 'design-fonts');
const FONT_FETCH_TIMEOUT_MS = 60_000;

export interface RenderOptions {
  /** 长边像素上限（预览图不必原尺寸） */
  maxSide?: number;
  /** 标注每个图层的 id 与边框（给 agent 指认图层用） */
  annotate?: boolean;
}

@Injectable()
export class DesignRenderService {
  private readonly logger = new Logger(DesignRenderService.name);
  private libs: Promise<{ Konva: KonvaNS; skia: SkiaModule }> | null = null;
  /** 每个字体族只下载 / 注册一次（并发渲染共享同一个 promise） */
  private readonly fonts = new Map<string, Promise<void>>();

  private load() {
    this.libs ??= (async () => {
      // 先装 skia 后端（替换 Konva 的 canvas / image 工厂），再引入完整 konva：
      // 后者把 Text / Image 等形状注册到同一个 Konva 对象上
      await import('konva/skia-backend');
      const full = await import('konva');
      const skia: SkiaModule = await import('skia-canvas');
      return { Konva: full.default, skia };
    })();
    return this.libs;
  }

  async render(doc: DesignDocument, opts: RenderOptions = {}): Promise<Buffer> {
    const { Konva, skia } = await this.load();
    await Promise.all(
      [
        ...new Set(
          doc.layers.flatMap((l) => (l.type === 'text' ? [l.fontFamily] : [])),
        ),
      ].map((f) => this.ensureFont(f, skia)),
    );
    const { width, height } = doc.canvas;
    const stage = new Konva.Stage({ width, height });
    const layer = new Konva.Layer();
    stage.add(layer);
    try {
      if (doc.canvas.background !== 'transparent') {
        layer.add(
          new Konva.Rect({ width, height, fill: doc.canvas.background }),
        );
      }
      for (const l of doc.layers) {
        if (!l.visible) continue;
        const node = await this.buildNode(Konva, skia, l);
        if (node) layer.add(node);
      }
      if (opts.annotate) this.annotate(Konva, layer, doc);
      const maxSide = opts.maxSide ?? Math.max(width, height);
      const pixelRatio = Math.min(1, maxSide / Math.max(width, height));
      // Konva 的类型按浏览器写成 HTMLCanvasElement；skia 后端下它实际创建的是 skia 的 Canvas
      // （见 konva/skia-backend 的 createCanvasElement），toBuffer 只在后者上有
      const canvas = stage.toCanvas({ pixelRatio }) as unknown as InstanceType<
        SkiaModule['Canvas']
      >;
      return await canvas.toBuffer('png');
    } finally {
      stage.destroy();
    }
  }

  private async buildNode(Konva: KonvaNS, skia: SkiaModule, l: Layer) {
    if (l.type === 'text') return new Konva.Text(textKonvaAttrs(l));
    if (!l.src) return null;
    try {
      const image = await skia.loadImage(l.src);
      // skia 的 Image 与 DOM 的 HTMLImageElement 形状兼容（konva/skia-backend 正是这么喂给 Konva 的）
      return new Konva.Image({
        ...imageKonvaAttrs(l),
        image: image as unknown as HTMLImageElement,
      });
    } catch (e) {
      this.logger.warn(`渲染时加载图片失败 layer=${l.id}：${String(e)}`);
      return null;
    }
  }

  /** 图层边框 + id 标签：agent 看图时能说出「把 txt_x 往下挪」。 */
  private annotate(
    Konva: KonvaNS,
    layer: InstanceType<KonvaNS['Layer']>,
    doc: DesignDocument,
  ) {
    const scale = Math.max(doc.canvas.width, doc.canvas.height) / 1024;
    for (const l of doc.layers) {
      if (!l.visible) continue;
      const color = l.type === 'text' ? '#2563EB' : '#E11D48';
      layer.add(
        new Konva.Rect({
          x: l.x,
          y: l.y,
          width: l.width,
          height: l.height,
          rotation: 0,
          stroke: color,
          strokeWidth: 2 * scale,
          dash: [8 * scale, 6 * scale],
        }),
      );
      const label = new Konva.Label({
        x: l.x,
        y: Math.max(0, l.y - 22 * scale),
      });
      label.add(new Konva.Tag({ fill: color, cornerRadius: 3 * scale }));
      label.add(
        new Konva.Text({
          text: l.id,
          fontSize: 14 * scale,
          padding: 3 * scale,
          fill: '#FFFFFF',
          fontFamily: 'sans-serif',
        }),
      );
      layer.add(label);
    }
  }

  /** Google Fonts 的 TTF（无 UA 请求时 CSS2 回 truetype）下载到本地缓存后注册给 skia。 */
  private ensureFont(family: FontFamily, skia: SkiaModule): Promise<void> {
    let p = this.fonts.get(family);
    if (!p) {
      p = this.downloadFont(family)
        .then((paths) => {
          if (paths.length) skia.FontLibrary.use(family, paths);
        })
        .catch((e: unknown) => {
          // 字体拿不到不该让整张预览失败：退回系统字体渲染，并允许下次重试
          this.logger.warn(`字体加载失败 ${family}：${String(e)}`);
          this.fonts.delete(family);
        });
      this.fonts.set(family, p);
    }
    return p;
  }

  private async downloadFont(family: FontFamily): Promise<string[]> {
    if (!fontInfo(family)) return [];
    await mkdir(FONT_DIR, { recursive: true });
    const css = await (
      await fetch(googleFontCssUrl(family), {
        signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
      })
    ).text();
    const urls = [...css.matchAll(/src:\s*url\((https:[^)]+\.ttf)\)/g)].map(
      (m) => m[1],
    );
    const paths: string[] = [];
    for (const url of urls) {
      const file = join(
        FONT_DIR,
        `${createHash('sha1').update(url).digest('hex')}.ttf`,
      );
      const cached = await readFile(file).catch(() => null);
      if (!cached) {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
      }
      paths.push(file);
    }
    return paths;
  }
}
