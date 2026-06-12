import { UsersService } from './users.service';

const prismaMock = {
  user: { findUnique: jest.fn() },
  authenticator: { findFirst: jest.fn(), delete: jest.fn() },
};

beforeEach(() => jest.clearAllMocks());

describe('UsersService.getMe', () => {
  it('返回 email/createdAt/tenantName/passkeys（transports 可为 null）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      createdAt: new Date('2026-01-01'),
      tenant: { name: 'a@b.c' },
      authenticators: [
        { id: 'pk1', createdAt: new Date('2026-02-02'), transports: 'internal,hybrid' },
        { id: 'pk2', createdAt: new Date('2026-03-03'), transports: null },
      ],
    });
    const svc = new UsersService(prismaMock as never);
    const me = await svc.getMe('u1');
    expect(me.email).toBe('a@b.c');
    expect(me.tenantName).toBe('a@b.c');
    expect(me.passkeys).toEqual([
      { id: 'pk1', createdAt: new Date('2026-02-02'), transports: 'internal,hybrid' },
      { id: 'pk2', createdAt: new Date('2026-03-03'), transports: null },
    ]);
    // 不泄漏 publicKey/counter/credentialId 等内部列
    expect(Object.keys(me.passkeys[0]).sort()).toEqual(['createdAt', 'id', 'transports']);
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
