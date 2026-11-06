import { HumanMessage } from '@langchain/core/messages';
import {
  activePlanProvider,
  applyDynamicParts,
  collectDynamicParts,
  createDynamicContextMiddleware,
} from './dynamic-context';

describe('applyDynamicParts', () => {
  it('system_tail 按序 concat 到 systemMessage 末尾；message 追加 HumanMessage；不动原数组', () => {
    const concat = jest.fn((s: string) => ({ concated: s }));
    const req = { systemMessage: { concat }, messages: [{ id: 'm1' }] };
    const out = applyDynamicParts(req, [
      { placement: 'system_tail', text: 'PLAN' },
      { placement: 'message', text: 'STATE' },
      { placement: 'system_tail', text: 'INV' },
    ]);
    expect(concat).toHaveBeenCalledTimes(1);
    expect(concat).toHaveBeenCalledWith('\n\nPLAN\n\nINV');
    expect(out.systemMessage).toEqual({ concated: '\n\nPLAN\n\nINV' });
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toBeInstanceOf(HumanMessage);
    expect((out.messages[1] as HumanMessage).text).toBe('STATE');
    expect(req.messages).toHaveLength(1);
  });

  it('空 parts / 空文本：原样返回同一对象，不 concat', () => {
    const concat = jest.fn();
    const req = { systemMessage: { concat }, messages: [] };
    expect(applyDynamicParts(req, [])).toBe(req);
    const out = applyDynamicParts(req, [
      { placement: 'system_tail', text: '' },
    ]);
    expect(concat).not.toHaveBeenCalled();
    expect(out.messages).toBe(req.messages);
  });
});

describe('activePlanProvider', () => {
  it('context.activePlan 非空 → system_tail；空 / 缺失 → null', () => {
    expect(activePlanProvider({ context: { activePlan: 'P' } })).toEqual([
      { placement: 'system_tail', text: 'P' },
    ]);
    expect(activePlanProvider({ context: { activePlan: '' } })).toBeNull();
    expect(activePlanProvider({})).toBeNull();
  });
});

describe('collectDynamicParts', () => {
  it('依次 await 每个 provider，null 跳过，抛错的记日志并跳过', async () => {
    const log = jest.fn();
    const parts = await collectDynamicParts(
      [
        () => null,
        async () => [{ placement: 'message', text: 'a' }],
        () => {
          throw new Error('boom');
        },
        () => [{ placement: 'system_tail', text: 'b' }],
      ],
      {},
      log,
    );
    expect(parts).toEqual([
      { placement: 'message', text: 'a' },
      { placement: 'system_tail', text: 'b' },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('createDynamicContextMiddleware', () => {
  it('是名为 dynamicContextMiddleware、带 wrapModelCall 的中间件', () => {
    const mw = createDynamicContextMiddleware([activePlanProvider]);
    expect(mw.name).toBe('dynamicContextMiddleware');
    expect(typeof mw.wrapModelCall).toBe('function');
  });
});
