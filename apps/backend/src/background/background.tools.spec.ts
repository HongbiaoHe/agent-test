jest.mock('./background.service', () => ({ BackgroundService: class {} }));
import type { GuardedSandbox } from '../agent/guarded-sandbox';
import { toToolSnapshot } from '../mcp/mcp-result';
import type { RuntimeServer } from '../mcp/mcp.service';
import type { BackgroundService } from './background.service';
import { backgroundPrompt, createBackgroundTools } from './background.tools';

const server: RuntimeServer = {
  id: 's1',
  slug: 'buzzvideo',
  name: 'BuzzVideo',
  instructions: null,
  permissions: { get_usage: 'deny' },
  tools: [
    toToolSnapshot({
      name: 'get_task',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    }),
    toToolSnapshot({ name: 'generate_image', inputSchema: { type: 'object' } }),
  ],
};

function setup(sandbox: Partial<GuardedSandbox> | null = null) {
  const bg = {
    assertCapacity: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((input: { kind: string; title: string }) =>
      Promise.resolve({ id: 'task1', kind: input.kind, title: input.title }),
    ),
    failUnexpected: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn(),
  };
  const tools = createBackgroundTools(bg as unknown as BackgroundService, {
    conversationId: 'c1',
    userId: 'u1',
    sandbox: sandbox as GuardedSandbox | null,
    mcpServers: [server],
  });
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  return { bg, tools, byName };
}

const parse = (s: unknown) => JSON.parse(String(s)) as Record<string, unknown>;

describe('createBackgroundTools', () => {
  it('无沙箱时不提供 run_in_background', () => {
    expect(setup().tools.map((t) => t.name)).toEqual([
      'watch_until',
      'schedule_wakeup',
      'cancel_background_task',
    ]);
  });

  it('watch_until：解析 arguments_json、夹紧间隔，建 watch 任务', async () => {
    const { bg, byName } = setup();
    const out = parse(
      await byName('watch_until').invoke({
        title: 'Wait cat',
        tool: 'buzzvideo__get_task',
        arguments_json: '{"taskId":"123"}',
        until_path: 'status',
        done_values: ['completed'],
        interval_seconds: 1,
      }),
    );
    expect(out).toMatchObject({ taskId: 'task1', status: 'running' });
    expect(bg.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'watch',
        spec: expect.objectContaining({
          serverId: 's1',
          toolName: 'get_task',
          args: { taskId: '123' },
          intervalSec: 5,
          failValues: [],
        }),
        timeoutMin: 30,
        firstTickMs: 5000,
      }),
    );
  });

  it('watch_until：需审批的工具不能后台轮询；未知工具 / 坏 JSON 报错', async () => {
    const { bg, byName } = setup();
    const w = byName('watch_until');
    const base = { title: 't', until_path: 'status', done_values: ['x'] };
    expect(
      parse(
        await w.invoke({
          ...base,
          tool: 'buzzvideo__generate_image',
          arguments_json: '{}',
        }),
      ).error,
    ).toMatch(/requires approval/);
    expect(
      parse(await w.invoke({ ...base, tool: 'nope__x', arguments_json: '{}' }))
        .error,
    ).toMatch(/Unknown MCP tool/);
    expect(
      parse(
        await w.invoke({
          ...base,
          tool: 'buzzvideo__get_task',
          arguments_json: '[1]',
        }),
      ).error,
    ).toMatch(/JSON object/);
    expect(bg.create).not.toHaveBeenCalled();
  });

  it('run_in_background：建任务后在沙箱里启动；启动失败判失败', async () => {
    const execute = jest.fn().mockResolvedValue({ output: 'started\n' });
    const { bg, byName } = setup({ execute });
    const out = parse(
      await byName('run_in_background').invoke({
        title: 'render',
        command: 'ffmpeg -i a b',
      }),
    );
    expect(out.taskId).toBe('task1');
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('.bg/task1/cmd.sh'),
    );

    execute.mockResolvedValue({ output: 'bash: base64: not found' });
    const bad = parse(
      await byName('run_in_background').invoke({
        title: 'render',
        command: 'x',
      }),
    );
    expect(bad.error).toMatch(/Failed to start/);
    expect(bg.failUnexpected).toHaveBeenCalled();
  });

  it('容量满时把原因回给模型', async () => {
    const { bg, byName } = setup();
    bg.assertCapacity.mockRejectedValue(new Error('max 5'));
    const out = parse(
      await byName('schedule_wakeup').invoke({
        title: 't',
        note: 'n',
        delay_minutes: 5,
      }),
    );
    expect(out.error).toBe('max 5');
  });

  it('系统提示：有沙箱才提 run_in_background', () => {
    expect(backgroundPrompt(true)).toContain('run_in_background');
    expect(backgroundPrompt(false)).not.toContain('run_in_background');
    expect(backgroundPrompt(false)).toContain('<task-notification>');
  });
});
