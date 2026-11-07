/**
 * 时间映射（纯函数，单测见 timeline.test.ts）：成片时间 t → 当前视频轨片段与素材内时间、
 * 正在播放的音频与各自的素材时间 / 带淡入淡出的音量、当前字幕。预览播放器每帧按这些结果同步媒体元素。
 */
import {
  type AudioClip,
  type LaidOutClip,
  layoutVideoTrack,
  type SubtitleCue,
  type VideoProject,
} from '@agent-test/video-schema';

export interface VideoFrame {
  laid: LaidOutClip;
  /** 素材内时间（秒）：视频 = inPoint + (t - start)；图片 = 片段内已显示的秒数 */
  sourceTime: number;
}

/**
 * t 处的视频轨片段。区间按 [start, end) 判定；t 落在成片末尾及之后时停在最后一段的末帧，
 * 这样播放到头 / 拖到最右时画面不会变黑。视频轨为空返回 null。
 */
export function videoFrameAt(project: Pick<VideoProject, 'video'>, t: number): VideoFrame | null {
  const laid = layoutVideoTrack(project);
  if (laid.length === 0) return null;
  const time = Math.max(0, t);
  const hit = laid.find((l) => time >= l.start && time < l.end) ?? laid[laid.length - 1];
  const local = Math.min(Math.max(0, time - hit.start), hit.end - hit.start);
  const sourceTime = hit.clip.type === 'video' ? hit.clip.inPoint + local : local;
  return { laid: hit, sourceTime };
}

/** 一段音频在成片里占的时长 */
export function audioSpan(clip: Pick<AudioClip, 'inPoint' | 'outPoint'>): number {
  return clip.outPoint - clip.inPoint;
}

/**
 * 淡入淡出系数（0～1）：local 为片段内时间。淡入段线性 0→1，淡出段线性 1→0，两者重叠时取小。
 */
export function fadeFactor(clip: Pick<AudioClip, 'inPoint' | 'outPoint' | 'fadeIn' | 'fadeOut'>, local: number): number {
  const span = audioSpan(clip);
  let f = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) f = Math.min(f, local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > span - clip.fadeOut) f = Math.min(f, (span - local) / clip.fadeOut);
  return Math.min(1, Math.max(0, f));
}

export interface AudioVoice {
  clip: AudioClip;
  /** 素材内时间 = inPoint + (t - start) */
  sourceTime: number;
  /** 实际增益 = volume × 淡入淡出系数（0～2，播放器写进 <audio>.volume 时再夹到 1） */
  gain: number;
}

/** t 时刻正在发声的音频（区间 [start, start + 时长)），按工程里的顺序 */
export function audioVoicesAt(project: Pick<VideoProject, 'audio'>, t: number): AudioVoice[] {
  const out: AudioVoice[] = [];
  for (const clip of project.audio) {
    const local = t - clip.start;
    if (local < 0 || local >= audioSpan(clip)) continue;
    out.push({ clip, sourceTime: clip.inPoint + local, gain: clip.volume * fadeFactor(clip, local) });
  }
  return out;
}

/** t 处显示的字幕（[start, end)）；重叠时取开始得最晚的那条（后出现的盖住先出现的） */
export function cueAt(cues: readonly SubtitleCue[], t: number): SubtitleCue | null {
  let hit: SubtitleCue | null = null;
  for (const cue of cues) {
    if (t >= cue.start && t < cue.end && (!hit || cue.start >= hit.start)) hit = cue;
  }
  return hit;
}

/** 时长显示：m:ss.s（超过一小时显示 h:mm:ss.s） */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const tenths = Math.floor(s * 10 + 1e-6);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const sec = (tenths % 600) / 10;
  const ss = sec.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
