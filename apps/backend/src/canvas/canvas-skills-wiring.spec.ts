/**
 * 画布 agent 装配里的技能接线——重点是缓存前缀：系统提示不能随技能库变化。
 *
 * deepagents / langchain 用 jest.mock 换成记录参数的桩：既能拿到传给 createDeepAgent 的
 * 真实参数，又避开它们那串 ESM-only 依赖（jest 的 CJS 运行时加载不了）。
 */
const createDeepAgent = jest.fn((params: Record<string, unknown>) => params);
jest.mock('deepagents', () => ({
  createDeepAgent: (p: Record<string, unknown>) => createDeepAgent(p),
  StateBackend: class StateBackend {},
}));
jest.mock('langchain', () => ({
  createMiddleware: (cfg: Record<string, unknown>) => cfg,
  modelCallLimitMiddleware: () => ({ name: 'modelCallLimit' }),
  toolCallLimitMiddleware: () => ({ name: 'toolCallLimit' }),
}));
jest.mock('langchain/chat_models/universal', () => ({
  initChatModel: () => Promise.resolve({}),
}));
jest.mock('@google/genai', () => ({
  ...jest.requireActual<object>('@google/genai'),
  GoogleGenAI: class {},
}));
jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class {},
}));

import { HumanMessage } from '@langchain/core/messages';
import { buildCanvasAgent } from './canvas.agent.factory';
import {
  CANVAS_SKILLS_PROMPT,
  buildSkillsListing,
} from '../canvas-skills/skill-context';

type Params = {
  systemPrompt: string;
  skills?: unknown;
  backend: unknown;
  interruptOn?: Record<string, unknown>;
  middleware: {
    name: string;
    beforeModel?: (s: unknown, r?: unknown) => unknown;
  }[];
};

async function build(
  listing: string | null,
  approvalMode: 'review' | 'auto' = 'review',
) {
  createDeepAgent.mockClear();
  const backend = { kind: 'skills-backend' };
  await buildCanvasAgent({
    tools: [],
    approvalMode,
    ...(listing === null
      ? {}
      : {
          skills: {
            backend: backend as never,
            listing: () => Promise.resolve(listing),
          },
        }),
  });
  return {
    params: createDeepAgent.mock.calls[0][0] as unknown as Params,
    backend,
  };
}

describe('画布 agent 的技能接线', () => {
  it('系统提示与技能库无关：有无技能、技能多少，逐字相同（缓存前缀不受影响）', async () => {
    const a = await build(null);
    const b = await build(
      buildSkillsListing([{ name: 'x', description: 'd' }]),
    );
    const c = await build(
      buildSkillsListing([
        { name: 'x', description: 'd' },
        { name: 'y', description: 'e' },
      ]),
    );
    expect(b.params.systemPrompt).toBe(a.params.systemPrompt);
    expect(c.params.systemPrompt).toBe(a.params.systemPrompt);
    expect(a.params.systemPrompt).toContain(CANVAS_SKILLS_PROMPT);
    // 清单内容一个字都不进系统提示
    expect(c.params.systemPrompt).not.toContain('- y：');
  });

  it('不用 deepagents 自带的 skills 参数（它会把清单拼进系统提示）', async () => {
    const { params } = await build(buildSkillsListing([]));
    expect(params.skills).toBeUndefined();
  });

  it('/skills/ 文件后端用传进来的只读技能库', async () => {
    const { params, backend } = await build(buildSkillsListing([]));
    expect(params.backend).toBe(backend);
  });

  it('清单经 beforeModel 追加为消息，排在实时画布状态之前', async () => {
    const listing = buildSkillsListing([{ name: 'x', description: 'd' }]);
    const { params } = await build(listing);
    const names = params.middleware.map((m) => m.name);
    expect(names.indexOf('canvasSkillsListingMiddleware')).toBeLessThan(
      names.indexOf('canvasLiveStateMiddleware'),
    );
    const mw = params.middleware.find(
      (m) => m.name === 'canvasSkillsListingMiddleware',
    );
    const update = (await mw?.beforeModel?.({
      messages: [new HumanMessage('做视频')],
    })) as { messages: HumanMessage[] } | undefined;
    expect(update?.messages[0].text).toBe(listing);
    // 已经是最新那份 → 不再追加
    await expect(
      mw?.beforeModel?.({ messages: [new HumanMessage(listing)] }),
    ).resolves.toBeUndefined();
  });

  it('save_skill：审批模式要确认，全自动模式不拦', async () => {
    const review = await build(buildSkillsListing([]), 'review');
    expect(review.params.interruptOn?.save_skill).toEqual({
      allowedDecisions: ['approve', 'reject'],
    });
    const auto = await build(buildSkillsListing([]), 'auto');
    expect(auto.params.interruptOn).toBeUndefined();
  });
});
