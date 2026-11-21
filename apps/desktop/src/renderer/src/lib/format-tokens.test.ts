import { describe, expect, it } from 'vitest';
import { formatTokensCompact } from './format-tokens';

describe('formatTokensCompact', () => {
  it('按语言给约略值：英文 K / M，中文 万 / 亿；1000 以下原样', () => {
    expect(formatTokensCompact(25_944_443, 'en')).toBe('25.9M');
    expect(formatTokensCompact(48_692, 'en')).toBe('48.7K');
    expect(formatTokensCompact(512, 'en')).toBe('512');
    expect(formatTokensCompact(25_944_443, 'zh-CN')).toBe('2594.4万');
    expect(formatTokensCompact(320_000_000, 'zh-CN')).toBe('3.2亿');
    expect(formatTokensCompact(25_944_443, 'zh-Hant')).toBe('2594.4萬');
  });
});
