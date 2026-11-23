import { EventEmitter } from 'node:events';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import type { AuthUser } from '../auth/jwt-auth.guard';
import type { MediaService } from '../media/media.service';
import { CanvasAgentController } from './canvas-agent.controller';
import type { CanvasService } from './canvas.service';
import { CanvasAgentInspectMediaDto } from './dto/canvas-agent.dto';

describe('CanvasAgentController.inspectMedia（POST :id/media-inspect）', () => {
  const user: AuthUser = {
    userId: 'u1',
    tenantId: 't1',
    email: 'u1@example.test',
  };
  const canvas = {
    assertAccess: jest.fn(),
    inspectMedia: jest.fn(),
  };
  // cast-at-injection：只用到这两个方法；媒体服务这个端点用不到
  const controller = new CanvasAgentController(
    canvas as unknown as CanvasService,
    {} as unknown as MediaService,
  );
  // 只用到 on('close')：EventEmitter 足够
  const response = () => new EventEmitter() as unknown as Response;

  beforeEach(() => jest.clearAllMocks());

  it('先核对画布归属：别人的画布直接拒绝，不去查产物', async () => {
    canvas.assertAccess.mockRejectedValue(new Error('画布不存在'));
    await expect(
      controller.inspectMedia(
        'c-other',
        { versionIds: ['v1'] },
        user,
        response(),
      ),
    ).rejects.toThrow('画布不存在');
    expect(canvas.assertAccess).toHaveBeenCalledWith('c-other', 't1');
    expect(canvas.inspectMedia).not.toHaveBeenCalled();
  });

  it('连接断开（desktop 停止本轮）时中止等待', async () => {
    canvas.assertAccess.mockResolvedValue(undefined);
    canvas.inspectMedia.mockResolvedValue([]);
    const res = response();
    await expect(
      controller.inspectMedia('c1', { versionIds: ['v1'] }, user, res),
    ).resolves.toEqual({ items: [] });
    const signal = (canvas.inspectMedia.mock.calls[0] as unknown[])[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).toHaveProperty('aborted', false);
    res.emit('close');
    expect(signal).toHaveProperty('aborted', true);
  });

  it('入参：1～10 个字符串版本 id', async () => {
    const errors = async (versionIds: unknown) =>
      (
        await validate(
          plainToInstance(CanvasAgentInspectMediaDto, { versionIds }),
        )
      ).length;
    expect(await errors(['v1'])).toBe(0);
    expect(await errors(Array.from({ length: 10 }, (_, i) => `v${i}`))).toBe(0);
    expect(await errors([])).toBeGreaterThan(0);
    expect(
      await errors(Array.from({ length: 11 }, (_, i) => `v${i}`)),
    ).toBeGreaterThan(0);
    expect(await errors([1])).toBeGreaterThan(0);
    expect(await errors('v1')).toBeGreaterThan(0);
  });
});
