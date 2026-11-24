import { cn } from '@/lib/utils';

/**
 * 占用条：整条宽度 = 这一项相对最大项的比例；深色段是数据，浅色段是可清理的缓存。
 * 只用深浅区分（设计系统不靠彩色表达层级）。
 */
export function UsageBar({
  totalBytes,
  cacheBytes,
  maxBytes,
  className,
}: {
  totalBytes: number;
  cacheBytes: number;
  maxBytes: number;
  className?: string;
}) {
  if (totalBytes <= 0 || maxBytes <= 0) return <div className={cn('h-1 rounded-full bg-muted', className)} aria-hidden />;
  const width = Math.max(2, (totalBytes / maxBytes) * 100);
  const cacheShare = (cacheBytes / totalBytes) * 100;
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-muted', className)} aria-hidden>
      <div className="flex h-full" style={{ width: `${width}%` }}>
        <div className="h-full bg-foreground/70" style={{ width: `${100 - cacheShare}%` }} />
        <div className="h-full bg-muted-foreground/40" style={{ width: `${cacheShare}%` }} />
      </div>
    </div>
  );
}
