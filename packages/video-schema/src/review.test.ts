import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectFingerprint,
  reviewOutline,
  reviewPathOf,
  reviewTargets,
  VIDEO_PROJECT_VERSION,
  type VideoProject,
} from './index';

function sample(): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name: '样片',
    canvas: { width: 1080, height: 1920, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: 'a.mp4', sourceDuration: 5, inPoint: 0, outPoint: 4, volume: 1, width: 1080, height: 1920 },
      { id: 'i1', type: 'image', src: 'logo.png', duration: 2, width: 1080, height: 1920 },
    ],
    audio: [{ id: 'a1', src: 'vo.mp3', role: 'voice', sourceDuration: 3, start: 1, inPoint: 0, outPoint: 3, volume: 1, fadeIn: 0, fadeOut: 0 }],
    subtitles: { style: 'bottom-outline', cues: [{ id: 's1', start: 4.5, end: 5.5, text: '片尾' }] },
  };
}

test('审片文件路径', () => {
  assert.equal(reviewPathOf('videos/promo.sparkvideo.json'), 'videos/promo.review.json');
});

test('指纹与对象键顺序无关，内容一变就变', () => {
  const p = sample();
  const reordered = { ...p, canvas: { fps: 30, height: 1920, width: 1080 } };
  assert.equal(projectFingerprint(reordered), projectFingerprint(p));
  assert.notEqual(projectFingerprint({ ...p, name: '改名' }), projectFingerprint(p));
});

test('时间区间映射回片段 / 字幕 / 音频 id', () => {
  const p = sample();
  assert.deepEqual(reviewTargets(p, 4.6, 5), [
    { kind: 'video', id: 'i1' },
    { kind: 'subtitle', id: 's1' },
  ]);
  // 时间点：按 0.5 秒窗口
  assert.deepEqual(reviewTargets(p, 2, 2), [
    { kind: 'video', id: 'v1' },
    { kind: 'audio', id: 'a1' },
  ]);
});

test('时间线概要带镜头、配音与字幕', () => {
  const o = reviewOutline(sample());
  assert.match(o, /v1 视频 0\.00s–4\.00s/);
  assert.match(o, /a1 配音 1\.00s–4\.00s/);
  assert.match(o, /s1 4\.50s–5\.50s「片尾」/);
});
