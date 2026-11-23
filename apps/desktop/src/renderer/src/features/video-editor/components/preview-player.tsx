/**
 * 预览播放器：画布按工程宽高比适配舞台；按播放时钟逐帧（rAF）同步媒体元素，画面用 WebGL 合成。
 * - 视频轨：两个槽交替（第 i 段在 i % 2 号槽），每个槽有一个 <video> 和一个 <img>；下一段预先在另一槽载入并停在入点，
 *   切换时不黑屏。媒体元素只负责解码（不可见），画面由 lib/transition-gl.ts 合成到 <canvas>：
 *   平时画当前一段；落在转场重叠区里时两槽同时播放，按与导出相同的 xfade 公式合成；
 *   尺寸不同的素材等比缩放补黑边（与导出一致）。媒体元素带 crossorigin，spark-preview:// 回 CORS 头才能作为纹理；
 * - 原声：转场期间前一段音量 × P、后一段 × (1 - P)（同导出的 acrossfade 线性交叉）；
 * - 音频轨：每段一个 <audio>，播放区间内对齐 currentTime，音量 = volume × 淡入淡出（<audio> 上限 1）；
 * - 字幕：DOM 叠加，尺寸 / 字体 / 断行与导出共用（video-schema 的 subtitleLayout + lib/subtitle-wrap.ts），按断好的行渲染、不让浏览器自己折行。
 * 画布里的黑底 / 白字是成片画面本身的颜色（与导出一致），不随亮暗主题变，故不用语义 token。
 */
import type { LaidOutClip, SubtitleStyle, VideoProject } from '@agent-test/video-schema';
import {
  layoutVideoTrack,
  SUBTITLE_FONT_FAMILY,
  SUBTITLE_FONT_HEIGHT_EM,
  subtitleLayout,
} from '@agent-test/video-schema';
import { Film } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type PlaybackClock, useClockSelect } from '../hooks/use-clock';
import { useElementSize } from '../hooks/use-element-size';
import { mediaUrl } from '../lib/media-url';
import { wrapCueText } from '../lib/subtitle-wrap';
import { audioVoicesAt, cueAt, videoLayersAt } from '../lib/timeline';
import { type CompositeFrame, type FrameSource, TransitionCompositor } from '../lib/transition-gl';

/** 播放中允许的漂移（秒）：超过才 seek，避免每帧 seek 卡顿；暂停时要精确到帧 */
const DRIFT_PLAYING = 0.3;
const DRIFT_PAUSED = 0.04;

const pause = (el: HTMLMediaElement | null) => {
  if (el && !el.paused) el.pause();
};
const play = (el: HTMLMediaElement) => {
  if (el.paused) void el.play().catch(() => undefined);
};
/** 对齐到目标时间；还没拿到元数据时也可以设（作为起播位置） */
const align = (el: HTMLMediaElement, target: number, tolerance: number) => {
  if (Math.abs(el.currentTime - target) > tolerance) el.currentTime = target;
};

type Slot = 0 | 1;
const slotOf = (laid: LaidOutClip): Slot => (laid.index % 2 === 0 ? 0 : 1);

