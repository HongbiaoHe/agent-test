/** 单测用的工程样例（只被 *.test.ts 引用） */
import { emptyProject, type VideoProject } from '@agent-test/video-schema';

/** 视频轨：A 视频 [0,4)（素材 2～6 秒）→ 图片 [4,6) → B 视频 [6,9)（素材 0～3 秒）；两段音频；三条字幕 */
export function sampleProject(): VideoProject {
  return {
    ...emptyProject('demo', { width: 1080, height: 1920 }),
    video: [
      { id: 'a', type: 'video', src: 'media/a.mp4', sourceDuration: 10, inPoint: 2, outPoint: 6, volume: 1, width: 1080, height: 1920 },
      { id: 'img', type: 'image', src: 'media/logo.png', duration: 2, width: 512, height: 512 },
      { id: 'b', type: 'video', src: 'media/b.mp4', sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 0.5, width: 1920, height: 1080 },
    ],
    audio: [
      // 成片 [1, 5)，素材 10～14 秒，淡入 1 秒、淡出 2 秒，音量 0.8
      { id: 'bgm', src: 'media/bgm.mp3', sourceDuration: 60, start: 1, inPoint: 10, outPoint: 14, volume: 0.8, fadeIn: 1, fadeOut: 2 },
      // 成片 [3, 8)，不淡入淡出
      { id: 'vo', src: 'media/vo.mp3', sourceDuration: 5, start: 3, inPoint: 0, outPoint: 5, volume: 1, fadeIn: 0, fadeOut: 0 },
    ],
    subtitles: {
      style: 'bottom-outline',
      cues: [
        { id: 'c1', start: 0, end: 2, text: 'one' },
        { id: 'c2', start: 1.5, end: 3, text: 'two' },
        { id: 'c3', start: 5, end: 6, text: 'three' },
      ],
    },
  };
}
