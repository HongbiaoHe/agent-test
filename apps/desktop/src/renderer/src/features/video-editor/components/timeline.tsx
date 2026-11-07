/**
 * 时间线：视频 / 音频 / 字幕三行，按「每秒像素」横向排布，可横向滚动与缩放。
 * - 缩放：右上角缩小 / 放大 / 滑块 / 适应宽度，或在时间线上 ⌘ / Ctrl + 滚轮（以指针处为中心）；
 *   默认「适应宽度」模式，工程变长变短时自动跟着铺满。
 * - 点或拖刻度行 / 轨道空白处：拖动播放头（scrub），并取消选中。
 * - 拖片段本体：视频轨换位，音频 / 字幕改起点；拖片段左右边：裁剪（见 lib/timeline-edit.ts）。
 *   拖动中吸附到 0、播放头与其他片段的边（按住 Alt 关闭吸附），吸附处画一条辅助线。
 *   拖拽期间只改本地草稿，松手时整体提交一次（一步撤销、一次自动保存）。
 */
import { layoutVideoTrack, projectDuration, type VideoProject } from '@agent-test/video-schema';
import { Captions, Film, Image as ImageIcon, Maximize2, Music, ZoomIn, ZoomOut } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { type PlaybackClock, useClockTime } from '../hooks/use-clock';
import { useElementSize } from '../hooks/use-element-size';
import type { Selection } from '../lib/edit';
import { audioSpan, formatTime } from '../lib/timeline';
import {
  applyDrag,
  type ClipKind,
  clampPps,
  type DragMode,
  fitPps,
  MAX_PPS,
  MIN_PPS,
  SNAP_PX,
  snapTargets,
  tickStep,
  ZOOM_STEP,
} from '../lib/timeline-edit';

/** 按下后移动超过这么多像素才算拖拽（否则只是点选） */
const DRAG_THRESHOLD_PX = 3;
/** 内容区在最晚结束处之后多留的像素（方便往后拖） */
const TAIL_PX = 120;

function timelineSpan(project: VideoProject, duration: number): number {
  const audioEnd = Math.max(0, ...project.audio.map((a) => a.start + audioSpan(a)));
  const cueEnd = Math.max(0, ...project.subtitles.cues.map((c) => c.end));
  return Math.max(duration, audioEnd, cueEnd, 1);
}

const isDragMode = (v: string | undefined): v is Exclude<DragMode, 'move'> => v === 'start' || v === 'end';

