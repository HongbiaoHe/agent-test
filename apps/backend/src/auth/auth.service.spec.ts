import { AuthService } from './auth.service';

const mockSend = jest.fn();
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => {
      return {
        emails: {
          send: mockSend,
        },
      };
    }),
  };
});

describe('AuthService verification code flow', () => {
  let prismaMock: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    tenant: {
      create: jest.Mock;
    };
  };
  let jwtMock: {
    signAsync: jest.Mock;
  };
  let configMock: {
    get: jest.Mock;
  };
  let redisMock: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaMock = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      tenant: {
        create: jest.fn(),
      },
    };

    jwtMock = {
      signAsync: jest.fn(),
    };

    configMock = {
      get: jest.fn(),
    };

    redisMock = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    service = new AuthService(
      prismaMock as never,
      jwtMock as never,
      configMock as never,
      redisMock as never,
    );
  });

  describe('sendVerificationCode', () => {
    it('should return code directly if RESEND_API_KEY is not configured', async () => {
      configMock.get.mockReturnValue(undefined); // RESEND_API_KEY

      const result = await service.sendVerificationCode('test@example.com');
      expect(result).toMatch(/^\d{6}$/);
    });

    it('should throw if code was recently sent (rate limited)', async () => {
      redisMock.get.mockResolvedValue('1'); // isLimited = true

      await expect(
        service.sendVerificationCode('test@example.com'),
      ).rejects.toMatchObject({
        errCode: 30006, // VERIFY_CODE_TOO_FREQUENT
      });
    });

    it('should generate code, save it to Redis, and send email successfully', async () => {
      redisMock.get.mockResolvedValue(null); // isLimited = false
      configMock.get.mockImplementation((key: string) => {
        if (key === 'RESEND_API_KEY') return 'test_key';
        if (key === 'RESEND_FROM_EMAIL') return 'no-reply@example.com';
        return undefined;
      });

      mockSend.mockResolvedValue({ id: 'msg_123' });

      await service.sendVerificationCode('test@example.com');

      expect(redisMock.set).toHaveBeenCalledTimes(2);
      expect(redisMock.set).toHaveBeenCalledWith(
        expect.stringContaining('auth:code:test@example.com'),
        expect.stringMatching(/^\d{6}$/),
        'EX',
        600,
      );
      // Saved rate limit
      expect(redisMock.set).toHaveBeenCalledWith(
        'auth:code:limit:test@example.com',
        '1',
        'EX',
        60,
      );

      expect(mockSend).toHaveBeenCalledWith({
        from: 'no-reply@example.com',
        to: 'test@example.com',
        subject: '您的登录注册验证码',
        html: expect.stringContaining('验证码为'),
      });
    });

    it('should clean up Redis if sending email fails', async () => {
      redisMock.get.mockResolvedValue(null);
      configMock.get.mockReturnValue('test_key');
      mockSend.mockRejectedValue(new Error('Send failed'));

      await expect(
        service.sendVerificationCode('test@example.com'),
      ).rejects.toThrow('Send failed');

      expect(redisMock.del).toHaveBeenCalledWith('auth:code:test@example.com');
      expect(redisMock.del).toHaveBeenCalledWith(
        'auth:code:limit:test@example.com',
      );
    });
  });

  describe('verifyCode', () => {
    it('should throw if verification code has expired/not in Redis', async () => {
      redisMock.get.mockResolvedValue(null);

      await expect(
        service.verifyCode('test@example.com', '123456'),
      ).rejects.toMatchObject({
        errCode: 30004, // VERIFY_CODE_EXPIRED
      });
    });

    it('should throw if code does not match', async () => {
      redisMock.get.mockResolvedValue('654321');

      await expect(
        service.verifyCode('test@example.com', '123456'),
      ).rejects.toMatchObject({
        errCode: 30005, // VERIFY_CODE_INVALID
      });
    });

    it('should successfully verify, delete code, and sign JWT token', async () => {
      redisMock.get.mockResolvedValue('123456');
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user_1',
        email: 'test@example.com',
        tenantId: 'tenant_1',
      });
      jwtMock.signAsync.mockResolvedValue('jwt_token_abc');

      const result = await service.verifyCode('test@example.com', '123456');

      expect(redisMock.del).toHaveBeenCalledWith('auth:code:test@example.com');
      expect(redisMock.del).toHaveBeenCalledWith(
        'auth:code:limit:test@example.com',
      );
      expect(result).toEqual({ token: 'jwt_token_abc' });
    });
  });
});
