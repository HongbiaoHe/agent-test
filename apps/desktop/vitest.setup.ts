// renderer 组件外用的是 i18next 默认实例（src/renderer/src/lib/i18n.ts）；单测里按简体中文初始化，断言照旧写中文
import i18n from 'i18next';
import { i18nOptions } from './src/shared/i18n';

await i18n.init(i18nOptions('zh-CN'));
