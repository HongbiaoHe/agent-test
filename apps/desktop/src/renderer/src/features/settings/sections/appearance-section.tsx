/**
 * 设置 → 外观：主题跟随系统 / 浅色 / 深色。main 把它设到 nativeTheme.themeSource，
 * 页面的 prefers-color-scheme 随之变化，<html>.dark 由 useSystemTheme 照常挂摘（同 Web 的 .dark 机制）。
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePreference } from '../../../../../shared/desktop';
import { cn } from '@/lib/utils';
import { useSettings } from './use-settings';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun; hint: string }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor, hint: '随 macOS 的外观自动切换' },
  { value: 'light', label: '浅色', icon: Sun, hint: '始终使用浅色' },
  { value: 'dark', label: '深色', icon: Moon, hint: '始终使用深色' },
];

export function AppearanceSection() {
  const { settings, update } = useSettings();
  const current = settings.data?.theme ?? 'system';
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">主题</h3>
      <div role="radiogroup" aria-label="主题" className="grid grid-cols-3 gap-3">
        {OPTIONS.map(({ value, label, icon: Icon, hint }) => {
          const active = value === current;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => update.mutate({ theme: value })}
              className={cn(
                'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                active ? 'border-primary bg-accent' : 'border-border hover:bg-accent/60',
              )}
            >
              <Icon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
