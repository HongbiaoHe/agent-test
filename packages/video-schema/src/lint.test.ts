import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approxMeasureEm,
  describeLintIssue,
  lintProject,
  parseProject,
  readingUnits,
  VIDEO_PROJECT_VERSION,
  type VideoProject,
} from './index';

/** 1080x1920 竖屏、两段 5 秒竖屏视频（共 10 秒），没有问题的基线工程 */
function clean(): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name: '基线',
    canvas: { width: 1080, height: 1920, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: 'a.mp4', sourceDuration: 5, inPoint: 0, outPoint: 5, volume: 1, width: 1080, height: 1920 },
      { id: 'v2', type: 'video', src: 'b.mp4', sourceDuration: 5, inPoint: 0, outPoint: 5, volume: 1, width: 1080, height: 1920 },
    ],
    audio: [
      { id: 'a1', src: 'bgm.mp3', role: 'music', sourceDuration: 30, start: 0, inPoint: 0, outPoint: 10, volume: 0.5, fadeIn: 0, fadeOut: 0 },
    ],
    subtitles: { style: 'bottom-outline', cues: [{ id: 's1', start: 0, end: 2, text: '你好世界' }] },
  };
}

const codes = (p: VideoProject) => lintProject(p).map((i) => `${i.code}:${i.target.id}`);

test('基线工程没有问题', () => {
  assert.deepEqual(lintProject(clean()), []);
});

test('旧工程没有 role 时按 music 解析', () => {
  const raw = clean();
  const { role: _role, ...audioWithoutRole } = raw.audio[0];
  const r = parseProject({ ...raw, audio: [audioWithoutRole] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.project.audio[0].role, 'music');
});

test('字幕超出成片、互相重叠', () => {
  const p = clean();
  p.subtitles.cues = [
    { id: 's1', start: 0, end: 3, text: '一' },
    { id: 's2', start: 2, end: 4, text: '二' },
    { id: 's3', start: 9, end: 11, text: '三' },
  ];
  assert.deepEqual(codes(p), ['subtitle_overlap:s1', 'subtitle_out_of_range:s3']);
  const overlap = lintProject(p).find((i) => i.code === 'subtitle_overlap');
  assert.equal(overlap?.start, 2);
  assert.equal(overlap?.end, 3);
});

test('字幕断行超过 2 行、每秒字数过多', () => {
  const p = clean();
  // 竖屏一行约 16 个汉字：60 个字至少 4 行
  p.subtitles.cues = [{ id: 's1', start: 0, end: 10, text: '字'.repeat(60) }];
  assert.deepEqual(codes(p), ['subtitle_too_many_lines:s1']);
  p.subtitles.cues = [{ id: 's1', start: 0, end: 1, text: '一二三四五六七' }];
  const fast = lintProject(p);
  assert.deepEqual(fast.map((i) => i.code), ['subtitle_too_fast']);
  assert.equal(fast[0].value, 7);
});

test('宽高比不符出黑边、分辨率过低、片段过短', () => {
  const p = clean();
  p.video[0] = { ...p.video[0], width: 1920, height: 1080 };
  p.video[1] = { id: 'i1', type: 'image', src: 'logo.png', duration: 0.3, width: 540, height: 960 };
  p.audio[0] = { ...p.audio[0], outPoint: 5 };
  assert.deepEqual(codes(p), ['letterbox:v1', 'clip_too_short:i1', 'low_resolution:i1']);
});

test('音频超出成片', () => {
  const p = clean();
  p.audio[0] = { ...p.audio[0], start: 8, outPoint: 5 };
  const [issue] = lintProject(p);
  assert.equal(issue.code, 'audio_out_of_range');
  assert.equal(issue.value, 3);
  assert.match(describeLintIssue(issue), /音频片段 a1 超出成片/);
});

test('阅读量与近似字宽', () => {
  assert.equal(readingUnits('Hello world，你好！'), 4);
  assert.equal(approxMeasureEm('中a '), 1 + 0.55 + 0.3);
});
