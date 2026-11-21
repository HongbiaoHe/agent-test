import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Redis } from 'ioredis';
import type { PrismaService } from '../prisma/prisma.service';
import { hashToken, McpGrantService } from './mcp-grant.service';

/** McpGrant / McpToken 的内存版：只实现 McpGrantService 用到的几个方法 */
interface Grant {
  id: string;
  kind: string;
  userId: string;
  tenantId: string;
  name: string;
  clientId: string | null;
  scopes: unknown;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}
interface Token {
  id: string;
  grantId: string;
  kind: string;
  hash: string;
  expiresAt: Date | null;
}

function fakePrisma() {
  const grants: Grant[] = [];
  const tokens: Token[] = [];
  let seq = 0;
  const id = () => `id${++seq}`;
  const withGrant = (t: Token | undefined) =>
    t ? { ...t, grant: grants.find((g) => g.id === t.grantId)! } : null;
  const prisma = {
    mcpGrant: {
      create: ({
        data,
      }: {
        data: Omit<
          Grant,
          | 'id'
          | 'createdAt'
          | 'lastUsedAt'
          | 'revokedAt'
          | 'clientId'
          | 'expiresAt'
        > & {
          clientId?: string;
          expiresAt?: Date | null;
          tokens?: { create: Omit<Token, 'id' | 'grantId'> };
        };
      }) => {
        const { tokens: nested, clientId, expiresAt, ...rest } = data;
        const g: Grant = {
          ...rest,
          clientId: clientId ?? null,
          expiresAt: expiresAt ?? null,
          id: id(),
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
        };
        grants.push(g);
        if (nested) tokens.push({ ...nested.create, id: id(), grantId: g.id });
        return Promise.resolve(g);
      },
      findMany: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          grants.filter((g) => g.userId === where.userId && !g.revokedAt),
        ),
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; userId?: string };
        data: Partial<Grant>;
      }) => {
        const hit = grants.filter(
          (g) =>
            g.id === where.id &&
            !g.revokedAt &&
            (where.userId === undefined || g.userId === where.userId),
        );
        hit.forEach((g) => Object.assign(g, data));
        return Promise.resolve({ count: hit.length });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Grant>;
      }) => {
        const g = grants.find((x) => x.id === where.id)!;
        Object.assign(g, data);
        return Promise.resolve(g);
      },
    },
    mcpToken: {
      findUnique: ({ where }: { where: { hash: string } }) =>
        Promise.resolve(withGrant(tokens.find((t) => t.hash === where.hash))),
      deleteMany: ({ where }: { where: { id: string } }) => {
        const i = tokens.findIndex((t) => t.id === where.id);
        if (i >= 0) tokens.splice(i, 1);
        return Promise.resolve({ count: i >= 0 ? 1 : 0 });
      },
      createMany: ({ data }: { data: Omit<Token, 'id'>[] }) => {
        data.forEach((d) => tokens.push({ ...d, id: id() }));
        return Promise.resolve({ count: data.length });
      },
    },
  };
  return { prisma, grants, tokens };
}

const user = { userId: 'u1', tenantId: 't1' };

function setup() {
  const f = fakePrisma();
  const kv = new Map<string, string>();
  const redis = {
    set: (k: string, v: string) => {
      kv.set(k, v);
      return Promise.resolve('OK');
    },
    get: (k: string) => Promise.resolve(kv.get(k) ?? null),
    mget: (keys: string[]) =>
      Promise.resolve(keys.map((k) => kv.get(k) ?? null)),
  };
  const svc = new McpGrantService(
    f.prisma as unknown as PrismaService,
    redis as unknown as Redis,
  );
  return { ...f, svc };
}

