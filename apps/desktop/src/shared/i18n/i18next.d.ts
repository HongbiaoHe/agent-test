import 'i18next';
import type { zhCN } from './zh-CN';

// t('chat.xxx') 的键与插值参数按简体中文字典做类型检查
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof zhCN };
    returnNull: false;
  }
}
