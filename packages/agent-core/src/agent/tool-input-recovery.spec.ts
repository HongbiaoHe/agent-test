import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { createAgent, createMiddleware, fakeModel } from 'langchain';
import { z } from 'zod';
import { recoverToolInputError } from './tool-input-recovery';

/** 提示词限 10 字符的工具；记录真正执行时收到的参数 */
function shortTool() {
  const calls: string[] = [];
  const t = tool(
    ({ prompt }: { prompt: string }) => {
      calls.push(prompt);
      return `ok:${prompt}`;
    },
    {
      name: 'gen',
      description: 'gen',
      schema: z.object({ prompt: z.string().max(10) }),
    },
  );
  return { t, calls };
}

/** 第 1 轮发超长参数，第 2 轮改短，第 3 轮收尾 */
function scriptedModel() {
  return fakeModel()
    .respondWithTools([
      { name: 'gen', args: { prompt: 'x'.repeat(50) }, id: 'c1' },
    ])
    .respondWithTools([{ name: 'gen', args: { prompt: 'short' }, id: 'c2' }])
    .respond(new AIMessage('done'));
}

/** 模拟 deepagents：挂了 wrapToolCall 的中间件，LangChain 会把工具入参错误当中间件错误直接抛出 */
const passThrough = createMiddleware({
  name: 'passThrough',
  wrapToolCall: (request, handler) => handler(request),
});

describe('工具入参校验自愈', () => {
  it('对照：有 wrapToolCall 中间件、没有自愈时，入参校验失败让整轮抛错', async () => {
    const { t } = shortTool();
    const agent = createAgent({
      model: scriptedModel(),
      tools: [t],
      middleware: [passThrough],
    });
    await expect(
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    ).rejects.toThrow('did not match expected schema');
  });

  it('自愈：校验问题作为工具结果回给模型，模型改参后重试成功，整轮正常结束', async () => {
    const { t, calls } = shortTool();
    const recovery = createMiddleware({
      name: 'recovery',
      wrapToolCall: recoverToolInputError,
    });
    const agent = createAgent({
      model: scriptedModel(),
      tools: [t],
      middleware: [passThrough, recovery],
    });
    const out = await agent.invoke({
      messages: [{ role: 'user', content: 'go' }],
    });

    const toolMsgs = out.messages.filter((m) => ToolMessage.isInstance(m));
    expect(toolMsgs).toHaveLength(2);
    const [first, second] = toolMsgs;
    expect(first.status).toBe('error');
    expect(first.tool_call_id).toBe('c1');
    const body = z
      .object({
        error: z.string(),
        tool: z.string(),
        issues: z.string(),
        hint: z.string(),
      })
      .parse(JSON.parse(first.text));
    expect(body).toMatchObject({ error: 'invalid_arguments', tool: 'gen' });
    expect(body.issues).toContain('prompt');
    expect(body.issues).not.toContain('did not match expected schema');
    expect(second.text).toBe('ok:short');
    // 超长那次没有真正执行
    expect(calls).toEqual(['short']);
    expect(out.messages.at(-1)?.text).toBe('done');
  });

  it('工具执行中的异常不吞，原样抛出', async () => {
    const boom = tool(
      () => {
        throw new Error('boom');
      },
      {
        name: 'gen',
        description: 'gen',
        schema: z.object({ prompt: z.string() }),
      },
    );
    await expect(
      recoverToolInputError({ toolCall: { name: 'gen', id: 'c1' } }, () =>
        boom.invoke({ prompt: 'a' }),
      ),
    ).rejects.toThrow('boom');
  });
});

describe('工具入参校验自愈（真实 deepagents 中间件栈）', () => {
  it('createDeepAgent 下同样自愈：错误回给模型、改参重试成功', async () => {
    const { t, calls } = shortTool();
    const recovery = createMiddleware({
      name: 'recovery',
      wrapToolCall: recoverToolInputError,
    });
    const agent = createDeepAgent({
      model: scriptedModel(),
      tools: [t],
      middleware: [recovery],
    });
    const out = await agent.invoke({
      messages: [{ role: 'user', content: 'go' }],
    });
    const toolMsgs = out.messages.filter((m) => ToolMessage.isInstance(m));
    expect(toolMsgs.map((m) => m.status)).toEqual(['error', 'success']);
    expect(calls).toEqual(['short']);
    expect(out.messages.at(-1)?.text).toBe('done');
  });

  it('对照：createDeepAgent 不挂自愈时整轮抛错', async () => {
    const { t } = shortTool();
    const agent = createDeepAgent({ model: scriptedModel(), tools: [t] });
    await expect(
      agent.invoke({ messages: [{ role: 'user', content: 'go' }] }),
    ).rejects.toThrow('did not match expected schema');
  });
});
