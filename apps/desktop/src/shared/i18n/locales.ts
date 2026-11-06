/**
 * 界面语言：设置里选「跟随系统」或指定一种；跟随系统时按系统首选语言列表匹配支持的语言。
 * main 解析出实际语言（resolveLocale），renderer 与 agent-host 都用 main 给的结果，三处一致。
 */

export const LOCALES = ['zh-CN', 'zh-Hant', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LANGUAGE_PREFERENCES = ['system', ...LOCALES] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

/** 系统语言一个都不支持时用英文 */
export const FALLBACK_LOCALE: Locale = 'en';

/** 语言选项显示自己的名字（不随界面语言翻译，切错了也认得出） */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
};

/** 单个 BCP 47 标签 → 支持的语言；繁体按脚本 Hant 或地区 TW / HK / MO 认 */
function matchLocale(tag: string): Locale | null {
  const parts = tag.toLowerCase().replaceAll('_', '-').split('-');
  if (parts[0] === 'zh') {
    return parts.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-Hant' : 'zh-CN';
  }
  if (parts[0] === 'en') return 'en';
  return null;
}

export function resolveLocale(preference: LanguagePreference, systemLanguages: readonly string[]): Locale {
  if (preference !== 'system') return preference;
  for (const tag of systemLanguages) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return FALLBACK_LOCALE;
}
