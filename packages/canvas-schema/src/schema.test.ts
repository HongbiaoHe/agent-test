import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPatch,
  buildAgentCanvasContext,
  CANVAS_STATE_MARKER,
  canConnectNodeTypes,
  clipOrderTag,
  collectGenerationInputs,
  isCanvasBusy,
  resolveNodeIdIn,
  runLockFromEvent,
  type CanvasNodeDto,
  type CanvasState,
} from './index';

const node = (id: string, over: Partial<CanvasNodeDto> = {}): CanvasNodeDto => ({
  id,
  type: 'image_gen',
  x: 0,
  y: 0,
  version: 1,
  label: null,
  prompt: null,
  assetPath: null,
  mediaGenerationId: null,
  mediaChannel: null,
  mediaModel: null,
  mediaParams: null,
  mediaVersionId: null,
  mediaStatus: null,
  mediaMock: false,
  outputs: [],
  ...over,
});

test('applyPatch：生成节点的 update patch 不带 media JOIN，沿用旧的 outputs / 状态', () => {
  const done = node('a', {
    mediaVersionId: 'v1',
    mediaStatus: 'done',
    outputs: [{ type: 'image', content: 'v1' }],
  });
  const s: CanvasState = { nodes: [done], edges: [], revision: 3 };
  const next = applyPatch(s, { op: 'update_node', node: node('a', { label: '新' }), revision: 4 });
  assert.equal(next.revision, 4);
  assert.deepEqual(next.nodes[0].outputs, done.outputs);
  assert.equal(next.nodes[0].mediaStatus, 'done');
  assert.equal(next.nodes[0].label, '新');
});

test('applyPatch：删节点连带删边；reorder_inputs 按新顺序排入边；move 不改 revision', () => {
  const s: CanvasState = {
    nodes: [node('a'), node('b'), node('c', { type: 'video_concat' })],
    edges: [
      { id: 'e1', source: 'a', target: 'c' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
    revision: 1,
  };
  const reordered = applyPatch(s, { op: 'reorder_inputs', nodeId: 'c', edgeIds: ['e2', 'e1'], revision: 2 });
  assert.deepEqual(reordered.edges.map((e) => e.id), ['e2', 'e1']);
  const removed = applyPatch(reordered, { op: 'remove_node', nodeId: 'a', revision: 3 });
  assert.deepEqual(removed.edges.map((e) => e.id), ['e2']);
  const moved = applyPatch(removed, { op: 'move_node', nodeId: 'b', x: 9, y: 9 });
  assert.equal(moved.revision, 3);
  assert.equal(moved.nodes.find((n) => n.id === 'b')?.x, 9);
});

test('连线规则与上游收集：在途上游算 pending，没产物也没在生成的算 missing', () => {
  assert.equal(canConnectNodeTypes('image_upload', 'image_gen'), true);
  assert.equal(canConnectNodeTypes('image_gen', 'image_upload'), false);
  const nodes = [
    node('up1', { type: 'image_upload', outputs: [{ type: 'image', content: 'v-up' }] }),
    node('gen', { mediaVersionId: 'v-gen', mediaStatus: 'generating' }),
    node('idle'),
    node('target', { type: 'video_gen' }),
  ];
  const edges = ['up1', 'gen', 'idle'].map((s) => ({ source: s, target: 'target' }));
  const r = collectGenerationInputs(nodes, edges, 'target');
  assert.deepEqual(r.referenceVersionIds, ['v-up', 'v-gen']);
  assert.equal(r.pendingInputs, 1);
  assert.deepEqual(r.missingInputs.map((n) => n.id), ['idle']);
});

test('注入文本：用短 id；圈定节点时只列圈定的与相邻连线；空画布给起始位置', () => {
  const nodes = [node('aaaaaa111111', { label: '镜1' }), node('bbbbbb222222', { label: '镜2' })];
  const edges = [{ id: 'e', source: 'aaaaaa111111', target: 'bbbbbb222222' }];
  const all = buildAgentCanvasContext({ nodes, edges, focusNodeIds: [] });
  assert.ok(all.startsWith(CANVAS_STATE_MARKER));
  assert.ok(all.includes('- 111111 [image_gen] "镜1"'));
  assert.ok(all.includes('- 111111 → 222222'));
  const focused = buildAgentCanvasContext({ nodes, edges, focusNodeIds: ['bbbbbb222222'] });
  assert.ok(!focused.includes('"镜1"'));
  assert.ok(focused.includes('- 111111 → 222222'));
  assert.ok(focused.includes('### 关注范围'));
  assert.ok(buildAgentCanvasContext({ nodes: [], edges: [], focusNodeIds: [] }).includes('从 (40, 40) 开始布局'));
  assert.equal(clipOrderTag(nodes, edges, 'bbbbbb222222'), ' <拼接顺序: 111111「镜1」>');
});

test('短 id 反解：完整 id 精确匹配，后缀唯一才认', () => {
  assert.equal(resolveNodeIdIn(['abc123', 'xyz123'], 'abc123'), 'abc123');
  assert.equal(resolveNodeIdIn(['abc123', 'xyz456'], '456'), 'xyz456');
  assert.equal(resolveNodeIdIn(['abc123', 'xyz123'], '123'), null);
  assert.equal(resolveNodeIdIn(['abc123'], 'nope'), null);
});

test('忙碌判定：服务端 agent 在跑，或 desktop 锁未过期', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const lock = (iso: string) => ({ holderId: 'h', label: null, expiresAt: iso });
  assert.equal(isCanvasBusy({ status: 'running', runLock: null }, now), true);
  assert.equal(isCanvasBusy({ status: 'idle', runLock: lock('2026-11-20T00:00:30Z') }, now), true);
  assert.equal(isCanvasBusy({ status: 'idle', runLock: lock('2026-11-19T23:59:59Z') }, now), false);
  assert.equal(isCanvasBusy({ status: 'idle', runLock: null }, now), false);
});

test('canvas_lock 事件解析：锁 / 释放（null）/ 形状不对（undefined，调用方忽略）', () => {
  const lock = { holderId: 'h', label: '对话', expiresAt: '2026-11-20T00:00:30Z' };
  assert.deepEqual(runLockFromEvent({ runLock: lock }), lock);
  assert.equal(runLockFromEvent({ runLock: null }), null);
  assert.equal(runLockFromEvent({ runLock: { holderId: 1 } }), undefined);
  assert.equal(runLockFromEvent('x'), undefined);
});
