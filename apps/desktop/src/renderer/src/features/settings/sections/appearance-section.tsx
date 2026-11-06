/**
 * 设置 → 外观：
 * - 主题跟随系统 / 浅色 / 深色。main 把它设到 nativeTheme.themeSource，页面的 prefers-color-scheme 随之变化，
 *   <html>.dark 由 useSystemTheme 照常挂摘（同 Web 的 .dark 机制）。
 * - 界面语言跟随系统 / 指定。main 解析出实际语言，LocaleSync 跟着切换（agent-host 的报错文案也一起变）。
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThemePreference } from '../../../../../shared/desktop';
import { LANGUAGE_PREFERENCES, type LanguagePreference, LOCALE_NATIVE_NAMES } from '../../../../../shared/i18n/locales';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useSettings } from './use-settings';

const THEMES: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

function isLanguagePreference(v: unknown): v is LanguagePreference {
  return LANGUAGE_PREFERENCES.some((p) => p === v);
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const current = settings.data?.theme ?? 'system';
  const language = settings.data?.language ?? 'system';
  const languageLabel = (p: LanguagePreference) =>
    p === 'system' ? t('settings.appearance.followSystem') : LOCALE_NATIVE_NAMES[p];
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('settings.appearance.theme')}</h3>
        <div role="radiogroup" aria-label={t('settings.appearance.theme')} className="grid grid-cols-3 gap-3">
          {THEMES.map(({ value, icon: Icon }) => {
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
                <span className="text-sm font-medium">{t(`settings.appearance.themes.${value}.label`)}</span>
                <span className="text-xs text-muted-foreground">{t(`settings.appearance.themes.${value}.hint`)}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('settings.appearance.language')}</h3>
        <Select
          items={Object.fromEntries(LANGUAGE_PREFERENCES.map((p) => [p, languageLabel(p)]))}
          value={language}
          onValueChange={(v) => {
            if (isLanguagePreference(v)) update.mutate({ language: v });
          }}
        >
          <SelectTrigger className="w-56" aria-label={t('settings.appearance.language')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_PREFERENCES.map((p) => (
              <SelectItem key={p} value={p}>
                {languageLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('settings.appearance.languageHint')}</p>
      </section>
    </div>
  );
}
