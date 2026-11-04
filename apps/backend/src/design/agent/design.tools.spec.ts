import { createImageLayer, emptyDocument } from '@agent-test/design-schema';
import { z } from 'zod';
import type { DesignAssetsService } from '../design-assets.service';
import type { DesignDecomposeService } from '../design-decompose.service';
import type { DesignGenerationService } from '../design-generation.service';
import type { DesignService } from '../design.service';
import type { DesignRenderService } from '../render/design-render.service';
import {
  contactSheet,
  createDesignTools,
  summarizeDocument,
} from './design.tools';

/**
 * Gemini 的函数声明只收 OpenAPI 子集：exclusiveMinimum（zod .positive()）、propertyNames（z.record）
 * 都会让整轮 400（2026-11-03 实测「Unknown name exclusiveMinimum」）。jest 跑不到真模型，
 * 所以在这里把每个工具的参数 schema 转成 JSON Schema，拦住这些关键字。
 */
const FORBIDDEN = [
  'exclusiveMinimum',
  'exclusiveMaximum',
  'propertyNames',
  'pattern',
  'anyOf',
  'oneOf',
];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

function tools() {
  const fake = {} as unknown;
  return createDesignTools({
    docId: 'doc',
    // 只取 schema、不执行工具：依赖注入处统一 cast（见 CLAUDE.md §8 测试约定）
    design: fake as DesignService,
    generation: fake as DesignGenerationService,
    render: fake as DesignRenderService,
    assets: fake as DesignAssetsService,
    decompose: fake as DesignDecomposeService,
    seedream: true,
    publish: () => Promise.resolve(),
    generations: { count: 0 },
  });
}

describe('design 工具 schema', () => {
  it.each(tools().map((t) => [t.name, t] as const))(
    '%s 的参数不含 Gemini 不认的 JSON Schema 关键字',
    (_name, t) => {
      const schema = z.toJSONSchema(t.schema as z.ZodType);
      const used = [...keysDeep(schema)].filter((k) => FORBIDDEN.includes(k));
      expect(used).toEqual([]);
    },
  );
});

describe('Seedream 开关', () => {
  it('配了 BytePlus 才挂 decompose_layer', () => {
    expect(tools().map((t) => t.name)).toContain('decompose_layer');
  });
});

describe('contactSheet', () => {
  it('每个图层 contain 进一格、去掉旋转，画布按格数排开', () => {
    const sheet = contactSheet([
      createImageLayer({
        id: 'img_a',
        x: 500,
        y: 900,
        width: 1000,
        height: 250,
        rotation: 30,
      }),
      createImageLayer({ id: 'img_b', x: 0, y: 0, width: 100, height: 400 }),
    ]);
    expect(sheet.canvas).toMatchObject({ width: 720, height: 360 });
    const [a, b] = sheet.layers;
    expect(a.rotation).toBe(0);
    expect(a.width).toBeCloseTo(304);
    expect(a.height).toBeCloseTo(76);
    expect(b.height).toBeCloseTo(304);
    expect(b.x).toBeGreaterThanOrEqual(360);
  });
});

describe('summarizeDocument', () => {
  it('按 z 序列出图层的 id、类型与状态', () => {
    const doc = emptyDocument();
    doc.layers.push(
      createImageLayer({
        id: 'img_a',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        status: 'generating',
      }),
    );
    const text = summarizeDocument(doc);
    expect(text).toContain('img_a');
    expect(text).toContain('status=generating');
  });
});