export function PreviewPlayer({
  project,
  origin,
  clock,
}: {
  project: VideoProject;
  /** 工作区的 spark-preview:// 源；还没拿到时不载入媒体 */
  origin: string | null;
  clock: PlaybackClock;
}) {
  const { t } = useTranslation();
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const videos = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const images = useRef<[HTMLImageElement | null, HTMLImageElement | null]>([null, null]);
  /** 每个槽当前载入的素材（clip id + src），换了才重设 src */
  const slotKeys = useRef<[string | null, string | null]>([null, null]);
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 这一刻要合成的画面（sync 写、绘制循环读） */
  const frame = useRef<CompositeFrame>({ a: null, b: null, transition: null, progress: 1 });

  // 每帧同步：时钟变化（播放推进 / seek / 播放暂停）或工程变化时跑一次
  useEffect(() => {
    if (!origin) return;
    const url = (src: string) => mediaUrl(origin, src);
    const loadVideo = (slot: Slot, clipId: string, src: string) => {
      const el = videos.current[slot];
      const key = `${clipId}|${src}`;
      if (!el || slotKeys.current[slot] === key) return el;
      slotKeys.current[slot] = key;
      el.src = url(src);
      return el;
    };
    const loadImage = (slot: Slot, src: string) => {
      const img = images.current[slot];
      const u = url(src);
      if (img && img.dataset.src !== u) {
        img.dataset.src = u;
        img.src = u;
      }
      return img;
    };

    const sync = () => {
      const t = clock.time();
      const playing = clock.playing();
      const tolerance = playing ? DRIFT_PLAYING : DRIFT_PAUSED;
      const layers = videoLayersAt(project, t);
      const used = new Set<Slot>();

      /** 让一层在它的槽里就位，返回要合成的画面源；gain 是转场交叉时原声的系数 */
      const show = (laid: LaidOutClip, sourceTime: number, gain: number): FrameSource | null => {
        const slot = slotOf(laid);
        used.add(slot);
        const clip = laid.clip;
        if (clip.type === 'video') {
          const el = loadVideo(slot, clip.id, clip.src);
          if (!el) return null;
          align(el, sourceTime, tolerance);
          el.volume = Math.min(1, Math.max(0, clip.volume * gain));
          el.muted = clip.volume === 0;
          if (playing && t < laid.end) play(el);
          else pause(el);
          return el;
        }
        pause(videos.current[slot]);
        return loadImage(slot, clip.src);
      };

      if (!layers) {
        for (const el of videos.current) pause(el);
        frame.current = { a: null, b: null, transition: null, progress: 1 };
      } else {
        const { a, b, progress } = layers;
        const srcA = show(a.laid, a.sourceTime, b ? progress : 1);
        const srcB = b ? show(b.laid, b.sourceTime, 1 - progress) : null;
        frame.current = { a: srcA, b: srcB, transition: layers.transition, progress };

        // 空着的槽：预载下一段视频并停在入点
        const next = layoutVideoTrack(project)[(b ?? a).laid.index + 1];
        for (const slot of [0, 1] as const) {
          if (used.has(slot)) continue;
          pause(videos.current[slot]);
          if (next && slotOf(next) === slot && next.clip.type === 'video') {
            const el = loadVideo(slot, next.clip.id, next.clip.src);
            if (el) align(el, next.clip.inPoint, DRIFT_PAUSED);
          }
        }
      }

      const voices = new Map(audioVoicesAt(project, t).map((v) => [v.clip.id, v]));
      for (const clip of project.audio) {
        const el = audios.current.get(clip.id);
        if (!el) continue;
        const v = voices.get(clip.id);
        if (v) {
          align(el, v.sourceTime, tolerance);
          el.volume = Math.min(1, Math.max(0, v.gain));
          if (playing) play(el);
          else pause(el);
        } else {
          pause(el);
          // 还没轮到：停在入点等着
          if (t < clip.start) align(el, clip.inPoint, DRIFT_PAUSED);
        }
      }
    };

    sync();
    return clock.subscribe(sync);
  }, [clock, project, origin]);

  // 合成循环：每个动画帧把当前画面画到画布上（暂停时 seek 完成的新帧也能及时出现）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let compositor: TransitionCompositor;
    try {
      compositor = new TransitionCompositor(canvas);
    } catch (e) {
      console.error('preview compositor init failed', e);
      return;
    }
    let raf = 0;
    const loop = () => {
      compositor.draw(frame.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 卸载时停掉所有媒体（离开剪辑器不留声音）
  useEffect(() => {
    const videoEls = videos.current;
    const audioEls = audios.current;
    return () => {
      for (const el of videoEls) pause(el);
      for (const el of audioEls.values()) pause(el);
    };
  }, []);

  const aspect = project.canvas.width / project.canvas.height;
  const fitWidth = Math.min(stage.width, stage.height * aspect);
  const fitHeight = fitWidth / aspect;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  return (
    <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center">
      <div
        data-testid="video-canvas"
        className="relative overflow-hidden rounded-md bg-black shadow-sm"
        style={{ width: fitWidth, height: fitHeight }}
      >
        {[0, 1].map((slot) => (
          <video
            key={slot}
            ref={(el) => {
              videos.current[slot === 0 ? 0 : 1] = el;
            }}
            className="invisible absolute inset-0 size-full object-contain"
            crossOrigin="anonymous"
            playsInline
            preload="auto"
          />
        ))}
        {[0, 1].map((slot) => (
          <img
            key={slot}
            ref={(el) => {
              images.current[slot === 0 ? 0 : 1] = el;
            }}
            alt=""
            crossOrigin="anonymous"
            className="invisible absolute inset-0 size-full object-contain"
          />
        ))}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full"
          width={Math.max(1, Math.round(fitWidth * dpr))}
          height={Math.max(1, Math.round(fitHeight * dpr))}
          data-testid="video-gl"
        />
        {origin &&
          project.audio.map((clip) => (
            <audio
              key={clip.id}
              ref={(el) => {
                if (el) audios.current.set(clip.id, el);
                else audios.current.delete(clip.id);
              }}
              src={mediaUrl(origin, clip.src)}
              preload="auto"
            />
          ))}
        {project.video.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/70">
            <Film className="size-5" />
            {t('video.player.empty')}
          </div>
        )}
        <SubtitleOverlay project={project} clock={clock} canvasHeight={fitHeight} />
      </div>
    </div>
  );
}

function SubtitleOverlay({
  project,
  clock,
  canvasHeight,
}: {
  project: VideoProject;
  clock: PlaybackClock;
  canvasHeight: number;
}) {
  const { cues, style } = project.subtitles;
  // 只在当前字幕换了时重渲染，不随每帧
  const cueId = useClockSelect(clock, (t) => cueAt(cues, t)?.id ?? null);
  const cue = cueId ? cues.find((c) => c.id === cueId) : undefined;
  if (!cue || canvasHeight <= 0) return null;
  return <SubtitleText text={cue.text} style={style} canvas={project.canvas} canvasHeight={canvasHeight} />;
}

function SubtitleText({
  text,
  style,
  canvas,
  canvasHeight,
}: {
  text: string;
  style: SubtitleStyle;
  /** 工程画布（断行只看宽高比） */
  canvas: { width: number; height: number };
  canvasHeight: number;
}) {
  const l = subtitleLayout(style, { width: (canvasHeight * canvas.width) / canvas.height, height: canvasHeight });
  const lines = wrapCueText(text, style, canvas);
  return (
    <div
      data-testid="video-subtitle"
      data-lines={lines.length}
      className="pointer-events-none absolute inset-x-0 text-center font-normal whitespace-pre text-white"
      style={{
        [l.position]: l.margin,
        paddingInline: l.margin,
        fontSize: l.fontSize,
        fontFamily: `"${SUBTITLE_FONT_FAMILY}"`,
        lineHeight: SUBTITLE_FONT_HEIGHT_EM,
      }}
    >
      {/* span 保持行内（外层不能是 flex，否则被块化）：底框按行各画一块、内边距不挤动文字，与 libass 的 BorderStyle 3 一致 */}
      <span
        className={l.box ? 'bg-black/50' : undefined}
        style={
          l.box
            ? { padding: l.boxPadding, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
            : { WebkitTextStroke: `${l.outline * 2}px black`, paintOrder: 'stroke fill' }
        }
      >
        {lines.join('\n')}
      </span>
    </div>
  );
}
