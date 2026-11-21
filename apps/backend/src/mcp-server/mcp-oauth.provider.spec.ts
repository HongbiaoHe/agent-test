import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { PrismaService } from '../prisma/prisma.service';
import type { McpGrantService } from './mcp-grant.service';
import { McpOAuthProvider } from './mcp-oauth.provider';

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    map: m,
    redis: {
      set: (k: string, v: string) => {
        m.set(k, v);
        return Promise.resolve('OK');
      },
      get: (k: string) => Promise.resolve(m.get(k) ?? null),
      getdel: (k: string) => {
        const v = m.get(k) ?? null;
        m.delete(k);
        return Promise.resolve(v);
      },
    },
  };
}

const client = (id: string): OAuthClientInformationFull => ({
  client_id: id,
  client_name: 'Claude Code',
  redirect_uris: ['http://localhost:5555/callback'],
});

function setup() {
  const { redis, map } = fakeRedis();
  const issueOAuth = jest.fn(() =>
    Promise.resolve({ access_token: 'at', token_type: 'Bearer' }),
  );
  const provider = new McpOAuthProvider(
    {} as unknown as PrismaService,
    { issueOAuth } as unknown as McpGrantService,
    redis as unknown as Redis,
  );
  return { provider, map, issueOAuth };
}

/** 走到「用户允许」：authorize → 从重定向地址取 requestId → approve → 从回跳地址取 code */
async function approved(
  provider: McpOAuthProvider,
  scopes: string[] = [],
  state = 'xyz',
) {
  let location = '';
  const res = {
    redirect: (u: string) => (location = u),
  } as unknown as Response;
  await provider.authorize(
    client('c1'),
    {
      redirectUri: 'http://localhost:5555/callback',
      codeChallenge: 'challenge-1',
      state,
      scopes,
    },
    res,
  );
  const requestId = new URL(location).searchParams.get('request')!;
  return { location, requestId };
}

describe('McpOAuthProvider', () => {
  it('authorize 把浏览器送到前端同意页；同意页详情给出客户端名、回跳 host 与 scope（没申请 = 全部）', async () => {
    const { provider } = setup();
    const { location, requestId } = await approved(provider);
    expect(new URL(location).pathname).toBe('/oauth/consent');
    expect(await provider.consentDetails(requestId)).toEqual({
      clientName: 'Claude Code',
      redirectHost: 'localhost:5555',
      scopes: ['canvas:read', 'canvas:write', 'media:generate'],
    });
  });

  it('申请的 scope 只保留认识的', async () => {
    const { provider } = setup();
    const { requestId } = await approved(provider, ['canvas:read', 'evil']);
    expect((await provider.consentDetails(requestId)).scopes).toEqual([
      'canvas:read',
    ]);
  });

  it('允许 → 回跳带 code 与 state；同一请求不能再拍板第二次', async () => {
    const { provider } = setup();
    const { requestId } = await approved(provider);
    const { redirectUrl } = await provider.approve(requestId, {
      userId: 'u1',
      tenantId: 't1',
    });
    const u = new URL(redirectUrl);
    expect(u.origin + u.pathname).toBe('http://localhost:5555/callback');
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('code')).toBeTruthy();
    await expect(provider.deny(requestId)).rejects.toThrow();
  });

  it('拒绝 → 回跳带 error=access_denied', async () => {
    const { provider } = setup();
    const { requestId } = await approved(provider);
    const u = new URL((await provider.deny(requestId)).redirectUrl);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
  });

  it('授权码：取 challenge 不消费；换码只能一次；别的客户端拿不到', async () => {
    const { provider, issueOAuth } = setup();
    const { requestId } = await approved(provider, ['canvas:read']);
    const code = new URL(
      (await provider.approve(requestId, { userId: 'u1', tenantId: 't1' }))
        .redirectUrl,
    ).searchParams.get('code')!;

    await expect(
      provider.challengeForAuthorizationCode(client('c2'), code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(
      await provider.challengeForAuthorizationCode(client('c1'), code),
    ).toBe('challenge-1');
    expect(
      await provider.challengeForAuthorizationCode(client('c1'), code),
    ).toBe('challenge-1');

    await provider.exchangeAuthorizationCode(
      client('c1'),
      code,
      undefined,
      'http://localhost:5555/callback',
    );
    expect(issueOAuth).toHaveBeenCalledWith(
      { userId: 'u1', tenantId: 't1' },
      { clientId: 'c1', name: 'Claude Code' },
      ['canvas:read'],
    );
    await expect(
      provider.exchangeAuthorizationCode(client('c1'), code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('换码时 redirect_uri 与授权请求不一致 → invalid_grant，且码作废', async () => {
    const { provider, issueOAuth } = setup();
    const { requestId } = await approved(provider);
    const code = new URL(
      (await provider.approve(requestId, { userId: 'u1', tenantId: 't1' }))
        .redirectUrl,
    ).searchParams.get('code')!;
    await expect(
      provider.exchangeAuthorizationCode(
        client('c1'),
        code,
        undefined,
        'http://evil.example/cb',
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(issueOAuth).not.toHaveBeenCalled();
  });
});