/** 滑块用对数刻度：0～100 ↔ MIN_PPS～MAX_PPS */
const ppsToSlider = (pps: number) => (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100;
const sliderToPps = (v: number) => MIN_PPS * (MAX_PPS / MIN_PPS) ** (v / 100);

interface Draft {
  project: VideoProject;
  snappedTo: number | null;
  /** 拖动期间冻结的缩放（适应宽度模式下工程变长也不重排） */
  pps: number;
  kind: ClipKind;
  id: string;
}

export function Timeline({
  project,
  duration,
  clock,
  selection,
  onSelect,
  onCommit,
}: {
  project: VideoProject;
  duration: number;
  clock: PlaybackClock;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  /** 拖拽结束时提交新工程（记一步撤销） */
  onCommit: (project: VideoProject) => void;
}) {
  const { t } = useTranslation();
  const [setViewport, viewportSize] = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** null = 适应宽度 */
  const [zoom, setZoom] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 缩放后要保持在指针下的时间点与它在视口里的横坐标 */
  const anchorRef = useRef<{ time: number; x: number } | null>(null);

  const shown = draft?.project ?? project;
  const shownDuration = draft ? projectDuration(shown) : duration;
  const span = Math.max(timelineSpan(project, duration), timelineSpan(shown, shownDuration));
  const fit = fitPps(viewportSize.width - 16, span);
  const pps = draft?.pps ?? zoom ?? fit;
  const contentWidth = Math.max(viewportSize.width, span * pps + TAIL_PX);
  const step = tickStep(pps);
  const ticks = Array.from({ length: Math.floor(contentWidth / pps / step) + 1 }, (_, i) => Math.round(i * step * 1000) / 1000);
  const px = (sec: number) => sec * pps;

  /** 以视口横坐标 x（默认视口中心）为锚点缩放 */
  const zoomTo = (next: number, x = (scrollRef.current?.clientWidth ?? 0) / 2) => {
    const el = scrollRef.current;
    if (el) anchorRef.current = { time: (el.scrollLeft + x) / pps, x };
    setZoom(clampPps(next));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    anchorRef.current = null;
    el.scrollLeft = Math.max(0, a.time * pps - a.x);
  }, [pps]);

  // ⌘ / Ctrl + 滚轮缩放（原生监听：React 的 wheel 是 passive，拦不住浏览器的整页缩放）
  const zoomRef = useRef(zoomTo);
  useEffect(() => {
    zoomRef.current = zoomTo;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const current = Number(el.dataset.pps) || 1;
      zoomRef.current(current * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** 刻度行 / 轨道空白处按下：seek 并跟随拖动（scrub），取消选中 */
  const startScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const content = e.currentTarget;
    const seekTo = (clientX: number) => {
      const x = clientX - content.getBoundingClientRect().left;
      clock.seek(Math.min(duration, Math.max(0, x / pps)));
    };
    seekTo(e.clientX);
    onSelect(null);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** 片段上按下：选中；拖动超过阈值后进入拖拽（本体 = 移动 / 换位，左右边 = 裁剪），松手提交 */
  const startClipDrag = (e: ReactPointerEvent<HTMLElement>, kind: ClipKind, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ kind, id });
    const edge = e.target instanceof HTMLElement ? e.target.dataset.edge : undefined;
    const mode: DragMode = isDragMode(edge) ? edge : 'move';
    const base = project;
    const frozenPps = pps;
    const targets = snapTargets(base, { kind, id }, clock.time());
    const originX = e.clientX;
    let moved = false;
    let last: VideoProject = base;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const r = applyDrag(base, { kind, id, mode }, dx / frozenPps, ev.altKey ? null : { targets, threshold: SNAP_PX / frozenPps });
      last = r.project;
      setDraft({ project: r.project, snappedTo: r.snappedTo, pps: frozenPps, kind, id });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', esc);
      setDraft(null);
      if (moved && last !== base) onCommit(last);
    };
    // Esc：放弃这次拖拽
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      last = base;
      up();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', esc);
  };

  const isSelected = (kind: ClipKind, id: string) => selection?.kind === kind && selection.id === id;
  const isDragging = (kind: ClipKind, id: string) => draft?.kind === kind && draft.id === id;
  const clipProps = (kind: ClipKind, id: string) => ({
    selected: isSelected(kind, id),
    dragging: isDragging(kind, id),
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => startClipDrag(e, kind, id),
    onSelect: () => onSelect({ kind, id }),
  });

  return (
    <div className="flex flex-col gap-1" data-testid="video-timeline">
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('video.timeline.zoomOut')}
          title={t('video.timeline.zoomOut')}
          disabled={pps <= MIN_PPS}
          onClick={() => zoomTo(pps / ZOOM_STEP)}
        >
          <ZoomOut />
        </Button>
        <Slider
          className="w-28"
          aria-label={t('video.timeline.zoom')}
          min={0}
          max={100}
          step={1}
          value={ppsToSlider(pps)}
          onValueChange={(v) => zoomTo(sliderToPps(v))}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('video.timeline.zoomIn')}
          title={t('video.timeline.zoomIn')}
          disabled={pps >= MAX_PPS}
          onClick={() => zoomTo(pps * ZOOM_STEP)}
        >
          <ZoomIn />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('video.timeline.zoomFit')}
          title={t('video.timeline.zoomFit')}
          aria-pressed={zoom === null}
          onClick={() => {
            // 适应宽度 = 从头完整展示：滚回最左（缩放没变时 layout effect 不会跑，这里直接设）
            anchorRef.current = { time: 0, x: 0 };
            if (scrollRef.current) scrollRef.current.scrollLeft = 0;
            setZoom(null);
          }}
        >
          <Maximize2 />
        </Button>
      </div>
      <div className="flex select-none">
        {/* 行标题 */}
        <div className="flex w-20 shrink-0 flex-col pt-5 text-xs text-muted-foreground">
          <RowLabel icon={<Film />}>{t('video.timeline.video')}</RowLabel>
          <RowLabel icon={<Music />}>{t('video.timeline.audio')}</RowLabel>
          <RowLabel icon={<Captions />}>{t('video.timeline.subtitles')}</RowLabel>
        </div>
        <div
          ref={(el) => {
            scrollRef.current = el;
            setViewport(el);
          }}
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-1"
          data-pps={pps}
          data-testid="video-timeline-scroll"
        >
          <div
            className="relative cursor-pointer"
            style={{ width: contentWidth }}
            onPointerDown={startScrub}
            data-testid="video-timeline-content"
            data-pps={pps}
          >
            {/* 刻度 */}
            <div className="relative h-5">
              {ticks.map((sec) => (
                <span
                  key={sec}
                  className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-muted-foreground tabular-nums first:translate-x-0"
                  style={{ left: px(sec) }}
                >
                  {formatTime(sec).replace(/\.0$/, '')}
                </span>
              ))}
            </div>
            {/* 成片之外（导出会截掉）的区域淡一些 */}
            <div className="pointer-events-none absolute inset-y-0 right-0 bg-muted/60" style={{ left: px(shownDuration) }} />
            <Row>
              {layoutVideoTrack(shown).map(({ clip, start, end }) => (
                <ClipBlock
                  key={clip.id}
                  left={px(start)}
                  width={px(end - start)}
                  className={
                    clip.type === 'video' ? 'border-primary/40 bg-primary/20' : 'border-dashed border-primary/40 bg-primary/10'
                  }
                  label={clip.src.split('/').pop() ?? clip.src}
                  icon={clip.type === 'video' ? <Film /> : <ImageIcon />}
                  {...clipProps('video', clip.id)}
                />
              ))}
            </Row>
            <Row>
              {shown.audio.map((clip) => (
                <ClipBlock
                  key={clip.id}
                  left={px(clip.start)}
                  width={px(audioSpan(clip))}
                  className="border-success/40 bg-success/20"
                  label={clip.src.split('/').pop() ?? clip.src}
                  icon={<Music />}
                  {...clipProps('audio', clip.id)}
                />
              ))}
            </Row>
            <Row>
              {shown.subtitles.cues.map((cue) => (
                <ClipBlock
                  key={cue.id}
                  left={px(cue.start)}
                  width={px(cue.end - cue.start)}
                  className="border-warning/50 bg-warning/20"
                  label={cue.text}
                  {...clipProps('cue', cue.id)}
                />
              ))}
            </Row>
            {draft?.snappedTo != null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary"
                style={{ left: px(draft.snappedTo) }}
                data-testid="video-snap-guide"
              />
            )}
            <Playhead clock={clock} pps={pps} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RowLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-10 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span className="truncate">{children}</span>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="relative my-1 h-8 rounded-md bg-muted/50">{children}</div>;
}

