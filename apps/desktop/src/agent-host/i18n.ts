/**
 * agent-host 的界面语言：跟着 main 下发的 config.locale 切换。
 * 只用于会显示给用户的文案（RPC 报错进 toast、卡片状态等）；给模型看的提示词 / 工具描述不走这里。
 */
import { createI18n, type Locale } from '../shared/i18n';

export const hostI18n = createI18n('zh-CN');

export function setHostLocale(locale: Locale): void {
  if (hostI18n.language !== locale) void hostI18n.changeLanguage(locale);
}
