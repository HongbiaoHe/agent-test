import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalWorkspaceSandbox } from './local-sandbox';

let ws: string;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-local-sandbox-'));
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('LocalWorkspaceSandbox.beforeWrite', () => {
  it('write / edit 落盘前先调用钩子（剪辑工程快照靠它），钩子看到的是写入前的内容', async () => {
    const seen: Array<{ path: string; before: string | null }> = [];
    const sandbox = new LocalWorkspaceSandbox(ws, {
      beforeWrite: async (path) => {
        seen.push({ path, before: await readFile(path, 'utf8').catch(() => null) });
      },
    });
    const file = join(ws, 'videos/a.sparkvideo.json');
    expect(await sandbox.write(file, '{"v":1}')).not.toHaveProperty('error');
    expect(await sandbox.edit(file, '"v":1', '"v":2')).not.toHaveProperty('error');
    expect(seen).toEqual([
      { path: file, before: null },
      { path: file, before: '{"v":1}' },
    ]);
    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
  });
});
