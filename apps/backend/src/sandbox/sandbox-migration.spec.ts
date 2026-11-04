import {
  e2bTemplateFor,
  isSandboxSizeId,
  sizeFromSpecs,
} from '../agent/sandbox-providers/sizes';
import {
  INVENTORY_LIMIT,
  normalizeExcludes,
  packScript,
  parseListDir,
  parseRootExtras,
  parseStats,
  pullScript,
  rootExtrasScript,
  shellQuote,
  statsScript,
} from './sandbox-migration.util';

describe('沙箱档位', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('默认档沿用 E2B_TEMPLATE（没设则 base），其余档固定 spark-<档位>，可单独覆盖', () => {
    delete process.env.E2B_TEMPLATE;
    expect(e2bTemplateFor('2c2g')).toBe('base');
    process.env.E2B_TEMPLATE = 'spark-2c2g';
    expect(e2bTemplateFor('2c2g')).toBe('spark-2c2g');
    expect(e2bTemplateFor('4c8g')).toBe('spark-4c8g');
    process.env.E2B_TEMPLATE_8C8G = 'my-big';
    expect(e2bTemplateFor('8c8g')).toBe('my-big');
  });

  it('按 vCPU / 内存反推档位（改造前的沙箱没有 metadata.size）', () => {
    expect(sizeFromSpecs(2, 2048)).toBe('2c2g');
    expect(sizeFromSpecs(4, 8192)).toBe('4c8g');
    expect(sizeFromSpecs(2, 512)).toBeUndefined();
    expect(isSandboxSizeId('4c4g')).toBe(true);
    expect(isSandboxSizeId('16c32g')).toBe(false);
  });
});

describe('排除项（用户在盘点时自己选）', () => {
  it('规整：去 ./ 与尾 /、去重、扩展名小写去点；不合法整体拒绝', () => {
    expect(
      normalizeExcludes({
        paths: ['./work/reel/', 'work/reel', 'out/a b.mp4'],
        exts: ['.MP4', 'png'],
      }),
    ).toEqual({ paths: ['work/reel', 'out/a b.mp4'], exts: ['mp4', 'png'] });
    expect(normalizeExcludes(undefined)).toEqual({ paths: [], exts: [] });
    expect(normalizeExcludes({ paths: ['../etc'] })).toBeNull();
    expect(normalizeExcludes({ paths: ['/home/user'] })).toBeNull();
    expect(normalizeExcludes({ paths: ['a//b'] })).toBeNull();
    expect(normalizeExcludes({ exts: ['m p4'] })).toBeNull();
    expect(normalizeExcludes({ paths: 'work' })).toBeNull();
  });
});

describe('统计 / 打包脚本', () => {
  const ex = { paths: ["out/it's *new*.mp4", 'work/reel'], exts: ['mp4'] };

  it('统计：总是剪掉 .bg；路径按字面（glob 元字符转义、引号安全）；扩展名不区分大小写；%.0f 防溢出', () => {
    const s = statsScript(ex);
    expect(s).toContain("-path './.bg'");
    expect(s).toContain("-path './work/reel'");
    expect(s).toContain(`-path ${shellQuote("./out/it's \\*new\\*.mp4")}`);
    expect(s).toContain("-iname '*.mp4'");
    expect(s).toContain('%.0f');
    expect(s).not.toContain('%d');
  });

  it('打包：扩展名规则在前（不锚定、不区分大小写），路径规则在 --anchored 之后（字面量、区分大小写）', () => {
    const p = packScript('/home/user/agent-workspace', ex);
    const ext = p.indexOf("--exclude='*.mp4'");
    expect(p.indexOf('--ignore-case')).toBeLessThan(ext);
    expect(p.indexOf('--anchored')).toBeGreaterThan(ext);
    expect(p.indexOf('--no-wildcards')).toBeGreaterThan(ext);
    expect(p.indexOf("--exclude='./work/reel'")).toBeGreaterThan(
      p.indexOf('--anchored'),
    );
    expect(p).toContain("--exclude='./.bg'");
    expect(p).toContain('tar -cf ');
  });

  it('拉取：直链安全进 shell，pipefail，解包后按同一排除项统计', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    const s = pullScript(
      '/home/user/ws',
      'https://x.e2b.app/files?path=/tmp/a&sig=1',
      ex,
    );
    expect(s.startsWith('set -o pipefail;')).toBe(true);
    expect(s).toContain("'https://x.e2b.app/files?path=/tmp/a&sig=1'");
    expect(s).toContain("| tar -xf - -C '/home/user/ws'");
    expect(s).toContain("-path './work/reel'");
  });

  it('解析 FILES / BYTES，缺失时报错', () => {
    expect(parseStats('noise\nFILES 12\nBYTES 3456\n')).toEqual({
      files: 12,
      bytes: 3456,
    });
    expect(() => parseStats('tar: error')).toThrow('统计工作区失败');
  });
});

describe('盘点输出解析', () => {
  it('一层目录：按大小倒序，文件夹带文件数，文件计 1', () => {
    const out = [
      '##E',
      'd\twork',
      'f\ta.txt',
      'l\tlink',
      '##S',
      '2000\t./work',
      '5\t./a.txt',
      '1\t./link',
      '##C',
      '7\twork',
      '1\ta.txt',
    ].join('\n');
    expect(parseListDir(out)).toEqual({
      entries: [
        { name: 'work', type: 'dir', bytes: 2000, files: 7 },
        { name: 'a.txt', type: 'file', bytes: 5, files: 1 },
        { name: 'link', type: 'link', bytes: 1, files: 0 },
      ],
      truncated: null,
    });
  });

  it('超过上限的项汇总成 truncated', () => {
    const n = INVENTORY_LIMIT + 2;
    const names = Array.from({ length: n }, (_, i) => `f${i}`);
    const out = [
      '##E',
      ...names.map((x) => `f\t${x}`),
      '##S',
      ...names.map((x, i) => `${n - i}\t./${x}`),
    ].join('\n');
    const r = parseListDir(out);
    expect(r.entries).toHaveLength(INVENTORY_LIMIT);
    expect(r.truncated).toEqual({ count: 2, bytes: 2 + 1 });
  });

  it('按类型汇总只认带字母的扩展名（libfoo.so.6 的 6 不算）', () => {
    expect(rootExtrasScript()).toContain('e ~ /[a-z]/');
  });

  it('根目录额外信息：依赖目录、按类型汇总、总量', () => {
    const out = [
      '##D',
      '100\t./proj/node_modules',
      '900\t./node_modules',
      '##T',
      '1940\t1460\tpng',
      '335\t47\tmp4',
      '##A',
      'FILES 2888',
      'BYTES 2703348417',
    ].join('\n');
    expect(parseRootExtras(out)).toEqual({
      dependencies: [
        { path: 'node_modules', bytes: 900 },
        { path: 'proj/node_modules', bytes: 100 },
      ],
      types: [
        { ext: 'png', bytes: 1940, files: 1460 },
        { ext: 'mp4', bytes: 335, files: 47 },
      ],
      total: { files: 2888, bytes: 2703348417 },
    });
  });
});
