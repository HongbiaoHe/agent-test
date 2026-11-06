/**
 * main 进程的界面语言：设置里的偏好 + 系统首选语言 → 实际语言。
 * renderer 经 desktop:getLocale 取、agent-host 经 config 消息拿，main 自己的报错文案用 mainI18n。
 */
import { app } from 'electron';
import { createI18n, type Locale, resolveLocale } from '../shared/i18n';
import type { DesktopStore } from './store';

export const mainI18n = createI18n('zh-CN');

/** e2e 用 SPARK_SYSTEM_LANGUAGE 固定「系统语言」，不受跑测试的机器影响 */
function systemLanguages(): string[] {
  const forced = process.env.SPARK_SYSTEM_LANGUAGE;
  return forced ? [forced] : app.getPreferredSystemLanguages();
}

export function appLocale(store: DesktopStore): Locale {
  return resolveLocale(store.getSettings().language, systemLanguages());
}

/** 启动与改设置后调用，让 main 自己的文案跟上 */
export function syncMainLocale(store: DesktopStore): Locale {
  const locale = appLocale(store);
  if (mainI18n.language !== locale) void mainI18n.changeLanguage(locale);
  return locale;
}
