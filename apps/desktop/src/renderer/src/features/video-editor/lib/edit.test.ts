import { describe, expect, it } from 'vitest';
import { parseProject, type VideoClip } from '@agent-test/video-schema';
import { addCueAt, addImportedMedia, moveTrackClip, removeSelection, retimeCue, trimAudioClip, trimVideoClip } from './edit';
import { sampleProject } from './fixtures';

const videoA = (): VideoClip => {
  const c = sampleProject().video[0];
  if (c.type !== 'video') throw new Error('fixture');
  return c;
};

describe('编辑都夹在 schema 允许的范围内', () => {
  it('视频入点出点不超出素材时长，且出点 > 入点', () => {
    expect(trimVideoClip(videoA(), { outPoint: 99 })).toMatchObject({ inPoint: 2, outPoint: 10 });
    expect(trimVideoClip(videoA(), { inPoint: -3 })).toMatchObject({ inPoint: 0, outPoint: 6 });
    // 入点推过出点：出点跟着让开
    expect(trimVideoClip(videoA(), { inPoint: 8 })).toMatchObject({ inPoint: 8, outPoint: 8.1 });
    expect(trimVideoClip(videoA(), { outPoint: 1 })).toMatchObject({ inPoint: 0.9, outPoint: 1 });
  });

  it('音频裁短后淡入淡出压进时长', () => {
    const bgm = sampleProject().audio[0];
    const a = trimAudioClip(bgm, { outPoint: 12 });
    expect(a.outPoint - a.inPoint).toBe(2);
    expect(a.fadeIn + a.fadeOut).toBeLessThanOrEqual(2);
    const b = trimAudioClip(bgm, { fadeOut: 3.5 });
    expect(b.fadeOut).toBe(3.5);
    expect(b.fadeIn).toBeCloseTo(0.5);
  });

  it('字幕结束晚于开始', () => {
    const c = sampleProject().subtitles.cues[0];
    expect(retimeCue(c, { end: 0 })).toMatchObject({ start: 0, end: 0.1 });
    expect(retimeCue(c, { start: 5 })).toMatchObject({ start: 5, end: 5.1 });
  });

  it('左移 / 右移 / 删除 / 加字幕后工程仍然合法', () => {
    let p = moveTrackClip(sampleProject(), 'b', -1);
    expect(p.video.map((c) => c.id)).toEqual(['a', 'b', 'img']);
    expect(moveTrackClip(p, 'a', -1)).toBe(p);
    p = removeSelection(p, { kind: 'audio', id: 'vo' });
    const added = addCueAt(p, 3.2, 'hi', 'c9');
    expect(added.project.subtitles.cues.map((c) => c.id)).toEqual(['c1', 'c2', 'c9', 'c3']);
    expect(parseProject(added.project).ok).toBe(true);
  });

  it('导入：视频 / 图片追加到视频轨末尾，音频起点 0，类型不符的跳过', () => {
    let n = 0;
    const id = (prefix: string) => `${prefix}-${++n}`;
    const probes = [
      { path: 'media/imports/x.mp4', kind: 'video' as const, duration: 5, width: 640, height: 360, hasAudio: true },
      { path: 'media/imports/y.png', kind: 'image' as const, duration: null, width: null, height: null, hasAudio: false },
      { path: 'media/imports/z.mp3', kind: 'audio' as const, duration: 30, width: null, height: null, hasAudio: true },
    ];
    const visual = addImportedMedia(sampleProject(), probes, 'visual', id);
    expect(visual.skipped).toBe(1);
    expect(visual.project.video.slice(3).map((c) => [c.type, c.src])).toEqual([
      ['video', 'media/imports/x.mp4'],
      ['image', 'media/imports/y.png'],
    ]);
    expect(visual.project.video[4]).toMatchObject({ width: 1080, height: 1920 });
    const audio = addImportedMedia(sampleProject(), probes.slice(2), 'audio', id);
    expect(audio.project.audio[2]).toMatchObject({ src: 'media/imports/z.mp3', start: 0, inPoint: 0, outPoint: 30 });
    expect(parseProject(visual.project).ok).toBe(true);
    expect(parseProject(audio.project).ok).toBe(true);
  });
});
