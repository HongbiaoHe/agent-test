import type { CanvasService } from './canvas.service';
import type { MediaService } from '../media/media.service';
import { createCanvasTools } from './canvas.tools';

/**
 * add_node 的必填参数校验。
 *
 * 起因是实测里模型漏传了 type（只给了 label/text/x/y）：交给 zod 直接拒的话，
 * 报错会以一大坨带堆栈的异常进对话历史、废掉一整轮。改成 handler 里返回一句话之后，
 * 这里锁住两件事——漏传要有明确回话且**不建节点**，传了要照常建。
 */
describe('add_node 的 type 校验', () => {
  const applyOp = jest.fn();
  const tools = createCanvasTools(
    // cast-at-injection：只用到 applyOp，其余方法本用例不触达
    { applyOp } as unknown as CanvasService,
    {} as unknown as MediaService,
    { sessionId: 's1', userId: 'u1' },
  );
  const addNode = tools.find((t) => t.name === 'add_node');

  beforeEach(() => applyOp.mockReset());

  it('漏传 type：回一句能照做的话，且不落任何 op', async () => {
    const out = await addNode!.invoke({
      label: '分镜',
      text: '正文',
      x: 0,
      y: 0,
    });

    expect(applyOp).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain('type');
    // 取值范围要列出来，模型才知道补什么
    expect(parsed.error).toContain('video_concat');
  });

  it('传了 type：照常建节点', async () => {
    applyOp.mockResolvedValue({
      patch: { op: 'add_node', node: { id: 'cmtjabc123456' } },
      revision: 7,
    });

    const out = await addNode!.invoke({ type: 'text', text: '正文' });

    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({ op: 'add_node', type: 'text' }),
    );
    expect(JSON.parse(out)).toMatchObject({ revision: 7 });
  });

  it('type 值非法仍由 schema 拦下（枚举照旧生效，只是不再管"缺失"）', async () => {
    // 越过 TS 的静态检查喂一个不存在的类型：这正是运行期要靠 zod 拦的那类输入
    const bad = { type: 'audio_gen' } as unknown as { type: 'text' };
    await expect(addNode!.invoke(bad)).rejects.toThrow();
    expect(applyOp).not.toHaveBeenCalled();
  });
});
