import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCanvasTools as createSharedCanvasTools } from '@agent-test/agent-core/canvas/canvas-tools';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import type { McpCanvasService } from './mcp-canvas.service';
import type { McpPrincipal } from './mcp-grant.service';
import type { McpScope } from './mcp-server.config';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { CANVAS_LOCK_RENEW_MS } from '@agent-test/canvas-schema';
import { INTERNAL_ERROR_MESSAGE } from './mcp-errors';
import {
  adaptDescription,
  buildCanvasMcpServer,
  MCP_BATCH_MAX,
  SHARED_TOOL_SCOPES,
} from './mcp-tools';

const principal = (scopes: McpScope[]): McpPrincipal => ({
  grantId: 'g1',
  userId: 'u1',
  tenantId: 't1',
  name: 'Claude Code',
  clientId: 'c1',
  agent: null,
  scopes,
  expiresAt: null,
});

function fakeSvc() {
  return {
    assertAccess: jest.fn(() => Promise.resolve()),
    lockForWrite: jest.fn(() => Promise.resolve()),
    listCanvases: jest.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    ),
    createCanvas: jest.fn(() =>
      Promise.resolve({
        canvasId: 'cv1',
        canvasUrl: 'http://localhost:3100/canvas/cv1',
      }),
    ),
    getCanvas: jest.fn(),
    waitForGenerations: jest.fn(),
    importAsset: jest.fn(),
    sharedTools: jest.fn(
      () => [] as ReturnType<McpCanvasService['sharedTools']>,
    ),
  };
}

