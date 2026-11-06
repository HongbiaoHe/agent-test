/**
 * 侧栏右缘的拖拽把手：按下后捕获指针，移动时把指针 x 交给 onResize（侧栏贴窗口左缘，x 即宽度），松手 onResizeEnd。
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
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
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
      aria-label={t('shell.sidebar.resize')}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={dragging || undefined}
      className={cn(
        'app-no-drag absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize',
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
