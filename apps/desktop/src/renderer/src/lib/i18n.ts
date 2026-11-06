/**
 * renderer 的 i18next 实例：启动时先向 main 要实际语言再渲染（不闪一下错误语言），
 * 之后设置里改了语言由 useLocaleSync 跟着切。组件里用 react-i18next 的 useTranslation；
 * 组件外（toast 文案、格式化函数）直接用这里导出的 i18n.t / currentLocale。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { i18nOptions, type Locale, LOCALES } from '../../../shared/i18n';

export async function initI18n(): Promise<void> {
  const locale = await window.desktop.getLocale();
  await i18n.use(initReactI18next).init(i18nOptions(locale));
  document.documentElement.lang = locale;
}

/** 切到指定语言；返回是否真的变了 */
export async function applyLocale(locale: Locale): Promise<boolean> {
  const changed = i18n.language !== locale;
  if (changed) await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  return changed;
}

/** 当前界面语言（日期、数字格式化用） */
export function currentLocale(): Locale {
  const lng = i18n.language;
  return LOCALES.find((l) => l === lng) ?? 'zh-CN';
}

export { i18n };
