import { afterEach, describe, expect, it } from 'vitest';
import { setHostLocale } from './i18n';
import { McpError, validateMcpUrl } from './mcp/mcp-store';
import { parseSkillSource } from './skills/github-install';

afterEach(() => setHostLocale('zh-CN'));

describe('agent-host 报错跟随界面语言', () => {
  it('默认简体中文；切到 en / zh-Hant 后新抛的报错用对应语言', () => {
    expect(() => validateMcpUrl('ftp://example.com')).toThrow('连接器地址必须是 https（本机地址可以用 http）');

    setHostLocale('en');
    expect(() => validateMcpUrl('ftp://example.com')).toThrow(McpError);
    expect(() => validateMcpUrl('ftp://example.com')).toThrow(
      'The connector URL must be https (http is allowed for local addresses)',
    );
    expect(() => parseSkillSource('https://gitlab.com/a/b')).toThrow(
      'Only GitHub repositories are supported for now: gitlab.com',
    );

    setHostLocale('zh-Hant');
    expect(() => parseSkillSource('https://gitlab.com/a/b')).toThrow('目前只支援 GitHub 儲存庫：gitlab.com');
  });
});
