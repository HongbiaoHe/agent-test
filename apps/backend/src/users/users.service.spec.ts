import { UsersService } from './users.service';

const prismaMock = {
  user: { findUnique: jest.fn() },
  authenticator: { findFirst: jest.fn(), delete: jest.fn() },
};

beforeEach(() => jest.clearAllMocks());

describe('UsersService.getMe', () => {
  it('返回 email/createdAt/tenantName + enriched passkeys（providerName/deviceType/backedUp/lastUsedAt）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      createdAt: new Date('2026-01-01'),
      tenant: { name: 'a@b.c' },
      authenticators: [
        {
          id: 'pk1',
          createdAt: new Date('2026-02-02'),
          transports: 'internal,hybrid',
          aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
          deviceType: 'multiDevice',
          backedUp: true,
          lastUsedAt: new Date('2026-04-04'),
        },
        {
          id: 'pk2',
          createdAt: new Date('2026-03-03'),
          transports: null,
          aaguid: null,
          deviceType: 'singleDevice',
          backedUp: false,
          lastUsedAt: null,
        },
      ],
    });
    const svc = new UsersService(prismaMock as never);
    const me = await svc.getMe('u1');
    expect(me.email).toBe('a@b.c');
    expect(me.tenantName).toBe('a@b.c');
    expect(me.passkeys[0]).toEqual({
      id: 'pk1',
      createdAt: new Date('2026-02-02'),
      transports: 'internal,hybrid',
      providerName: 'iCloud 钥匙串',
      deviceType: 'multiDevice',
      backedUp: true,
      lastUsedAt: new Date('2026-04-04'),
    });
    expect(me.passkeys[1].providerName).toBe('设备 passkey');
    expect(me.passkeys[1].lastUsedAt).toBeNull();
    // 回传对象不含 aaguid 原始值——aaguid 只用于后端解析成 providerName，
    // 也不泄漏 publicKey/counter/credentialId 等内部列
    expect(Object.keys(me.passkeys[0]).sort()).toEqual([
      'backedUp',
      'createdAt',
      'deviceType',
      'id',
      'lastUsedAt',
      'providerName',
      'transports',
    ]);
  });
});

describe('UsersService.deletePasskey', () => {
  it('删除本人 passkey', async () => {
    prismaMock.authenticator.findFirst.mockResolvedValue({ id: 'pk1' });
    prismaMock.authenticator.delete.mockResolvedValue({});
    const svc = new UsersService(prismaMock as never);
    await expect(svc.deletePasskey('u1', 'pk1')).resolves.toEqual({ deleted: 'pk1' });
    expect(prismaMock.authenticator.findFirst).toHaveBeenCalledWith({
      where: { id: 'pk1', userId: 'u1' },
    });
  });

  it('他人/不存在的 passkey 抛 PASSKEY_NOT_FOUND', async () => {
    prismaMock.authenticator.findFirst.mockResolvedValue(null);
    const svc = new UsersService(prismaMock as never);
    // BusinessException 暴露 readonly errCode（business.exception.ts:9），30003 = PASSKEY_NOT_FOUND
    await expect(svc.deletePasskey('u1', 'other')).rejects.toMatchObject({
      errCode: 30003,
    });
  });
});
