import { describe, expect, it } from 'vitest';
import { createI18n, LOCALES, resolveLocale, resources } from './index';

describe('resolveLocale', () => {
  it('指定了语言就用指定的，不看系统', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-Hant', ['en-US'])).toBe('zh-Hant');
  });

  it('跟随系统：繁体按脚本 Hant 或地区 TW / HK / MO 认，其余中文是简体', () => {
    expect(resolveLocale('system', ['zh-Hant-TW'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['zh-HK'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['zh_TW'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['zh-MO'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveLocale('system', ['zh-SG'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB'])).toBe('en');
  });

  it('跟随系统：按首选顺序找第一个支持的；都不支持用英文', () => {
    expect(resolveLocale('system', ['ja-JP', 'zh-HK', 'en-US'])).toBe('zh-Hant');
    expect(resolveLocale('system', ['ja-JP', 'fr-FR'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });
});

/** 把嵌套字典拍平成 { 'a.b.c': '文案' } */
function flatten(obj: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (isObject(v)) for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}
const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
/** 英文多出的 xxx_one 对应中文的 xxx_other */
const sourceKey = (key: string) => key.replace(/_one$/, '_other');
/** 允许译文为空的键：中文的量词后缀在英文里没有对应（「12 次」→「12」） */
const MAY_BE_EMPTY = new Set(['agent.usage.callsSuffix']);

describe('字典', () => {
  const source = flatten(resources['zh-CN'].translation);

  it.each(LOCALES.filter((l) => l !== 'zh-CN'))('%s 的插值参数与简体中文一致、没有空文案', (locale) => {
    const target = flatten(resources[locale].translation);
    for (const [key, text] of target) {
      if (!MAY_BE_EMPTY.has(key)) expect(text.trim(), key).not.toBe('');
      const src = source.get(sourceKey(key));
      expect(src, `${key} 在简体中文里不存在`).toBeDefined();
      // _one（单数）可以不带 {{count}}，比如 "1 file" 写成 "One file"
      const want = placeholders(src ?? '').filter((p) => !(key.endsWith('_one') && p === 'count'));
      expect(placeholders(text).filter((p) => !(key.endsWith('_one') && p === 'count')), key).toEqual(want);
    }
  });

  it('切换语言后 t 立刻返回对应译文', async () => {
    const i18n = createI18n('zh-CN');
    expect(i18n.t('common.save')).toBe('保存');
    await i18n.changeLanguage('zh-Hant');
    expect(i18n.t('common.save')).toBe('儲存');
    await i18n.changeLanguage('en');
    expect(i18n.t('shell.conversation.deleteDescription', { title: 'Plan' })).toContain('“Plan”');
  });
});
