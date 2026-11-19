import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const createDeepAgent = jest.fn((_opts: unknown) => ({ kind: 'agent' }));
const initChatModel = jest.fn(async (name: string) => ({
  kind: 'model',
  name,
}));
jest.mock('deepagents', () => ({ createDeepAgent, StateBackend: class {} }));
jest.mock('langchain/chat_models/universal', () => ({ initChatModel }));
jest.mock('langchain', () => ({
  createMiddleware: (m: { name: string }) => m,
  modelCallLimitMiddleware: (o: unknown) => ({ name: 'modelCallLimit', o }),
  toolCallLimitMiddleware: (o: unknown) => ({ name: 'toolCallLimit', o }),
}));

import { buildAgent } from './agent.factory';

const mk = (name: string) =>
  tool(() => name, { name, description: name, schema: z.object({}) });
const backend = { kind: 'backend' } as never;

type Call = {
  systemPrompt: string;
  tools: { name: string }[];
  interruptOn: Record<string, unknown>;
  skills: string[];
  middleware: { name: string }[];
  model: unknown;
  backend: unknown;
  subagents: {
    name: string;
    tools: { name: string }[];
    model: unknown;
    middleware: { name: string }[];
    interruptOn?: Record<string, unknown>;
    skills?: string[];
  }[];
};
const lastCall = () => createDeepAgent.mock.calls.at(-1)![0] as Call;

beforeEach(() => jest.clearAllMocks());

