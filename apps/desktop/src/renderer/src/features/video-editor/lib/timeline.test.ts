import { describe, expect, it } from 'vitest';
import { emptyProject } from '@agent-test/video-schema';
import { sampleProject } from './fixtures';
import { audioVoicesAt, cueAt, fadeFactor, formatTime, videoFrameAt } from './timeline';

describe('videoFrameAt：成片时间 → 当前片段与素材内时间', () => {
  const p = sampleProject();

  it('视频片段：素材时间 = inPoint + (t - start)', () => {
    const f = videoFrameAt(p, 1.5);
    expect(f?.laid.clip.id).toBe('a');
    expect(f?.sourceTime).toBeCloseTo(3.5);
  });

  it('区间左闭右开：t 正好在边界上属于后一段', () => {
    expect(videoFrameAt(p, 4)?.laid.clip.id).toBe('img');
    expect(videoFrameAt(p, 6)?.laid.clip.id).toBe('b');
    expect(videoFrameAt(p, 6)?.sourceTime).toBeCloseTo(0);
  });

  it('图片片段：素材时间是片段内已显示的秒数', () => {
    const f = videoFrameAt(p, 5.25);
    expect(f?.laid.clip.id).toBe('img');
    expect(f?.laid.start).toBe(4);
    expect(f?.sourceTime).toBeCloseTo(1.25);
  });

  it('到末尾及之后停在最后一段的末帧，负数当 0', () => {
    expect(videoFrameAt(p, 9)?.laid.clip.id).toBe('b');
    expect(videoFrameAt(p, 99)?.sourceTime).toBeCloseTo(3);
    expect(videoFrameAt(p, -1)?.sourceTime).toBeCloseTo(2);
  });

  it('视频轨为空返回 null', () => {
    expect(videoFrameAt(emptyProject('x', { width: 1, height: 1 }), 0)).toBeNull();
  });
});

describe('audioVoicesAt：正在播放的音频、素材时间与带淡入淡出的音量', () => {
  const p = sampleProject();

  it('起点之前不发声，区间左闭右开', () => {
    expect(audioVoicesAt(p, 0.5)).toEqual([]);
    expect(audioVoicesAt(p, 5).map((v) => v.clip.id)).toEqual(['vo']);
    expect(audioVoicesAt(p, 8)).toEqual([]);
  });

  it('淡入段：音量从 0 线性升到 volume', () => {
    const [v] = audioVoicesAt(p, 1.5);
    expect(v.clip.id).toBe('bgm');
    expect(v.sourceTime).toBeCloseTo(10.5);
    expect(v.gain).toBeCloseTo(0.8 * 0.5);
  });

  it('中段满音量；淡出段线性降到 0；可与其它音频重叠', () => {
    const voices = audioVoicesAt(p, 3.5);
    expect(voices.map((v) => v.clip.id)).toEqual(['bgm', 'vo']);
    // bgm 片段内 2.5 秒，时长 4，淡出 2 秒 → 剩 1.5 / 2
    expect(voices[0].gain).toBeCloseTo(0.8 * 0.75);
    expect(voices[0].sourceTime).toBeCloseTo(12.5);
    expect(voices[1].gain).toBeCloseTo(1);
    expect(voices[1].sourceTime).toBeCloseTo(0.5);
    expect(audioVoicesAt(p, 2.5)[0].gain).toBeCloseTo(0.8);
  });

  it('淡入淡出重叠时取小', () => {
    const clip = { inPoint: 0, outPoint: 2, fadeIn: 1.5, fadeOut: 1.5 };
    expect(fadeFactor(clip, 1)).toBeCloseTo(Math.min(1 / 1.5, 1 / 1.5));
    expect(fadeFactor(clip, 0)).toBe(0);
    expect(fadeFactor(clip, 2)).toBe(0);
  });
});

describe('cueAt：当前字幕', () => {
  const { cues } = sampleProject().subtitles;

  it('按 [start, end) 命中', () => {
    expect(cueAt(cues, 0)?.id).toBe('c1');
    expect(cueAt(cues, 3)).toBeNull();
    expect(cueAt(cues, 5.5)?.id).toBe('c3');
    expect(cueAt(cues, 6)).toBeNull();
  });

  it('重叠时取开始得最晚的', () => {
    expect(cueAt(cues, 1.7)?.id).toBe('c2');
  });
});

describe('formatTime', () => {
  it('m:ss.s / h:mm:ss.s', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(65.26)).toBe('1:05.2');
    expect(formatTime(3725)).toBe('1:02:05.0');
  });
});

