import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * shadcn 标准 sonner 包装（同 apps/frontend 的 sonner.tsx）：桌面端没有 next-themes，主题由调用方传入。
 */
function Toaster({ theme, ...props }: ToasterProps) {
  const style: CSSProperties & Record<`--${string}`, string> = {
    '--normal-bg': 'var(--popover)',
    '--normal-text': 'var(--popover-foreground)',
    '--normal-border': 'var(--border)',
  };
  return <Sonner theme={theme} className="toaster group" style={style} {...props} />;
}

export { Toaster };
