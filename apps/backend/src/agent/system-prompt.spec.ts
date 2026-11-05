import { buildSystemPrompt } from './backend-prompt';

/**
 * 锁住 backend 拼出的系统提示逐字不变：agent-core 抽取时把提示词拆成「通用段 + 宿主段」，
 * backend 这边必须拼回与拆分前完全相同的文本（快照在拆分前生成）。
 */
describe('backend 系统提示快照', () => {
  it('无沙箱', () => {
    expect(buildSystemPrompt()).toMatchSnapshot();
  });

  it('有沙箱（/workspace）', () => {
    expect(buildSystemPrompt('/workspace')).toMatchSnapshot();
  });
});
