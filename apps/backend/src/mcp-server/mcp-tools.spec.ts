import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCanvasTools as createSharedCanvasTools } from '@agent-test/agent-core/canvas/canvas-tools';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import type { McpCanvasService } from './mcp-canvas.service';
import type { McpPrincipal } from './mcp-grant.service';
import type { McpScope } from './mcp-server.config';
import {
  adaptDescription,
  buildCanvasMcpServer,
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
