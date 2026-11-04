import { z } from 'zod';
import {
  canvasPatchSchema,
  type DesignDocument,
  designDocumentSchema,
  type Layer,
  type LayerPatch,
  layerIdSchema,
  layerPatchSchema,
  layerSchema,
} from './layer';

/**
 * 文档 op：人和 agent 改文档走**同一套**操作（问题 3）。服务端是唯一真相源：校验 → 应用 →
 * revision+1 → 广播；前端乐观地先在本地应用同一个 applyOps，再以服务端回显为准。
 *
 * update_layers 是**字段级** patch：两边同时改同一图层的不同字段都保留，改同一字段后到的覆盖。
 */
export const addLayersOpSchema = z.strictObject({
  type: z.literal('add_layers'),
  layers: z.array(layerSchema).min(1).max(50),
  /** 插入位置（z 序下标）；缺省 = 放到最上层 */
  index: z.number().int().min(0).optional(),
});

export const updateLayersOpSchema = z.strictObject({
  type: z.literal('update_layers'),
  updates: z
    .array(z.strictObject({ id: layerIdSchema, patch: layerPatchSchema }))
    .min(1)
    .max(100),
});

export const deleteLayersOpSchema = z.strictObject({
  type: z.literal('delete_layers'),
  ids: z.array(layerIdSchema).min(1).max(100),
});

/** 给出完整的新顺序（自底向上）：必须恰好是现有图层 id 的一个排列。幂等、好求逆。 */
export const reorderLayersOpSchema = z.strictObject({
  type: z.literal('reorder_layers'),
  order: z.array(layerIdSchema).max(200),
});

export const setCanvasOpSchema = z.strictObject({
  type: z.literal('set_canvas'),
  patch: canvasPatchSchema,
});

export const designOpSchema = z.discriminatedUnion('type', [
  addLayersOpSchema,
  updateLayersOpSchema,
  deleteLayersOpSchema,
  reorderLayersOpSchema,
  setCanvasOpSchema,
]);
export type DesignOp = z.infer<typeof designOpSchema>;

export const designOpBatchSchema = z.array(designOpSchema).min(1).max(50);

/** 这批 op 是谁发起的：前端据此决定动效（agent 的改动带「智能体光标」）。 */
export const OP_SOURCES = ['user', 'agent', 'system'] as const;
export type OpSource = (typeof OP_SOURCES)[number];

export class DesignOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignOpError';
  }
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** 合并 patch 后整层重验：类型串了（文字层带 src）会在这里被拒。 */
export function mergeLayerPatch(layer: Layer, patch: LayerPatch): Layer {
  const parsed = layerSchema.safeParse({ ...layer, ...patch });
  if (!parsed.success) {
    throw new DesignOpError(`图层 ${layer.id} 的修改不合法：${zodMessage(parsed.error)}`);
  }
  return parsed.data;
}

function applyOne(doc: DesignDocument, op: DesignOp): DesignDocument {
  switch (op.type) {
    case 'add_layers': {
      const existing = new Set(doc.layers.map((l) => l.id));
      for (const l of op.layers) {
        if (existing.has(l.id)) throw new DesignOpError(`图层 id 已存在：${l.id}`);
        existing.add(l.id);
      }
      const layers = [...doc.layers];
      const at = Math.min(op.index ?? layers.length, layers.length);
      layers.splice(at, 0, ...op.layers);
      return { ...doc, layers };
    }
    case 'update_layers': {
      const byId = new Map(op.updates.map((u) => [u.id, u.patch]));
      for (const id of byId.keys()) {
        if (!doc.layers.some((l) => l.id === id)) {
          throw new DesignOpError(`图层不存在：${id}`);
        }
      }
      return {
        ...doc,
        layers: doc.layers.map((l) => {
          const patch = byId.get(l.id);
          return patch ? mergeLayerPatch(l, patch) : l;
        }),
      };
    }
    case 'delete_layers': {
      const ids = new Set(op.ids);
      return { ...doc, layers: doc.layers.filter((l) => !ids.has(l.id)) };
    }
    case 'reorder_layers': {
      const current = new Set(doc.layers.map((l) => l.id));
      const next = new Set(op.order);
      if (
        next.size !== op.order.length ||
        next.size !== current.size ||
        op.order.some((id) => !current.has(id))
      ) {
        throw new DesignOpError('reorder_layers 的 order 必须恰好包含现有全部图层 id，且不重复');
      }
      const byId = new Map(doc.layers.map((l) => [l.id, l]));
      return { ...doc, layers: op.order.map((id) => byId.get(id) as Layer) };
    }
    case 'set_canvas':
      return { ...doc, canvas: { ...doc.canvas, ...op.patch } };
  }
}

/**
 * 依次应用一批 op，结果整份再过一次文档 schema（图层数上限、id 唯一）。
 * 纯函数：任何一步不合法就抛 DesignOpError，调用方整批放弃（不会半应用）。
 */
export function applyOps(doc: DesignDocument, ops: readonly DesignOp[]): DesignDocument {
  const next = ops.reduce(applyOne, doc);
  const parsed = designDocumentSchema.safeParse(next);
  if (!parsed.success) {
    throw new DesignOpError(`文档不合法：${zodMessage(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * 求逆：在**应用前**的文档上算出能撤销这批 op 的 op 序列（前端撤销/重做用）。
 * 返回的序列按顺序应用即可回到原状。
 */
export function invertOps(before: DesignDocument, ops: readonly DesignOp[]): DesignOp[] {
  const inverse: DesignOp[] = [];
  let doc = before;
  for (const op of ops) {
    inverse.unshift(...invertOne(doc, op));
    doc = applyOne(doc, op);
  }
  return inverse;
}

function invertOne(doc: DesignDocument, op: DesignOp): DesignOp[] {
  switch (op.type) {
    case 'add_layers':
      return [{ type: 'delete_layers', ids: op.layers.map((l) => l.id) }];
    case 'update_layers':
      return [
        {
          type: 'update_layers',
          updates: op.updates.flatMap((u) => {
            const old = doc.layers.find((l) => l.id === u.id);
            if (!old) return [];
            const patch: Record<string, unknown> = {};
            const oldRecord: Record<string, unknown> = old;
            for (const key of Object.keys(u.patch)) patch[key] = oldRecord[key];
            // patch 的键都取自 layerPatchSchema、值取自同一图层的旧值，形状必然合法
            return [{ id: u.id, patch: patch as LayerPatch }];
          }),
        },
      ];
    case 'delete_layers': {
      const ids = new Set(op.ids);
      // 按原下标从低到高逐个插回，下标随插入自然对齐
      return doc.layers.flatMap((l, index) =>
        ids.has(l.id) ? [{ type: 'add_layers' as const, layers: [l], index }] : [],
      );
    }
    case 'reorder_layers':
      return [{ type: 'reorder_layers', order: doc.layers.map((l) => l.id) }];
    case 'set_canvas': {
      const patch: Record<string, unknown> = {};
      const oldCanvas: Record<string, unknown> = doc.canvas;
      for (const key of Object.keys(op.patch)) patch[key] = oldCanvas[key];
      return [{ type: 'set_canvas', patch: patch as typeof op.patch }];
    }
  }
}
