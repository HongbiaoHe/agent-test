/**
 * 转场选择面板（时间线上选中某个接缝时，检查器里显示）：按分组列出 46 种内置转场与工程里已有的自定义转场，
 * 每格是用真实着色器合成的缩略图（悬停时播放一遍），点一下就换；可调时长、移除、应用到全部接缝；
 * 当前是自定义转场时可直接改表达式（实时校验，合法才写回）。
 */
import {
  DEFAULT_TRANSITION_SECONDS,
  layoutVideoTrack,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  type Transition,
  TRANSITION_GROUPS,
  type TransitionGroup,
  validateExpr,
  type VideoProject,
} from '@agent-test/video-schema';
import { CopyCheck, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { applyTransitionToAll, customTransitionsOf, fileName, setTransition } from '../lib/transition-edit';
import { drawTransitionThumb } from '../lib/transition-thumbs';
import { Field, NumberField } from './fields';

type Edit = (project: VideoProject, key?: string) => void;

const GROUPS: readonly TransitionGroup[] = ['fade', 'wipe', 'slide', 'shape', 'effect'];

const THUMB_W = 72;
const THUMB_H = 40;
/** 悬停预览一遍的时长（毫秒） */
const PLAY_MS = 1200;
/** 静止缩略图的进度：不取正中 0.5（圆形 / 矩形裁切在 0.5 时整屏是黑的，看不出效果） */
const STILL_PROGRESS = 0.35;

const sameTransition = (a: Transition | undefined, b: Transition) =>
  !!a && a.type === b.type && (a.type !== 'custom' || a.expr === b.expr);

export function TransitionPicker({ project, clipId, edit }: { project: VideoProject; clipId: string; edit: Edit }) {
  const { t } = useTranslation();
  const laid = layoutVideoTrack(project);
  const from = laid.find((l) => l.clip.id === clipId);
  const to = from ? laid[from.index + 1] : undefined;
  if (!from || !to) return null;
  const current = from.clip.transition;
  const duration = current?.duration ?? DEFAULT_TRANSITION_SECONDS;
  const customs = customTransitionsOf(project);
  const nameOf = (tr: Transition) =>
    tr.type === 'custom' ? (tr.name ?? t('video.transitions.customUnnamed')) : t(`video.transitions.types.${tr.type}`);
  const choose = (tr: Transition | null) => edit(setTransition(project, clipId, tr && { ...tr, duration }));

  return (
    <section className="space-y-3" data-testid="transition-picker">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{current ? t('video.transitions.edit', { name: nameOf(current) }) : t('video.transitions.title')}</h3>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {t('video.transitions.seam', { from: fileName(from.clip.src), to: fileName(to.clip.src) })}
        </p>
      </div>

      {current && (
        <>
          <NumberField
            label={t('video.transitions.duration')}
            value={current.duration}
            min={MIN_TRANSITION_SECONDS}
            max={MAX_TRANSITION_SECONDS}
            step={0.1}
            slider
            hint={
              current.duration - from.transitionOut > 0.01
                ? t('video.transitions.clamped', { value: from.transitionOut })
                : undefined
            }
            onChange={(v) => {
              const d = Math.min(MAX_TRANSITION_SECONDS, Math.max(MIN_TRANSITION_SECONDS, Math.round(v * 100) / 100));
              edit(setTransition(project, clipId, { ...current, duration: d }), `${clipId}:transition-duration`);
            }}
          />
          {current.type === 'custom' && (
            // 换了接缝 / 换了别的自定义转场才重置草稿（按表达式做 key 会在每次合法输入后重挂、丢焦点）
            <ExprField key={`${clipId}:${current.name ?? ''}`} transition={current} onChange={(tr) => choose(tr)} />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => edit(applyTransitionToAll(project, current))}>
              <CopyCheck />
              {t('video.transitions.applyAll')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => choose(null)}>
              <Trash2 />
              {t('video.transitions.remove')}
            </Button>
          </div>
        </>
      )}

      <div className="space-y-3">
        {customs.length > 0 && (
          <Group title={t('video.transitions.groups.custom')}>
            {customs.map((tr) => (
              <Tile key={tr.expr} transition={tr} label={nameOf(tr)} selected={sameTransition(current, tr)} onPick={() => choose(tr)} />
            ))}
          </Group>
        )}
        {GROUPS.map((group) => (
          <Group key={group} title={t(`video.transitions.groups.${group}`)}>
            {TRANSITION_GROUPS[group].map((type) => {
              const tr: Transition = { type, duration };
              return (
                <Tile
                  key={type}
                  transition={tr}
                  label={nameOf(tr)}
                  selected={sameTransition(current, tr)}
                  onPick={() => choose(tr)}
                />
              );
            })}
          </Group>
        ))}
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="grid grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

function Tile({
  transition,
  label,
  selected,
  onPick,
}: {
  transition: Transition;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  // 静止时画转场中途的样子；悬停时从头到尾播一遍（循环）
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    if (!hover) {
      drawTransitionThumb(el, transition, STILL_PROGRESS);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = ((now - start) % (PLAY_MS + 400)) / PLAY_MS;
      drawTransitionThumb(el, transition, 1 - Math.min(1, p));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover, transition]);

  return (
    <button
      type="button"
      onClick={onPick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      aria-pressed={selected}
      title={label}
      className={cn(
        'flex flex-col items-center gap-1 rounded-md p-1 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
        selected && 'bg-accent ring-2 ring-ring',
      )}
      data-testid="transition-tile"
    >
      <canvas
        ref={canvas}
        width={Math.round(THUMB_W * dpr)}
        height={Math.round(THUMB_H * dpr)}
        className="rounded-sm"
        style={{ width: THUMB_W, height: THUMB_H }}
      />
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

/** 自定义转场的表达式：合法才写回，不合法就地提示 */
function ExprField({ transition, onChange }: { transition: Transition; onChange: (t: Transition) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(transition.expr ?? '');
  const error = validateExpr(draft);
  return (
    <Field label={t('video.transitions.expr')}>
      <Textarea
        className="font-mono text-xs"
        value={draft}
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value);
          if (validateExpr(e.target.value) === null) onChange({ ...transition, expr: e.target.value });
        }}
      />
      <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ? t('video.transitions.exprInvalid', { message: error }) : t('video.transitions.exprHint')}
      </p>
    </Field>
  );
}
