/**
 * 侧栏顶部的标签栏：每个打开的内容一个标签（点了切过去，× 关掉这一个），末尾的加号打开新建标签页；
 * 最右是整个侧栏的按钮（展开全部 / 收起为侧栏、关闭侧栏——关闭是全部标签一起收起，都留着）。
 */
import { Clapperboard, Globe, type LucideIcon, Network, Plus, SquarePlus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SideTab } from './types';

const TAB_ICON: Record<SideTab['kind'], LucideIcon> = {
  site: Globe,
  video: Clapperboard,
  canvas: Network,
  launcher: SquarePlus,
};

export function PanelTabs({
  tabs,
  activeId,
  titleOf,
  onActivate,
  onClose,
  onNewTab,
  controls,
  className,
}: {
  tabs: SideTab[];
  activeId: string | null;
  titleOf: (tab: SideTab) => string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /** 整个侧栏的按钮（展开 / 关闭） */
  controls: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <header className={cn('app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border px-2', className)}>
      <div
        role="tablist"
        aria-label={t('shell.sidePanel.tabs')}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const title = titleOf(tab);
          const Icon = TAB_ICON[tab.kind];
          return (
            <div
              key={tab.id}
              data-testid="side-tab"
              data-active={active}
              className={cn(
                'group/tab flex h-8 max-w-48 min-w-0 shrink items-center rounded-lg border pr-0.5 transition-colors',
                active
                  ? 'border-border bg-accent text-accent-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Button
                variant="ghost"
                role="tab"
                aria-selected={active}
                title={title}
                onClick={() => onActivate(tab.id)}
                // 底色由外层的标签块给：按钮自己不再变色
                className="h-full min-w-0 flex-1 shrink justify-start gap-1.5 px-2 font-normal hover:bg-transparent dark:hover:bg-transparent"
              >
                <Icon />
                <span className="truncate">{title}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('shell.sidePanel.closeTab', { title })}
                title={t('shell.sidePanel.closeTab', { title })}
                onClick={() => onClose(tab.id)}
                // 当前标签一直显示 ×；其它标签悬停或键盘聚焦时才出现
                className={cn('shrink-0', !active && 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100')}
              >
                <X />
              </Button>
            </div>
          );
        })}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('shell.sidePanel.newTab')}
          title={t('shell.sidePanel.newTab')}
          onClick={onNewTab}
          className="shrink-0"
        >
          <Plus />
        </Button>
      </div>
      {controls}
    </header>
  );
}