function ClipBlock({
  left,
  width,
  selected,
  dragging,
  className,
  label,
  icon,
  onPointerDown,
  onSelect,
}: {
  left: number;
  width: number;
  selected: boolean;
  dragging: boolean;
  className: string;
  label: string;
  icon?: ReactNode;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onSelect: () => void;
}) {
  const handle =
    'absolute inset-y-0 z-10 w-1.5 cursor-ew-resize bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100';
  return (
    <button
      type="button"
      title={label}
      onPointerDown={onPointerDown}
      // 键盘（Enter / 空格）选中；鼠标在 pointerdown 时已选中
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        'group absolute inset-y-0 flex min-w-1 cursor-grab items-center gap-1 overflow-hidden rounded-md border px-2 text-left text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className,
        selected && 'ring-2 ring-ring',
        dragging && 'z-20 opacity-80 shadow-md',
      )}
      style={{ left, width }}
    >
      <span data-edge="start" className={cn(handle, 'left-0 rounded-l-md', selected && 'opacity-100')} data-testid="clip-handle-start" />
      {icon}
      <span className="pointer-events-none truncate">{label}</span>
      <span data-edge="end" className={cn(handle, 'right-0 rounded-r-md', selected && 'opacity-100')} data-testid="clip-handle-end" />
    </button>
  );
}

function Playhead({ clock, pps }: { clock: PlaybackClock; pps: number }) {
  const time = useClockTime(clock);
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-foreground"
      style={{ left: time * pps }}
      data-testid="video-playhead"
    >
      <div className="absolute -top-0.5 -left-1 size-2 rounded-full bg-foreground" />
    </div>
  );
}