describe('buildAgent', () => {
  it('原样透传 systemPrompt / backend；tools = [ask_user, ...传入]；skills 目录补斜杠', async () => {
    await buildAgent({
      systemPrompt: 'SP',
      tools: [mk('gen')],
      backend,
      skillsDir: '/workspace/skills',
      model: 'deepseek:deepseek-flash',
    });
    const c = lastCall();
    expect(c.systemPrompt).toBe('SP');
    expect(c.backend).toBe(backend);
    expect(c.tools.map((t) => t.name)).toEqual(['ask_user', 'gen']);
    expect(c.skills).toEqual(['/workspace/skills/']);
    expect(initChatModel).toHaveBeenCalledWith(
      'deepseek:deepseek-flash',
      expect.anything(),
    );
  });

  it('interruptOn = 装配表 + 宿主覆盖（同名以覆盖为准）+ ask_user 固定决策集', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      skillsDir: '/skills',
      interruptOn: { mail: true, write_file: true },
      interruptOnOverride: { write_file: false, execute: true },
    });
    expect(lastCall().interruptOn).toEqual({
      mail: true,
      write_file: false,
      execute: true,
      ask_user: { allowedDecisions: ['approve', 'edit'] },
    });
  });

  it('中间件顺序：守护 → 动态上下文 → 技能必读（最靠后 = 离模型最近）→ 非 Gemini 才有净化', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      skillsDir: '/skills',
      model: 'deepseek:deepseek-flash',
      guardrails: { modelCallLimit: 500, toolCallLimit: 2000 },
    });
    expect(lastCall().middleware.map((m) => m.name)).toEqual([
      'modelCallLimit',
      'toolCallLimit',
      'dynamicContextMiddleware',
      'skillReadPolicyMiddleware',
      'portableContentMiddleware',
      'invalidToolCallMiddleware',
      'toolInputRecoveryMiddleware',
    ]);
  });

  it('Gemini 模型不加净化；不传 guardrails 就没有守护', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      skillsDir: '/skills',
      model: 'google-genai:gemini-3.8-flash',
    });
    expect(lastCall().middleware.map((m) => m.name)).toEqual([
      'dynamicContextMiddleware',
      'skillReadPolicyMiddleware',
      'invalidToolCallMiddleware',
      'toolInputRecoveryMiddleware',
    ]);
  });

  it('全自动宿主（设计 agent）：不挂技能、不要 ask_user → 没有 skills / 技能必读 / ask_user / HITL；宿主中间件排在守护之后', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [mk('add_layers')],
      backend,
      askUser: false,
      model: 'gemini-3.8-flash',
      guardrails: { modelCallLimit: 80, toolCallLimit: 200 },
      // 只有 name 的对象本身就满足 AgentMiddleware 类型（钩子都是可选的），不需要断言
      middleware: [{ name: 'designPreviewInjection' }],
    });
    const c = lastCall();
    expect(c.tools.map((t) => t.name)).toEqual(['add_layers']);
    expect(c.skills).toBeUndefined();
    expect(c.interruptOn).toBeUndefined();
    expect(c.middleware.map((m) => m.name)).toEqual([
      'modelCallLimit',
      'toolCallLimit',
      'designPreviewInjection',
      'dynamicContextMiddleware',
      'invalidToolCallMiddleware',
      'toolInputRecoveryMiddleware',
    ]);
    // 裸 gemini 名按 google-genai 装配，思考档位 auto（与原设计 agent 一致）
    expect(initChatModel).toHaveBeenCalledWith('gemini-3.8-flash', {
      modelProvider: 'google-genai',
      thinkingConfig: { includeThoughts: true },
    });
  });

  it('不要 ask_user 但宿主有审批项：照常挂 HITL，只是没有 ask_user', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      askUser: false,
      interruptOn: { mail: true },
    });
    expect(lastCall().interruptOn).toEqual({ mail: true });
  });

  it('modelInstance 给了就不调 initChatModel，直接用实例（并保守地加净化）', async () => {
    const instance = { kind: 'instance' } as never;
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      skillsDir: '/skills',
      modelInstance: instance,
    });
    expect(initChatModel).not.toHaveBeenCalled();
    expect(lastCall().model).toBe(instance);
    expect(lastCall().middleware.map((m) => m.name)).toContain(
      'portableContentMiddleware',
    );
  });

  it('子 agent：同模型复用主实例、异模型另建；审批 = 自己的 + 宿主覆盖；勾了技能才挂技能库；都有入参自愈', async () => {
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      skillsDir: '/workspace/skills',
      model: 'google-genai:gemini-3.8-flash',
      interruptOnOverride: { write_file: true },
      subagents: [
        {
          name: '写手',
          description: 'd',
          systemPrompt: 'w',
          tools: [mk('gen')],
          interruptOn: { mail: { allowedDecisions: ['approve', 'bogus'] } },
          model: null,
          skills: true,
        },
        {
          name: '评审',
          description: 'd',
          systemPrompt: 'c',
          tools: [],
          interruptOn: {},
          model: 'deepseek:deepseek-flash',
          skills: false,
        },
      ],
    });
    const [w, c] = lastCall().subagents;
    expect(w.model).toBe(lastCall().model);
    expect(w.tools.map((t) => t.name)).toEqual(['gen']);
    expect(w.interruptOn).toEqual({
      mail: { allowedDecisions: ['approve'] },
      write_file: true,
    });
    expect(w.skills).toEqual(['/workspace/skills/']);
    expect(w.middleware.map((m) => m.name)).toEqual([
      'invalidToolCallMiddleware',
      'toolInputRecoveryMiddleware',
    ]);
    expect(initChatModel).toHaveBeenCalledWith('deepseek:deepseek-flash', {});
    expect(c.skills).toBeUndefined();
    expect(c.interruptOn).toEqual({ write_file: true });
    expect(c.middleware.map((m) => m.name)).toEqual([
      'portableContentMiddleware',
      'invalidToolCallMiddleware',
      'toolInputRecoveryMiddleware',
    ]);
  });

  it('宿主给了 resolveModel（desktop 的连接解析）：主 agent 与异模型子 agent 都经它解析，不调 initChatModel；净化按解析结果决定', async () => {
    const instances: Record<string, { kind: string }> = {};
    const resolveModel = jest.fn((ref: string | null | undefined) => {
      const model = { kind: `m:${ref}` };
      instances[String(ref)] = model;
      return Promise.resolve({
        model: model as never,
        keepsNativeBlocks: ref === 'c-gem/gemini',
      });
    });
    await buildAgent({
      systemPrompt: '',
      tools: [],
      backend,
      model: 'c-gem/gemini',
      resolveModel,
      subagents: [
        {
          name: 's1',
          description: 'd',
          systemPrompt: 'p',
          tools: [],
          interruptOn: {},
          model: 'c-gem/gemini',
          skills: false,
        },
        {
          name: 's2',
          description: 'd',
          systemPrompt: 'p',
          tools: [],
          interruptOn: {},
          model: 'c-oai/gpt-4o',
          skills: false,
        },
      ],
    });
    expect(initChatModel).not.toHaveBeenCalled();
    expect(resolveModel.mock.calls.map((c) => c[0])).toEqual([
      'c-gem/gemini',
      'c-oai/gpt-4o',
    ]);
    const c = lastCall();
    expect(c.model).toBe(instances['c-gem/gemini']);
    // Gemini 原样收原生块：主 agent 不挂净化
    expect(c.middleware.map((m) => m.name)).not.toContain(
      'portableContentMiddleware',
    );
    const [s1, s2] = c.subagents;
    expect(s1.model).toBe(instances['c-gem/gemini']);
    expect(s2.model).toBe(instances['c-oai/gpt-4o']);
    expect(s2.middleware.map((m) => m.name)).toContain(
      'portableContentMiddleware',
    );
  });
});
