import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyOps,
  closestAspectRatio,
  createImageLayer,
  createTextLayer,
  DesignOpError,
  type DesignOp,
  designOpSchema,
  emptyDocument,
  fitContain,
  invertOps,
} from './index';

const base = () => {
  const doc = emptyDocument();
  const img = createImageLayer({ id: 'img_a', x: 0, y: 0, width: 100, height: 100 });
  const txt = createTextLayer({ id: 'txt_b', x: 10, y: 10, width: 300, height: 80 });
  return applyOps(doc, [{ type: 'add_layers', layers: [img, txt] }]);
};

test('add / update / delete / reorder 全链路', () => {
  let doc = base();
  assert.deepEqual(doc.layers.map((l) => l.id), ['img_a', 'txt_b']);
  doc = applyOps(doc, [
    { type: 'update_layers', updates: [{ id: 'txt_b', patch: { text: '你好', fontSize: 90 } }] },
    { type: 'reorder_layers', order: ['txt_b', 'img_a'] },
  ]);
  const txt = doc.layers[0];
  assert.equal(txt.type === 'text' && txt.text, '你好');
  doc = applyOps(doc, [{ type: 'delete_layers', ids: ['img_a'] }]);
  assert.equal(doc.layers.length, 1);
});

test('类型串了的 patch 被拒：文字图层不能带 src', () => {
  assert.throws(
    () => applyOps(base(), [{ type: 'update_layers', updates: [{ id: 'txt_b', patch: { src: 'https://a.com/x.png' } }] }]),
    DesignOpError,
  );
});

test('字体必须在白名单里', () => {
  const r = designOpSchema.safeParse({
    type: 'update_layers',
    updates: [{ id: 'txt_b', patch: { fontFamily: 'Comic Sans MS' } }],
  });
  assert.equal(r.success, false);
});

test('重复 id 与不存在的图层都拒', () => {
  const dup = createImageLayer({ id: 'img_a', x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => applyOps(base(), [{ type: 'add_layers', layers: [dup] }]), DesignOpError);
  assert.throws(
    () => applyOps(base(), [{ type: 'update_layers', updates: [{ id: 'nope', patch: { x: 1 } }] }]),
    DesignOpError,
  );
});

test('invertOps 能把文档精确撤销回去', () => {
  const before = base();
  const ops: DesignOp[] = [
    { type: 'update_layers', updates: [{ id: 'img_a', patch: { x: 500, opacity: 0.3 } }] },
    { type: 'delete_layers', ids: ['img_a'] },
    { type: 'set_canvas', patch: { background: 'transparent', width: 2000 } },
  ];
  const after = applyOps(before, ops);
  const restored = applyOps(after, invertOps(before, ops));
  assert.deepEqual(restored, before);
});

test('reorder 的逆', () => {
  const before = base();
  const ops: DesignOp[] = [{ type: 'reorder_layers', order: ['txt_b', 'img_a'] }];
  const restored = applyOps(applyOps(before, ops), invertOps(before, ops));
  assert.deepEqual(restored, before);
});

test('fitContain 保持中心、按比例收紧', () => {
  const r = fitContain({ x: 0, y: 0, width: 200, height: 100 }, 50, 50);
  assert.deepEqual(r, { x: 50, y: 0, width: 100, height: 100 });
});

test('closestAspectRatio 按对数距离选最近画幅', () => {
  const opts = ['1x1', '16x9', '9x16', '3x4', '4x3', '4x5'];
  assert.equal(closestAspectRatio(1080, 1350, opts), '4x5');
  assert.equal(closestAspectRatio(1920, 1000, opts), '16x9');
  assert.equal(closestAspectRatio(300, 1000, opts), '9x16');
});
