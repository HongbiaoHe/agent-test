import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyProject,
  layoutVideoTrack,
  parseProject,
  projectDuration,
  VIDEO_PROJECT_VERSION,
  type VideoProject,
} from './index';

function sample(): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name: '样片',
    canvas: { width: 1080, height: 1920, fps: 30 },
    video: [
      { id: 'v1', type: 'video', src: 'media/a/1.mp4', sourceDuration: 8, inPoint: 1, outPoint: 6, volume: 1, width: 1080, height: 1920 },
      { id: 'i1', type: 'image', src: 'media/logo.png', duration: 2, width: 512, height: 512 },
      { id: 'v2', type: 'video', src: 'media/b/2.mp4', sourceDuration: 5, inPoint: 0, outPoint: 5, volume: 0, width: 1920, height: 1080 },
    ],
    audio: [
      { id: 'a1', src: 'media/bgm.mp3', sourceDuration: 60, start: 0, inPoint: 10, outPoint: 22, volume: 0.6, fadeIn: 1, fadeOut: 2 },
    ],
    subtitles: {
      style: 'bottom-outline',
      cues: [
        { id: 's1', start: 0, end: 2.5, text: '第一句' },
        { id: 's2', start: 3, end: 5, text: '第二句' },
      ],
    },
  };
}

test('合法工程能解析，缺省字段补默认值', () => {
  const p = parseProject({ version: 1, name: 'x', canvas: { width: 1280, height: 720 }, video: [], audio: [], subtitles: { cues: [] } });
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.project.canvas.fps, 30);
    assert.equal(p.project.subtitles.style, 'bottom-outline');
  }
});

test('时长：视频轨各段时长相加（裁剪后 5s + 图片 2s + 5s = 12s）', () => {
  assert.equal(projectDuration(sample()), 12);
});

test('视频轨布局：每段在成片里的起止时间', () => {
  assert.deepEqual(
    layoutVideoTrack(sample()).map((c) => [c.clip.id, c.start, c.end]),
    [
      ['v1', 0, 5],
      ['i1', 5, 7],
      ['v2', 7, 12],
    ],
  );
});

test('结构错误：出点不大于入点、出点超过素材时长、音量越界、版本不对', () => {
  const bad = sample();
  bad.video[0] = { ...bad.video[0], inPoint: 6, outPoint: 6 } as VideoProject['video'][number];
  const r1 = parseProject(bad);
  assert.equal(r1.ok, false);

  const over = sample();
  over.video[0] = { ...over.video[0], outPoint: 9 } as VideoProject['video'][number];
  const r2 = parseProject(over);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.issues.join('\n'), /video\.0/);

  const vol = sample();
  vol.audio[0] = { ...vol.audio[0], volume: 3 };
  assert.equal(parseProject(vol).ok, false);

  assert.equal(parseProject({ ...sample(), version: 99 }).ok, false);
});

test('语义错误：id 重复、字幕结束早于开始、素材路径不在工作区内', () => {
  const dup = sample();
  dup.audio[0] = { ...dup.audio[0], id: 'v1' };
  const r1 = parseProject(dup);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.issues.join('\n'), /id 重复.*v1/);

  const cue = sample();
  cue.subtitles.cues[0] = { ...cue.subtitles.cues[0], start: 3, end: 1 };
  assert.equal(parseProject(cue).ok, false);

  for (const src of ['/etc/passwd', '../outside.mp4', 'media/../../x.mp4']) {
    const esc = sample();
    esc.video[0] = { ...esc.video[0], src } as VideoProject['video'][number];
    const r = parseProject(esc);
    assert.equal(r.ok, false, src);
  }
});

test('emptyProject：给定画布与名字，三轨都为空', () => {
  const p = emptyProject('新工程', { width: 1920, height: 1080 });
  assert.equal(p.video.length + p.audio.length + p.subtitles.cues.length, 0);
  assert.equal(parseProject(p).ok, true);
});
