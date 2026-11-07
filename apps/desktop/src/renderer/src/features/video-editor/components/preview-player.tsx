/**
 * 预览播放器：画布按工程宽高比适配舞台；按播放时钟逐帧（rAF）同步媒体元素。
 * - 视频轨：两个 <video> 交替——当前片段在 index % 2 号槽，下一段预先在另一槽载入并停在入点，切换时不黑屏；
 *   图片片段用 <img>；尺寸不同的素材 object-contain + 黑底（与导出的等比缩放补黑边一致）；
 * - 音频轨：每段一个 <audio>，播放区间内对齐 currentTime，音量 = volume × 淡入淡出（<audio> 上限 1）；
 * - 字幕：DOM 叠加，尺寸 / 字体 / 断行与导出共用（video-schema 的 subtitleLayout + lib/subtitle-wrap.ts），按断好的行渲染、不让浏览器自己折行。
 * 画布里的黑底 / 白字是成片画面本身的颜色（与导出一致），不随亮暗主题变，故不用语义 token。
 */
import type { SubtitleStyle, VideoProject } from '@agent-test/video-schema';
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
import { audioVoicesAt, cueAt, videoFrameAt } from '../lib/timeline';

/** 播放中允许的漂移（秒）：超过才 seek，避免每帧 seek 卡顿；暂停时要精确到帧 */
const DRIFT_PLAYING = 0.3;
const DRIFT_PAUSED = 0.04;

const setVisible = (el: HTMLElement | null, visible: boolean) => {
  if (el) el.style.visibility = visible ? 'visible' : 'hidden';
};
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
  const slots = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  /** 每个槽当前载入的素材（clip id + src），换了才重设 src */
  const slotKeys = useRef<[string | null, string | null]>([null, null]);
  const imgRef = useRef<HTMLImageElement>(null);
  const audios = useRef(new Map<string, HTMLAudioElement>());

  // 每帧同步：时钟变化（播放推进 / seek / 播放暂停）或工程变化时跑一次
  useEffect(() => {
    if (!origin) return;
    const url = (src: string) => mediaUrl(origin, src);
    const loadSlot = (slot: 0 | 1, clipId: string, src: string) => {
      const el = slots.current[slot];
      const key = `${clipId}|${src}`;
      if (!el || slotKeys.current[slot] === key) return el;
      slotKeys.current[slot] = key;
      el.src = url(src);
      return el;
    };

    const sync = () => {
      const t = clock.time();
      const playing = clock.playing();
      const tolerance = playing ? DRIFT_PLAYING : DRIFT_PAUSED;
      const frame = videoFrameAt(project, t);
      const [a, b] = slots.current;

      if (!frame) {
        pause(a);
        pause(b);
        setVisible(a, false);
        setVisible(b, false);
        setVisible(imgRef.current, false);
      } else {
        const cur = frame.laid;
        const active: 0 | 1 = cur.index % 2 === 0 ? 0 : 1;
        const other: 0 | 1 = active === 0 ? 1 : 0;
        const otherEl = slots.current[other];
        const activeEl = slots.current[active];

        if (cur.clip.type === 'video') {
          const el = loadSlot(active, cur.clip.id, cur.clip.src);
          if (el) {
            align(el, frame.sourceTime, tolerance);
            el.volume = Math.min(1, cur.clip.volume);
            el.muted = cur.clip.volume === 0;
            if (playing && t < cur.end) play(el);
            else pause(el);
          }
          setVisible(el, true);
          setVisible(imgRef.current, false);
        } else {
          pause(activeEl);
          setVisible(activeEl, false);
          const img = imgRef.current;
          if (img) {
            const src = url(cur.clip.src);
            if (img.dataset.src !== src) {
              img.dataset.src = src;
              img.src = src;
            }
          }
          setVisible(img, true);
        }

        // 另一槽：预载下一段视频并停在入点
        const next = layoutVideoTrack(project)[cur.index + 1];
        pause(otherEl);
        setVisible(otherEl, false);
        if (next?.clip.type === 'video') {
          const el = loadSlot(other, next.clip.id, next.clip.src);
          if (el) align(el, next.clip.inPoint, DRIFT_PAUSED);
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

  // 卸载时停掉所有媒体（离开剪辑器不留声音）
  useEffect(() => {
    const slotEls = slots.current;
    const audioEls = audios.current;
    return () => {
      for (const el of slotEls) pause(el);
      for (const el of audioEls.values()) pause(el);
    };
  }, []);

  const aspect = project.canvas.width / project.canvas.height;
  const fitWidth = Math.min(stage.width, stage.height * aspect);
  const fitHeight = fitWidth / aspect;

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
              slots.current[slot === 0 ? 0 : 1] = el;
            }}
            className="invisible absolute inset-0 size-full object-contain"
            playsInline
            preload="auto"
          />
        ))}
        <img ref={imgRef} alt="" className="invisible absolute inset-0 size-full object-contain" />
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
