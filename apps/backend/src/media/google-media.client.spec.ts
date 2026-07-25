/**
 * GoogleMediaClient.pollVideosOperation 单测。
 *
 * 只测轮询容错这一段——它是纯逻辑，可注入假 poller 与极小间隔，不打云端
 * （本文件其余部分按设计不做单测，见 google-media.client.ts 类注释）。
 *
 * 背景：本机直连 Google 的 TLS 握手时快时慢（实测 0.6s~15s），单次轮询抛 `fetch failed`
 * 属常态；原实现裸调用 getVideosOperation，一次瞬时失败就把整条 version 判 failed。
 */
import type { GenerateVideosOperation } from '@google/genai';
import { GoogleMediaClient } from './google-media.client';

/** 造一个够用的 operation 壳子（只有 done/name 参与轮询逻辑） */
function op(done: boolean, name = 'op-1'): GenerateVideosOperation {
  return { done, name } as unknown as GenerateVideosOperation;
}

describe('GoogleMediaClient.pollVideosOperation', () => {
  let client: GoogleMediaClient;
  const base = { intervalMs: 1, timeoutMs: 5_000 };

  beforeEach(() => {
    client = new GoogleMediaClient();
    // 容错路径会 logger.warn，测试里静音避免污染输出
    jest.spyOn(client['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('一路顺利：轮询到 done 就返回', async () => {
    const poll = jest
      .fn<Promise<GenerateVideosOperation>, [GenerateVideosOperation]>()
      .mockResolvedValueOnce(op(false))
      .mockResolvedValueOnce(op(true));

    const r = await client.pollVideosOperation(op(false), poll, base);

    expect(r.done).toBe(true);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('瞬时失败不判死：连续失败少于上限时继续轮询并最终成功', async () => {
    const poll = jest
      .fn<Promise<GenerateVideosOperation>, [GenerateVideosOperation]>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(op(true));

    const r = await client.pollVideosOperation(op(false), poll, base);

    expect(r.done).toBe(true);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('成功一次即清零：失败-成功-失败 交替不会累积到上限', async () => {
    const poll = jest
      .fn<Promise<GenerateVideosOperation>, [GenerateVideosOperation]>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(op(false)) // 清零
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(op(true));

    const r = await client.pollVideosOperation(op(false), poll, {
      ...base,
      maxConsecutiveFailures: 2,
    });

    expect(r.done).toBe(true);
    expect(poll).toHaveBeenCalledTimes(6);
  });

  it('连续失败超过上限 → 抛出最后一个错误', async () => {
    const poll = jest
      .fn<Promise<GenerateVideosOperation>, [GenerateVideosOperation]>()
      .mockRejectedValueOnce(new Error('fetch failed 1'))
      .mockRejectedValueOnce(new Error('fetch failed 2'))
      .mockRejectedValueOnce(new Error('fetch failed 3'));

    await expect(
      client.pollVideosOperation(op(false), poll, {
        ...base,
        maxConsecutiveFailures: 2,
      }),
    ).rejects.toThrow('fetch failed 3');
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('用户停止：aborted 时立刻抛取消，不再轮询', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const poll = jest.fn<Promise<GenerateVideosOperation>, []>();

    await expect(
      client.pollVideosOperation(op(false), poll, {
        ...base,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow('视频生成已取消');
    expect(poll).not.toHaveBeenCalled();
  });

  it('超时：deadline 到点抛超时（重试不会绕过它）', async () => {
    const poll = jest
      .fn<Promise<GenerateVideosOperation>, [GenerateVideosOperation]>()
      .mockRejectedValue(new Error('fetch failed'));

    await expect(
      client.pollVideosOperation(op(false), poll, {
        intervalMs: 1,
        timeoutMs: 0, // 立刻到点
        maxConsecutiveFailures: 99,
      }),
    ).rejects.toThrow('视频生成超时');
  });
});
