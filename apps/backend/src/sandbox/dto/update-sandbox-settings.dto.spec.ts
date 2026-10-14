import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSandboxSettingsDto } from './update-sandbox-settings.dto';

/** 返回校验失败的字段名（空数组 = 通过）。 */
async function invalidFields(body: object): Promise<string[]> {
  const errors = await validate(
    plainToInstance(UpdateSandboxSettingsDto, body),
  );
  return errors.map((e) => e.property);
}

describe('UpdateSandboxSettingsDto', () => {
  it('合法：局部字段 / provider null / 永不删除 -1', async () => {
    expect(await invalidFields({})).toEqual([]);
    expect(await invalidFields({ provider: 'e2b' })).toEqual([]);
    expect(await invalidFields({ provider: null })).toEqual([]);
    expect(
      await invalidFields({ idleMinutes: 60, autoDeleteMinutes: -1 }),
    ).toEqual([]);
    expect(await invalidFields({ autoDeleteMinutes: 10080 })).toEqual([]);
  });

  it('非法提供方', async () => {
    expect(await invalidFields({ provider: 'docker' })).toEqual(['provider']);
  });

  it('闲置时长越界 / 非整数', async () => {
    expect(await invalidFields({ idleMinutes: 0 })).toEqual(['idleMinutes']);
    expect(await invalidFields({ idleMinutes: 61 })).toEqual(['idleMinutes']);
    expect(await invalidFields({ idleMinutes: 1.5 })).toEqual(['idleMinutes']);
  });

  it('自动删除拒绝 0（Daytona 0 = 停机即删）与越界', async () => {
    expect(await invalidFields({ autoDeleteMinutes: 0 })).toEqual([
      'autoDeleteMinutes',
    ]);
    expect(await invalidFields({ autoDeleteMinutes: -2 })).toEqual([
      'autoDeleteMinutes',
    ]);
    expect(await invalidFields({ autoDeleteMinutes: 10081 })).toEqual([
      'autoDeleteMinutes',
    ]);
  });

  it('网络：合法模式 / 白名单 / 入站开关', async () => {
    expect(
      await invalidFields({
        egressMode: 'allowlist',
        allowList: ['pypi.org', '*.github.com', '1.1.1.1', '10.0.0.0/8'],
        publicTraffic: false,
      }),
    ).toEqual([]);
  });

  it('网络：非法模式 / 非法条目 / 超过 50 条 / 非布尔', async () => {
    expect(await invalidFields({ egressMode: 'proxy' })).toEqual([
      'egressMode',
    ]);
    expect(await invalidFields({ allowList: ['http://pypi.org'] })).toEqual([
      'allowList',
    ]);
    expect(await invalidFields({ allowList: ['*'] })).toEqual(['allowList']);
    expect(
      await invalidFields({
        allowList: Array.from({ length: 51 }, (_, i) => `h${i}.com`),
      }),
    ).toEqual(['allowList']);
    expect(await invalidFields({ publicTraffic: 'yes' })).toEqual([
      'publicTraffic',
    ]);
  });
});