describe('McpGrantService', () => {
  it('PAT：明文只返回一次、库里只有哈希，校验得到授权身份与 scope', async () => {
    const { svc, tokens } = setup();
    const { grant, token } = await svc.createPat(
      user,
      '我的 Cursor',
      ['canvas:read'],
      30,
    );
    expect(token).toMatch(/^cvs_pat_/);
    expect(tokens[0].hash).toBe(hashToken(token));
    expect(tokens.some((t) => t.hash === token)).toBe(false);
    const p = await svc.verify(token);
    expect(p).toMatchObject({
      grantId: grant.id,
      userId: 'u1',
      tenantId: 't1',
      name: '我的 Cursor',
      scopes: ['canvas:read'],
    });
    expect(p?.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('永不过期的 PAT：expiresAt 为 null', async () => {
    const { svc } = setup();
    const { token } = await svc.createPat(user, 'n', ['canvas:read'], null);
    expect((await svc.verify(token))?.expiresAt).toBeNull();
  });

  it('吊销后立即失效；吊销别人的授权报 MCP_GRANT_NOT_FOUND', async () => {
    const { svc } = setup();
    const { grant, token } = await svc.createPat(
      user,
      'n',
      ['canvas:read'],
      null,
    );
    await expect(svc.revoke('someone-else', grant.id)).rejects.toThrow();
    expect(await svc.verify(token)).not.toBeNull();
    await svc.revoke('u1', grant.id);
    expect(await svc.verify(token)).toBeNull();
    expect(await svc.list('u1')).toEqual([]);
  });

  it('过期的 PAT 校验失败', async () => {
    const { svc, grants, tokens } = setup();
    const { token } = await svc.createPat(user, 'n', ['canvas:read'], 30);
    const past = new Date(Date.now() - 1000);
    grants[0].expiresAt = past;
    tokens[0].expiresAt = past;
    expect(await svc.verify(token)).toBeNull();
  });

  it('OAuth：refresh 轮换后旧 refresh 立即作废，新 access 可用；refresh 本身不能当 access 用', async () => {
    const { svc } = setup();
    const first = await svc.issueOAuth(
      user,
      { clientId: 'c1', name: 'Claude Code' },
      ['canvas:read', 'canvas:write'],
    );
    expect(first.scope).toBe('canvas:read canvas:write');
    expect(await svc.verify(first.refresh_token!)).toBeNull();
    const second = await svc.rotateRefresh(
      'c1',
      first.refresh_token!,
      undefined,
    );
    await expect(
      svc.rotateRefresh('c1', first.refresh_token!, undefined),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect((await svc.verify(second.access_token))?.scopes).toEqual([
      'canvas:read',
      'canvas:write',
    ]);
  });

  it('refresh：别的客户端拿来用、或申请超出原授权的 scope → invalid_grant', async () => {
    const { svc } = setup();
    const t = await svc.issueOAuth(user, { clientId: 'c1', name: 'x' }, [
      'canvas:read',
    ]);
    await expect(
      svc.rotateRefresh('c2', t.refresh_token!, undefined),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      svc.rotateRefresh('c1', t.refresh_token!, ['media:generate']),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('RFC 7009 吊销：吊销 refresh 连带 access 失效；别的客户端吊销不生效', async () => {
    const { svc } = setup();
    const t = await svc.issueOAuth(user, { clientId: 'c1', name: 'x' }, [
      'canvas:read',
    ]);
    await svc.revokeByToken('c2', t.refresh_token!);
    expect(await svc.verify(t.access_token)).not.toBeNull();
    await svc.revokeByToken('c1', t.refresh_token!);
    expect(await svc.verify(t.access_token)).toBeNull();
  });
  describe('agentOf：认出是哪个 agent', () => {
    const initialize = (clientInfo: Record<string, string>) => ({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo },
    });
    const toolsCall = { jsonrpc: '2.0', id: 1, method: 'tools/call' };

    it('initialize 自报的 title 优先，之后的工具调用沿用', async () => {
      const { svc } = setup();
      const { token } = await svc.createPat(
        user,
        '我的令牌',
        ['canvas:read'],
        null,
      );
      const p = (await svc.verify(token))!;
      expect(p.agent).toBeNull();
      expect(
        await svc.agentOf(
          p,
          initialize({
            name: 'claude-code',
            title: 'Claude Code',
            version: '2.1',
          }),
        ),
      ).toBe('Claude Code');
      expect(await svc.agentOf(p, toolsCall)).toBe('Claude Code');
    });

    it('没有 title 用 name', async () => {
      const { svc } = setup();
      const { token } = await svc.createPat(user, 'n', ['canvas:read'], null);
      const p = (await svc.verify(token))!;
      expect(
        await svc.agentOf(
          p,
          initialize({ name: 'codex-mcp-client', version: '1' }),
        ),
      ).toBe('codex-mcp-client');
    });

    it('授权列表带上 agent：PAT 取 initialize 记下的，OAuth 没报过时用注册名', async () => {
      const { svc } = setup();
      const { token } = await svc.createPat(
        user,
        '我的令牌',
        ['canvas:read'],
        null,
      );
      await svc.issueOAuth(user, { clientId: 'c1', name: 'Cursor' }, [
        'canvas:read',
      ]);
      await svc.createPat(user, '没用过', ['canvas:read'], null);
      await svc.agentOf(
        (await svc.verify(token))!,
        initialize({ name: 'claude-code', title: 'Claude Code', version: '2' }),
      );
      const byName = Object.fromEntries(
        (await svc.list('u1')).map((g) => [g.name, g.agent]),
      );
      expect(byName).toEqual({
        我的令牌: 'Claude Code',
        Cursor: 'Cursor',
        没用过: null,
      });
    });

    it('从没 initialize 过：PAT 为 null，OAuth 退回 DCR 注册名', async () => {
      const { svc } = setup();
      const { token } = await svc.createPat(user, 'n', ['canvas:read'], null);
      expect(
        await svc.agentOf((await svc.verify(token))!, toolsCall),
      ).toBeNull();
      const t = await svc.issueOAuth(user, { clientId: 'c1', name: 'Cursor' }, [
        'canvas:read',
      ]);
      expect(
        await svc.agentOf((await svc.verify(t.access_token))!, toolsCall),
      ).toBe('Cursor');
    });
  });
});
