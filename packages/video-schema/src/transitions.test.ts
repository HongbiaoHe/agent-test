import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evalExpr,
  type ExprEnv,
  layoutVideoTrack,
  lintProject,
  parseExpr,
  parseProject,
  projectDuration,
  reviewOutline,
  toGlsl,
  TRANSITION_GROUPS,
  TRANSITION_TYPES,
  validateExpr,
  VIDEO_PROJECT_VERSION,
  type VideoProject,
} from './index';

function project(transitions: Array<VideoProject['video'][number]['transition']>): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name: 't',
    canvas: { width: 320, height: 240, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: 'a.mp4', sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240, transition: transitions[0] },
      { id: 'i1', type: 'image', src: 'b.png', duration: 2, width: 320, height: 240, transition: transitions[1] },
      { id: 'v2', type: 'video', src: 'c.mp4', sourceDuration: 4, inPoint: 0, outPoint: 4, volume: 1, width: 320, height: 240, transition: transitions[2] },
    ],
    audio: [],
    subtitles: { style: 'bottom-outline', cues: [] },
  };
}

test('分组覆盖全部 46 种内置转场，不重不漏', () => {
  const grouped = Object.values(TRANSITION_GROUPS).flat();
  assert.equal(TRANSITION_TYPES.length, 46);
  assert.deepEqual([...grouped].sort(), [...TRANSITION_TYPES].sort());
});

test('有转场的接缝前后两段重叠，成片变短', () => {
  const p = project([{ type: 'fade', duration: 0.5 }, undefined, { type: 'wipeleft', duration: 1 }]);
  const laid = layoutVideoTrack(p);
  assert.deepEqual(
    laid.map((l) => [l.start, l.end, l.transitionIn, l.transitionOut]),
    [
      [0, 3, 0, 0.5],
      [2.5, 4.5, 0.5, 0],
      [4.5, 8.5, 0, 0],
    ],
  );
  // 最后一段上的转场没有下一段：不生效
  assert.equal(projectDuration(p), 8.5);
});

test('转场时长夹到前后片段各自的一半；lint 报压缩与不生效', () => {
  // 图片只有 2 秒：1.5 秒的转场被压到 1 秒
  const p = project([{ type: 'fade', duration: 1.5 }, undefined, { type: 'fade', duration: 1 }]);
  assert.equal(layoutVideoTrack(p)[0].transitionOut, 1);
  assert.equal(projectDuration(p), 8);
  const clamped = lintProject(p).filter((i) => i.code === 'transition_clamped');
  assert.deepEqual(
    clamped.map((i) => [i.target.id, i.value, i.limit]),
    [
      ['v1', 1, 1.5],
      ['v2', 0, 1],
    ],
  );
});

test('自定义转场：expr 必填且要合法；内置转场不需要 expr', () => {
  const ok = parseProject(project([{ type: 'custom', duration: 0.5, expr: 'A*P+B*(1-P)', name: '自创淡化' }, undefined, undefined]));
  assert.equal(ok.ok, true);
  const missing = parseProject(project([{ type: 'custom', duration: 0.5 }, undefined, undefined]));
  assert.equal(missing.ok, false);
  const bad = parseProject(project([{ type: 'custom', duration: 0.5, expr: 'A*P+random(0)' }, undefined, undefined]));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.issues.join(), /不支持的函数：random/);
});

test('表达式解析：优先级与 libavutil 一致', () => {
  const env: ExprEnv = { X: 3, Y: 4, W: 100, H: 50, A: 200, B: 100, P: 0.25, PLANE: 0 };
  const ev = (s: string) => evalExpr(parseExpr(s), env);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('2^3^2'), 64); // 左结合
  assert.equal(ev('1+2*3'), 7);
  assert.equal(ev('A*P+B*(1-P)'), 125);
  assert.equal(ev('if(gt(X,W/2),A,B)'), 100);
  assert.equal(ev('if(lt(X,2),A)'), 0);
  assert.equal(ev('mod(-1,3)'), 2);
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('hypot(X,Y)'), 5);
  assert.equal(ev('between(P,0,0.5)*PI'), Math.PI);
});

test('表达式校验：给出可改正的中文错误', () => {
  assert.equal(validateExpr('A*P + B*(1-P)'), null);
  assert.match(validateExpr('A*Q') ?? '', /不认识的变量：Q/);
  assert.match(validateExpr('st(0,1);A') ?? '', /不支持的函数：st/);
  assert.match(validateExpr('A;B') ?? '', /不支持用 ; 串联/);
  assert.match(validateExpr('clip(A,0)') ?? '', /clip 需要 3 个参数/);
  assert.match(validateExpr('(A+B') ?? '', /应为「\)」/);
});

test('翻译成 GLSL：比较 / 条件 / 乘方走辅助函数', () => {
  assert.equal(toGlsl(parseExpr('if(gt(X,W/2),A,B)')), '((((X) > ((W / 2.0)) ? 1.0 : 0.0)) != 0.0 ? (A) : (B))');
  assert.equal(toGlsl(parseExpr('-P^2')), '(-x_pow(P, 2.0))');
  assert.equal(toGlsl(parseExpr('atan2(Y,X)+PI')), `(atan(Y, X) + ${Math.PI})`);
});

test('审片时间线概要带上转场', () => {
  assert.match(reviewOutline(project([{ type: 'fade', duration: 0.5 }, undefined, undefined])), /v1 视频 0\.00s–3\.00s，接下一段用转场 fade 0\.50s/);
});
