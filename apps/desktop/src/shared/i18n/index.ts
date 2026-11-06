/**
 * 三个进程共用的 i18next 配置：字典是 TS 对象（简体中文为源，其他语言按 MessageShape 对齐键），
 * 打包进各进程，不需要运行时加载 JSON。main / agent-host 用 createI18n 建自己的实例，
 * renderer 在此基础上接 react-i18next（见 renderer/src/lib/i18n.ts）。
 */
import { createInstance, type i18n as I18n, type InitOptions } from 'i18next';
import { en } from './en';
import { type Locale, LOCALES } from './locales';
import { zhCN } from './zh-CN';
import { zhHant } from './zh-Hant';

export * from './locales';

export const resources = {
  'zh-CN': { translation: zhCN },
  'zh-Hant': { translation: zhHant },
  en: { translation: en },
} satisfies Record<Locale, { translation: object }>;

export function i18nOptions(locale: Locale): InitOptions {
  return {
    lng: locale,
    supportedLngs: [...LOCALES],
    fallbackLng: 'zh-CN',
    // 'zh-Hant' 这类标签不要再退到 'zh' 去找（没有这份字典）
    load: 'currentOnly',
    resources,
    // React 自己会转义；main / agent-host 的文案进的是纯文本（报错、toast），也不需要 HTML 转义
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  };
}

/** main / agent-host 用：同步初始化好的独立实例 */
export function createI18n(locale: Locale): I18n {
  const instance = createInstance();
  void instance.init(i18nOptions(locale));
  return instance;
}
