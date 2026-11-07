/**
 * 字幕断行：用字幕字体在 canvas 上量宽，按 video-schema 的 wrapSubtitle 断行。
 * 预览按这些行渲染，导出时同一份断行随请求传给 host 写进 ASS，两边行数与断点一致。
 * 量宽在「1em = 1」的单位下做（字号、行宽都与画布高成比例），所以结果只取决于画布宽高比，与预览窗口大小无关。
 */
import {
  SUBTITLE_FONT_FAMILY,
  subtitleLayout,
  type SubtitleStyle,
  type VideoProject,
  wrapSubtitle,
} from '@agent-test/video-schema';

const REF_SIZE = 100;
let ctx: CanvasRenderingContext2D | null = null;

/** 一段文字在 1em 字号下的宽（em） */
function measureEm(text: string): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return [...text].length;
  ctx.font = `${REF_SIZE}px "${SUBTITLE_FONT_FAMILY}"`;
  return ctx.measureText(text).width / REF_SIZE;
}

export function wrapCueText(text: string, style: SubtitleStyle, canvas: { width: number; height: number }): string[] {
  const l = subtitleLayout(style, canvas);
  return wrapSubtitle(text, l.maxLineWidth / l.fontSize, measureEm);
}

/** 导出请求用：字幕原文 → 断好行的文本（行间 \n） */
export function wrappedSubtitles(project: VideoProject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cue of project.subtitles.cues) {
    out[cue.text] ??= wrapCueText(cue.text, project.subtitles.style, project.canvas).join('\n');
  }
  return out;
}
