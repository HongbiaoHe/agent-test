import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 一行左侧的「展开 / 收起明细」开关（会话行、分类行共用）：箭头 + 这一行的标题区整块可点。
 * align：标题区是单行（center）还是标题 + 说明两行（start，箭头对齐第一行）。
 */
export function ExpandToggle({
  open,
  onToggle,
  align = 'center',
  children,
}: {
  open: boolean;
  onToggle: () => void;
  align?: 'center' | 'start';
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      aria-expanded={open}
      aria-label={open ? t('settings.storage.actions.collapse') : t('settings.storage.actions.expand')}
      onClick={onToggle}
      // 按钮默认定高、不换行、不收缩：这里是一整块标题区，要能撑高、被压缩并截断
      className={cn(
        'h-auto min-w-0 flex-1 shrink justify-start gap-2 px-1.5 py-1 text-left font-normal whitespace-normal',
        align === 'start' ? 'items-start' : 'items-center',
      )}
    >
      <ChevronRight
        className={cn('text-muted-foreground transition-transform', align === 'start' && 'mt-0.5', open && 'rotate-90')}
      />
      {children}
    </Button>
  );
}
