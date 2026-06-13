/**
 * pickPreferredSandbox 单测：多沙箱（历史裂变残留）下的确定性选择规则。
 * started 优先 > stopped > 过渡/异常态；同级取 createdAt 最早。
 *
 * sandbox.ts 模块级引入 Daytona SDK / @langchain/daytona（深 ESM 链 jest 加载失败），
 * 被测函数是纯函数不触及它们，mock 掉即可。
 */
jest.mock('@daytonaio/sdk', () => ({ Daytona: jest.fn() }));
jest.mock('@langchain/daytona', () => ({ DaytonaSandbox: class {} }));

import {
  listDir,
  pickPreferredSandbox,
  readFilePreview,
  type SandboxListing,
} from './sandbox';
import type { GuardedSandbox } from './guarded-sandbox';

const sb = (id: string, state: string, createdAt: string): SandboxListing => ({
  id,
  state,
  createdAt,
});

describe('pickPreferredSandbox', () => {
  it('空列表 → null', () => {
    expect(pickPreferredSandbox([])).toBeNull();
  });

  it('单个直接返回', () => {
    const a = sb('a', 'stopped', '2026-06-11T01:00:00Z');
    expect(pickPreferredSandbox([a])).toBe(a);
  });

  it('started 优先于 stopped，即使 stopped 创建更早', () => {
    const old = sb('old', 'stopped', '2026-06-11T01:00:00Z');
    const run = sb('run', 'started', '2026-06-11T02:00:00Z');
    expect(pickPreferredSandbox([old, run])!.id).toBe('run');
  });

  it('同为 started 取 createdAt 最早（最可能持有历史文件）', () => {
    const a = sb('a', 'started', '2026-06-11T02:00:00Z');
    const b = sb('b', 'started', '2026-06-11T01:00:00Z');
    expect(pickPreferredSandbox([a, b])!.id).toBe('b');
  });

  it('stopped 优先于 stopping/其他过渡态', () => {
    const stopping = sb('x', 'stopping', '2026-06-11T01:00:00Z');
    const stopped = sb('y', 'stopped', '2026-06-11T02:00:00Z');
    expect(pickPreferredSandbox([stopping, stopped])!.id).toBe('y');
  });

  it('不改变入参顺序（纯函数）', () => {
    const a = sb('a', 'stopped', '2026-06-11T02:00:00Z');
    const b = sb('b', 'started', '2026-06-11T01:00:00Z');
    const input = [a, b];
    pickPreferredSandbox(input);
    expect(input[0]).toBe(a);
  });
});

describe('listDir', () => {
  // ls 返回虚拟路径：目录尾随 /、前导 /（GuardedSandbox 出站脱敏后形态）
  const mkSb = (files: { path: string; is_dir?: boolean; size?: number }[]) =>
    ({
      ls: jest.fn().mockResolvedValue({ files }),
    }) as unknown as GuardedSandbox;

  it('过滤 node_modules / 隐藏 / skills，目录优先按名排序', async () => {
    const sbm = mkSb([
      { path: '/src/', is_dir: true },
      { path: '/README.md', size: 12 },
      { path: '/node_modules/', is_dir: true },
      { path: '/.git/', is_dir: true },
      { path: '/skills/', is_dir: true },
      { path: '/app/', is_dir: true },
    ]);
    const out = await listDir(sbm, '');
    expect(out.map((e) => e.name)).toEqual(['app', 'src', 'README.md']);
    expect(out[0]).toMatchObject({ name: 'app', path: 'app', isDir: true });
  });

  it('子目录项归一为相对路径（去前导/尾随斜杠）', async () => {
    const sbm = mkSb([
      { path: '/my-blog/pages/', is_dir: true },
      { path: '/my-blog/index.tsx', size: 3 },
    ]);
    const out = await listDir(sbm, 'my-blog');
    expect(out).toEqual([
      { name: 'pages', path: 'my-blog/pages', isDir: true, size: 0 },
      { name: 'index.tsx', path: 'my-blog/index.tsx', isDir: false, size: 3 },
    ]);
  });
});

describe('readFilePreview', () => {
  it('文本扩展走 read()，原样返回（带行号），未截断', async () => {
    const sbm = {
      read: jest
        .fn()
        .mockResolvedValue({ content: '     1\thello\n     2\tworld' }),
      readRaw: jest.fn(),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'a/b.ts');
    expect(out).toEqual({
      kind: 'text',
      content: '     1\thello\n     2\tworld',
      truncated: false,
    });
    expect((sbm.readRaw as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('图片扩展走 readRaw() → base64 dataUrl，不走 read()', async () => {
    const sbm = {
      read: jest.fn(),
      readRaw: jest.fn().mockResolvedValue({
        data: { content: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      }),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'pics/x.png');
    expect(out).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    });
    expect((sbm.read as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('其余扩展返回 binary 占位（带字节数）', async () => {
    const sbm = {
      read: jest.fn(),
      readRaw: jest.fn().mockResolvedValue({
        data: {
          content: new Uint8Array([0, 0, 0, 0]),
          mimeType: 'application/zip',
        },
      }),
    } as unknown as GuardedSandbox;
    const out = await readFilePreview(sbm, 'dist/app.zip');
    expect(out).toEqual({ kind: 'binary', size: 4 });
  });
});
