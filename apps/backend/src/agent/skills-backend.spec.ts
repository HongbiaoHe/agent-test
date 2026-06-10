/**
 * skills-backend 单测：刻意不依赖 deepagents 运行时（依赖链含 ESM-only 包，Jest CJS 模式下无法加载）。
 * 用 jest.mock 把 StoreBackend 换成一个最小 CJS stub，只测我们自己的覆写逻辑和 buildSkillSyncFiles。
 */

// ---- mock deepagents（必须在 import 之前、模块顶层声明）----
jest.mock('deepagents', () => {
  // 最小 StoreBackend stub：只暴露 write/edit 占位（不会被我们的测试调到）
  class StoreBackend {
    async write(_path: string, _content: string) {
      return { path: _path };
    }
    async edit(_path: string, _old: string, _new: string) {
      return { path: _path };
    }
  }
  return { StoreBackend };
});

import { InMemoryStore } from '@langchain/langgraph';
import { ReadOnlyStoreBackend, buildSkillSyncFiles } from './skills-backend';

describe('ReadOnlyStoreBackend', () => {
  let backend: ReadOnlyStoreBackend;

  beforeEach(() => {
    backend = new ReadOnlyStoreBackend();
  });

  it('write 应返回包含 "read-only" 的 error，不触碰 store', async () => {
    const result = await backend.write('/skills/foo.md', 'content');
    expect(result.error).toMatch(/read-only/);
    // 写操作被拦截，path 不应被设置
    expect(result.path).toBeUndefined();
  });

  it('edit 应返回包含 "read-only" 的 error，不触碰 store', async () => {
    const result = await backend.edit('/skills/foo.md', 'old', 'new');
    expect(result.error).toMatch(/read-only/);
    expect(result.path).toBeUndefined();
  });
});

describe('buildSkillSyncFiles', () => {
  it('从 store namespace [userId, "skills"] 里读出 2 条 FileData，返回 [[path, Uint8Array], ...]', async () => {
    const store = new InMemoryStore();
    const userId = 'u123';

    // 模拟 StoreBackend 写入技能文件时的数据结构：value.content 是行数组
    await store.put([userId, 'skills'], '/skills/skill-a.md', {
      content: ['# Skill A', 'line2'],
    });
    await store.put([userId, 'skills'], '/skills/skill-b.md', {
      content: ['# Skill B'],
    });

    const files = await buildSkillSyncFiles(store, userId);

    // 应返回 2 条
    expect(files).toHaveLength(2);

    // 每条是 [string, Uint8Array]
    const paths = files.map(([p]) => p).sort();
    expect(paths).toEqual(['/skills/skill-a.md', '/skills/skill-b.md'].sort());

    // Uint8Array 内容是 content 数组 join('\n') 的 UTF-8 编码
    const enc = new TextEncoder();
    const fileMap = Object.fromEntries(files.map(([p, b]) => [p, b]));
    expect(fileMap['/skills/skill-a.md']).toEqual(enc.encode('# Skill A\nline2'));
    expect(fileMap['/skills/skill-b.md']).toEqual(enc.encode('# Skill B'));
  });

  it('namespace 下无文件时返回空数组', async () => {
    const store = new InMemoryStore();
    const files = await buildSkillSyncFiles(store, 'nobody');
    expect(files).toHaveLength(0);
  });
});
