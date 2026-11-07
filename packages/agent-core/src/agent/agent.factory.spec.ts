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
      'toolInputRecoveryMiddleware',
    ]);
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
});
