import { describe, expect, it } from 'vitest';
import { parseVideoProjectResult } from './tool-result';

describe('create_video_project 工具结果', () => {
  it('JSON 字符串 → 卡片信息，各轨数量兼容数字或数组', () => {
    const info = parseVideoProjectResult(
      JSON.stringify({ path: 'videos/a.sparkvideo.json', name: 'a', duration: 12.5, videoClips: 3, audioClips: [{}], subtitles: 0, warnings: ['w'] }),
    );
    expect(info).toEqual({ path: 'videos/a.sparkvideo.json', name: 'a', duration: 12.5, videoClips: 3, audioClips: 1, subtitles: 0, warnings: ['w'] });
  });

  it('报错文本 / 缺字段 / 不是工程文件：null', () => {
    expect(parseVideoProjectResult('Error: something')).toBeNull();
    expect(parseVideoProjectResult({ error: 'x' })).toBeNull();
    expect(parseVideoProjectResult({ path: 'a.json', name: 'a', duration: 1, videoClips: 0, audioClips: 0, subtitles: 0, warnings: [] })).toBeNull();
  });
});
