/**
 * 栏的拖拽把手（左侧会话栏的右缘、对话右侧侧栏的左缘共用）：按下后捕获指针，移动时把指针 x 交给 onResize
 * （由调用方换算成宽度：左栏 x 即宽度，右栏是右缘减 x），松手 onResizeEnd。
 * 捕获指针后拖出把手、拖进主区也持续生效；按下时 preventDefault 防止拖动途中选中文字。
 */
import { type PointerEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function SidebarResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeEnd,
  onResizeStart,
  edge = 'right',
  label,
}: {
  width: number;
  min: number;
  max: number;
  /** 指针的 clientX（调用方换算成宽度） */
  onResize: (clientX: number) => void;
  onResizeEnd: () => void;
  /** 按下开始拖时（如让旁边的 iframe 暂时不吃指针事件：跨源 iframe 会截走移进去的指针，拖不动） */
  onResizeStart?: () => void;
  /** 把手骑在栏的哪条边上：左侧会话栏是右缘（默认），对话右侧侧栏是左缘 */
  edge?: 'left' | 'right';
  /** 无障碍名称；默认是左侧会话栏的 */
  label?: string;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onResizeStart?.();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onResize(e.clientX);
  };
  const stop = () => {
    if (!dragging) return;
    setDragging(false);
    onResizeEnd();
  };

  return (
    // app-no-drag：把手顶端落在侧栏顶部的窗口拖动区里，不加的话那一段按下去会变成拖窗口。
    // 热区 8px 骑在侧栏右边框上（-right-1），z-10 盖过右侧主区；悬停 / 拖动时显出一条 ring 色细线
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t('shell.sidebar.resize')}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={dragging || undefined}
      className={cn(
        'app-no-drag absolute inset-y-0 z-10 w-2 cursor-col-resize',
        edge === 'right' ? '-right-1' : '-left-1',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors',
        'hover:after:bg-ring/60 data-dragging:after:bg-ring/60',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onLostPointerCapture={stop}
    />
  );
}
