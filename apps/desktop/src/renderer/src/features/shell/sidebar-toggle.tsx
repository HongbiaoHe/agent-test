/**
 * 侧栏开关（同 Claude 桌面端）：展开时在侧栏顶部行的右端，收起时紧挨 macOS 红绿灯；点击展开 / 收起。
 * 收起时悬停它，侧栏以浮层临时弹出（见 use-sidebar-layout），开关仍留在红绿灯旁。
 */
import { PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** 收起后主区顶栏左侧要让出的宽度：红绿灯 + 开关（pl-32 = 128px） */
export const COLLAPSED_HEADER_INSET = 'pl-32 lg:pl-32';

export function SidebarToggle({
  collapsed,
  onToggle,
  onHover,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onHover: () => void;
}) {
  const { t } = useTranslation();
  const label = collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse');
  return (
    // 垂直：按钮 h-7、top-2.5 → 中线 24px，与红绿灯（main 的 trafficLightPosition）和 h-12 顶栏行对齐。
    // 水平：展开时 left-51 = 侧栏宽 240 - 右内边距 8 - 按钮宽 28；收起时 left-20 紧挨红绿灯。
    // data-peek-zone：指针在开关上时浮层不收回（见 use-sidebar-layout）
    <div
      className={cn(
        'app-no-drag absolute top-2.5 z-50 transition-[left] duration-200 motion-reduce:transition-none',
        collapsed ? 'left-20' : 'left-51',
      )}
      data-peek-zone=""
      onMouseEnter={onHover}
    >
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={!collapsed} onClick={onToggle} />}
        >
          <PanelLeft />
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
