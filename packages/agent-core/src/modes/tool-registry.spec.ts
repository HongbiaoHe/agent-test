import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Capability } from './capabilities';
import {
  shareFactory,
  type ToolCreateContext,
  ToolRegistry,
} from './tool-registry';

const mk = (name: string) =>
  tool(() => name, { name, description: name, schema: z.object({}) });

const ctxOf = (): ToolCreateContext<{ tag: string }> => ({
  conversationId: 'c',
  userId: 'u',
  env: { capabilities: new Set<Capability>(), skillsDir: '/skills' },
  host: { tag: 't' },
});

describe('ToolRegistry', () => {
  it('register 重名抛错；list / catalog 按注册顺序', () => {
    const r = new ToolRegistry<{ tag: string }>();
    r.register({
      name: 'a',
      title: 'A',
      description: 'da',
      create: () => mk('a'),
    });
    expect(() =>
      r.register({
        name: 'a',
        title: 'A',
        description: 'da',
        create: () => mk('a'),
      }),
    ).toThrow(/a/);
    r.register({
      name: 'b',
      title: 'B',
      description: 'db',
      requires: ['sandbox'],
      create: () => mk('b'),
    });
    expect(r.list().map((d) => d.name)).toEqual(['a', 'b']);
    expect(r.catalog()).toEqual([
      { name: 'a', title: 'A', description: 'da', requires: [] },
      { name: 'b', title: 'B', description: 'db', requires: ['sandbox'] },
    ]);
    expect(r.get('b')?.requires).toEqual(['sandbox']);
    expect(r.get('zz')).toBeUndefined();
  });

  it('shareFactory：同一 ctx 只调一次工厂，按名分发；不同 ctx 再调', () => {
    const factory = jest.fn(() => [mk('x'), mk('y')]);
    const descs = shareFactory<{ tag: string }>(factory, [
      { name: 'x', title: 'X', description: 'x' },
      { name: 'y', title: 'Y', description: 'y', interruptOn: true },
    ]);
    const ctx = ctxOf();
    expect(descs[0].create(ctx).name).toBe('x');
    expect(descs[1].create(ctx).name).toBe('y');
    expect(descs[1].interruptOn).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    descs[0].create(ctxOf());
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('shareFactory：工厂没产出该名字的工具时抛错', () => {
    const [d] = shareFactory<{ tag: string }>(
      () => [mk('x')],
      [{ name: 'ghost', title: 'G', description: 'g' }],
    );
    expect(() => d.create(ctxOf())).toThrow(/ghost/);
  });
});
