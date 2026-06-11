/**
 * pickPreferredSandbox 单测：多沙箱（历史裂变残留）下的确定性选择规则。
 * started 优先 > stopped > 过渡/异常态；同级取 createdAt 最早。
 *
 * sandbox.ts 模块级引入 Daytona SDK / @langchain/daytona（深 ESM 链 jest 加载失败），
 * 被测函数是纯函数不触及它们，mock 掉即可。
 */
jest.mock('@daytonaio/sdk', () => ({ Daytona: jest.fn() }));
jest.mock('@langchain/daytona', () => ({ DaytonaSandbox: class {} }));

import { pickPreferredSandbox, type SandboxListing } from './sandbox';

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
