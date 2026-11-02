import { decryptJson, encryptJson } from './mcp-crypto';
import { modelToolName, slugify, uniqueSlug } from './mcp-naming';
import { resultToModelText, toToolSnapshot } from './mcp-result';
import {
  buildCsp,
  isSandboxHost,
  parseCspParam,
  sandboxOrigin,
} from './mcp-sandbox';
import { effectivePermission } from './mcp-types';

describe('mcp-crypto', () => {
  const prev = process.env.MCP_TOKEN_ENC_KEY;
  beforeEach(() => {
    process.env.MCP_TOKEN_ENC_KEY = 'test-key';
  });
  afterAll(() => {
    process.env.MCP_TOKEN_ENC_KEY = prev;
  });

  it('加密后能解回原值，且密文不含明文', () => {
    const tokens = { access_token: 'secret-abc', token_type: 'Bearer' };
    const enc = encryptJson(tokens);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('secret-abc');
    expect(decryptJson(enc)).toEqual(tokens);
  });

  it('换了密钥 / 密文被篡改 → undefined（按无凭据处理）', () => {
    const enc = encryptJson({ a: 1 });
    process.env.MCP_TOKEN_ENC_KEY = 'other-key';
    expect(decryptJson(enc)).toBeUndefined();
    process.env.MCP_TOKEN_ENC_KEY = 'test-key';
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(decryptJson(parts.join('.'))).toBeUndefined();
    expect(decryptJson(null)).toBeUndefined();
  });

  it('缺密钥时报清晰的错', () => {
    delete process.env.MCP_TOKEN_ENC_KEY;
    expect(() => encryptJson({})).toThrow(/MCP_TOKEN_ENC_KEY/);
  });
});

describe('mcp-naming', () => {
  it('slugify：小写、只留字母数字下划线、空退回 mcp', () => {
    expect(slugify('BuzzVideo')).toBe('buzzvideo');
    expect(slugify('dev-api.buzzvideo.ai')).toBe('dev_api_buzzvideo_ai');
    expect(slugify('知识库')).toBe('mcp');
  });

  it('uniqueSlug 递增后缀', () => {
    expect(uniqueSlug('a', new Set())).toBe('a');
    expect(uniqueSlug('a', new Set(['a', 'a_2']))).toBe('a_3');
  });

  it('工具名加前缀、非法字符替换、超长截断补 hash 且 ≤64', () => {
    expect(modelToolName('buzzvideo', 'generate_image')).toBe(
      'buzzvideo__generate_image',
    );
    expect(modelToolName('s', 'a.b-c')).toBe('s__a_b_c');
    const long = 'x'.repeat(100);
    const name = modelToolName('srv', long);
    expect(name.length).toBe(64);
    expect(name).not.toBe(modelToolName('srv', `${long}y`));
  });
});

describe('mcp-result', () => {
  it('文本原样、图片换占位、资源只给元信息', () => {
    const text = resultToModelText({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'A'.repeat(4096), mimeType: 'image/png' },
        {
          type: 'resource_link',
          uri: 'https://x/y.mp4',
          name: 'y',
          mimeType: 'video/mp4',
        },
      ],
    });
    expect(text).toBe(
      'hello\n\n[image: image/png, 3KB]\n\n[resource: https://x/y.mp4 name=y mimeType=video/mp4]',
    );
  });

  it('content 空时用 structuredContent 兜底；超长截断', () => {
    expect(
      resultToModelText({ content: [], structuredContent: { taskId: 't1' } }),
    ).toBe('{"taskId":"t1"}');
    const long = resultToModelText({
      content: [{ type: 'text', text: 'a'.repeat(25_000) }],
    });
    expect(long).toContain('[truncated 5000 chars]');
  });

  it('快照：新旧两种 UI 元数据写法都认，visibility 缺省为 model+app', () => {
    const base = { name: 't', inputSchema: { type: 'object' as const } };
    expect(
      toToolSnapshot({
        ...base,
        _meta: { ui: { resourceUri: 'ui://a/new.html' } },
      }).uiResourceUri,
    ).toBe('ui://a/new.html');
    expect(
      toToolSnapshot({
        ...base,
        _meta: { 'ui/resourceUri': 'ui://a/old.html' },
      }).uiResourceUri,
    ).toBe('ui://a/old.html');
    const appOnly = toToolSnapshot({
      ...base,
      _meta: { ui: { visibility: ['app'] } },
      annotations: { readOnlyHint: true },
    });
    expect(appOnly.visibility).toEqual(['app']);
    expect(appOnly.readOnly).toBe(true);
    expect(toToolSnapshot(base).visibility).toEqual(['model', 'app']);
  });

  it('默认权限：只读允许、其余需审批，用户覆盖优先', () => {
    expect(effectivePermission({ name: 'a', readOnly: true }, {})).toBe(
      'allow',
    );
    expect(effectivePermission({ name: 'a', readOnly: false }, null)).toBe(
      'ask',
    );
    expect(
      effectivePermission({ name: 'a', readOnly: true }, { a: 'deny' }),
    ).toBe('deny');
  });
});

describe('mcp-sandbox', () => {
  const base = new URL('http://localhost:3101');

  it('每个 server 一个稳定的子域名源，且能被识别', () => {
    const o = sandboxOrigin('server-1', base);
    expect(o).toMatch(/^http:\/\/m-[a-f0-9]{16}\.localhost:3101$/);
    expect(sandboxOrigin('server-1', base)).toBe(o);
    expect(sandboxOrigin('server-2', base)).not.toBe(o);
    expect(isSandboxHost(new URL(o).host, base)).toBe(true);
  });

  it('拒绝伪造主机：基域名 / 端口不符、label 不合法、预览主机', () => {
    expect(isSandboxHost('m-0123456789abcdef.evil.com', base)).toBe(false);
    expect(isSandboxHost('m-0123456789abcdef.localhost:3100', base)).toBe(
      false,
    );
    expect(isSandboxHost('m-xyz.localhost:3101', base)).toBe(false);
    expect(isSandboxHost(`p-${'a'.repeat(32)}.localhost:3101`, base)).toBe(
      false,
    );
    expect(isSandboxHost('localhost:3101', base)).toBe(false);
  });

  it('CSP 按声明放行来源；未声明时最严；拒掉注入的关键字与分号', () => {
    const csp = buildCsp({
      resourceDomains: ['https://asset.buzzvideo.ai', "'unsafe-hashes'"],
      connectDomains: ['https://storage.googleapis.com; script-src *'],
    });
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://asset.buzzvideo.ai",
    );
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-hashes');
    expect(csp).not.toContain('script-src *');
    expect(buildCsp(undefined)).toContain("img-src 'self' data: blob:;");
  });

  it('?csp= 是 base64url JSON，坏值按未声明处理', () => {
    const raw = Buffer.from(
      JSON.stringify({ connectDomains: ['https://a.dev'] }),
    ).toString('base64url');
    expect(parseCspParam(raw)).toEqual({ connectDomains: ['https://a.dev'] });
    expect(parseCspParam('%%%')).toBeUndefined();
    expect(parseCspParam(null)).toBeUndefined();
  });
});