async function connect(svc: ReturnType<typeof fakeSvc>, scopes: McpScope[]) {
  const server = buildCanvasMcpServer(
    svc as unknown as McpCanvasService,
    principal(scopes),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();

describe('画布 MCP 工具装配', () => {
  it('每个共享画布工具都登记了 scope', () => {
    const shared = createSharedCanvasTools(() => Promise.resolve('x'));
    expect(shared.map((t) => t.name).sort()).toEqual(
      Object.keys(SHARED_TOOL_SCOPES).sort(),
    );
  });

  it('改写后的描述不再出现「同一步」「附件清单」「会先请用户确认」等画布 agent 专属说法', () => {
    const shared = createSharedCanvasTools(() => Promise.resolve('x'));
    for (const t of shared) {
      const d = adaptDescription(t.description);
      expect(d).not.toMatch(/同一步|\[附件\]|会先请用户确认/);
      expect(d).toContain('canvasId');
    }
  });

  it('只读 scope：只有读工具，且都带 readOnlyHint', async () => {
    const client = await connect(fakeSvc(), ['canvas:read']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_canvas',
      'list_canvases',
      'list_media_models',
      'wait_for_generations',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('读 + 写、无 media:generate：没有生成 / 拼接工具', async () => {
    const names = await toolNames(
      await connect(fakeSvc(), ['canvas:read', 'canvas:write']),
    );
    expect(names).toContain('add_nodes');
    expect(names).toContain('import_asset');
    expect(names).not.toContain('generate_media_node');
    expect(names).not.toContain('merge_video_node');
  });

  it('全部 scope：共享工具都带 canvasId 必填参数；破坏性工具带 destructiveHint', async () => {
    const client = await connect(fakeSvc(), [
      'canvas:read',
      'canvas:write',
      'media:generate',
    ]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of Object.keys(SHARED_TOOL_SCOPES)) {
      expect(byName.get(name)?.inputSchema.required).toContain('canvasId');
    }
    expect(byName.get('clear_canvas')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('generate_media_node')?.annotations?.openWorldHint).toBe(
      true,
    );
  });

  it('写工具先上隐式锁；画布正忙时回 isError + CANVAS_BUSY，不执行工具', async () => {
    const svc = fakeSvc();
    svc.lockForWrite.mockRejectedValueOnce(
      new BusinessException(ErrorCodes.CANVAS_BUSY),
    );
    const client = await connect(svc, ['canvas:read', 'canvas:write']);
    const r = await client.callTool({
      name: 'add_node',
      arguments: { canvasId: 'cv1', type: 'image_gen', x: 0, y: 0 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain(
      String(ErrorCodes.CANVAS_BUSY.code),
    );
    expect(svc.lockForWrite).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'g1' }),
      'cv1',
    );
    expect(svc.sharedTools).not.toHaveBeenCalled();
  });

  /** sharedTools 换成只有一个工具的桩：invoke 由用例决定 */
  function withFakeTool(
    svc: ReturnType<typeof fakeSvc>,
    name: string,
    invoke: jest.Mock,
  ) {
    svc.sharedTools.mockReturnValue([
      { name, invoke } as unknown as StructuredToolInterface,
    ]);
  }

  it(`批量参数加上 ${MCP_BATCH_MAX} 项上限（add_nodes / update_nodes）`, async () => {
    const client = await connect(fakeSvc(), ['canvas:read', 'canvas:write']);
    const { tools } = await client.listTools();
    const prop = (tool: string, key: string) =>
      (
        tools.find((t) => t.name === tool)?.inputSchema.properties as Record<
          string,
          { maxItems?: number }
        >
      )[key];
    expect(prop('add_nodes', 'nodes').maxItems).toBe(MCP_BATCH_MAX);
    expect(prop('update_nodes', 'updates').maxItems).toBe(MCP_BATCH_MAX);
  });

  it('非业务异常只回通用说法，不带异常原文（服务端路径 / 源码）', async () => {
    const svc = fakeSvc();
    withFakeTool(
      svc,
      'add_node',
      jest.fn(() =>
        Promise.reject(
          new Error('Invalid `tx.canvasNode.create()` invocation in /srv/x.ts'),
        ),
      ),
    );
    const client = await connect(svc, ['canvas:read', 'canvas:write']);
    const r = await client.callTool({
      name: 'add_node',
      arguments: { canvasId: 'cv1', type: 'image_gen', x: 0, y: 0 },
    });
    expect(r.isError).toBe(true);
    const out = JSON.stringify(r.content);
    expect(out).toContain(INTERNAL_ERROR_MESSAGE);
    expect(out).not.toContain('/srv/x.ts');
  });

  it('写工具把中止信号传给共享工具，并在执行期间按心跳续锁', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const svc = fakeSvc();
      let finish: (v: string) => void = () => undefined;
      const invoke = jest.fn(
        () => new Promise<string>((res) => (finish = res)),
      );
      withFakeTool(svc, 'add_node', invoke);
      const client = await connect(svc, ['canvas:read', 'canvas:write']);
      const call = client.callTool(
        {
          name: 'add_node',
          arguments: { canvasId: 'cv1', type: 'image_gen', x: 0, y: 0 },
        },
        undefined,
        { timeout: CANVAS_LOCK_RENEW_MS * 100 }, // 假时钟推进时别让客户端自己超时
      );
      // 等调用真正进到工具里
      while (invoke.mock.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      expect(svc.lockForWrite).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(CANVAS_LOCK_RENEW_MS * 3);
      expect(svc.lockForWrite).toHaveBeenCalledTimes(4);
      finish('{"ok":true}');
      await call;
      await jest.advanceTimersByTimeAsync(CANVAS_LOCK_RENEW_MS * 3);
      expect(svc.lockForWrite).toHaveBeenCalledTimes(4); // 调用结束就不再续
      expect(invoke).toHaveBeenCalledWith(
        { type: 'image_gen', x: 0, y: 0 },
        { signal: expect.any(AbortSignal) as unknown },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('调用被取消：回「调用已取消」，不当成内部错误', async () => {
    const svc = fakeSvc();
    const ac = new AbortController();
    withFakeTool(
      svc,
      'add_node',
      jest.fn(() => {
        ac.abort();
        return Promise.reject(new Error('Aborted'));
      }),
    );
    const server = buildCanvasMcpServer(
      svc as unknown as McpCanvasService,
      principal(['canvas:read', 'canvas:write']),
      ac.signal,
    );
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const r = await client.callTool({
      name: 'add_node',
      arguments: { canvasId: 'cv1', type: 'image_gen', x: 0, y: 0 },
    });
    expect(r.isError).toBe(true);
    const out = JSON.stringify(r.content);
    expect(out).toContain('调用已取消');
    expect(out).not.toContain(INTERNAL_ERROR_MESSAGE);
  });

  it('wait_for_generations 照旧接受 timeoutSeconds=60（实际等多久由服务端封顶）', async () => {
    const svc = fakeSvc();
    svc.waitForGenerations.mockResolvedValue({ done: true, generations: [] });
    const client = await connect(svc, ['canvas:read']);
    const r = await client.callTool({
      name: 'wait_for_generations',
      arguments: { canvasId: 'cv1', generationIds: ['g1'], timeoutSeconds: 60 },
    });
    expect(r.isError).toBeFalsy();
    expect(svc.waitForGenerations).toHaveBeenCalledWith(
      expect.anything(),
      'cv1',
      ['g1'],
      60,
      expect.any(AbortSignal),
    );
  });

  it('import_asset 把中止信号交给下载（取消后不再落库）', async () => {
    const svc = fakeSvc();
    svc.importAsset.mockResolvedValue({ versionId: 'v1' });
    const client = await connect(svc, ['canvas:read', 'canvas:write']);
    await client.callTool({
      name: 'import_asset',
      arguments: { canvasId: 'cv1', url: 'https://example.com/a.png' },
    });
    expect(svc.importAsset).toHaveBeenCalledWith(
      expect.anything(),
      'cv1',
      'https://example.com/a.png',
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('读的共享工具只做归属校验、不上锁', async () => {
    const svc = fakeSvc();
    svc.assertAccess.mockRejectedValueOnce(
      new BusinessException(ErrorCodes.CANVAS_NOT_FOUND),
    );
    const client = await connect(svc, ['canvas:read']);
    const r = await client.callTool({
      name: 'list_media_models',
      arguments: { canvasId: 'cv-other', type: 'image' },
    });
    expect(r.isError).toBe(true);
    expect(svc.lockForWrite).not.toHaveBeenCalled();
  });

  it('create_canvas 回 canvasId 与 canvasUrl，并提示先在预览里打开', async () => {
    const client = await connect(fakeSvc(), ['canvas:write']);
    const r = await client.callTool({ name: 'create_canvas', arguments: {} });
    expect(r.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          canvasId: 'cv1',
          canvasUrl: 'http://localhost:3100/canvas/cv1',
        }),
      },
    ]);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === 'create_canvas',
    );
    expect(tool?.description).toMatch(/预览.*canvasUrl/);
    expect(client.getInstructions()).toMatch(/预览.*canvasUrl/);
  });
});
