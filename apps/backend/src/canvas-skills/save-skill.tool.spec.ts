import { createSaveSkillTool } from './save-skill.tool';

describe('save_skill 工具', () => {
  const input = { name: 'teaser', description: 'd', instructions: '# 步骤' };

  it('保存成功 → 回名称与调用方式', async () => {
    const tool = createSaveSkillTool(() =>
      Promise.resolve({
        ok: true,
        name: 'teaser',
        created: true,
        skill: {
          name: 'teaser',
          description: 'd',
          kind: 'user',
          enabled: true,
          updatedAt: null,
          files: { 'SKILL.md': 'x' },
        },
      }),
    );
    const out = JSON.parse(String(await tool.invoke(input))) as {
      ok: boolean;
      usage: string;
    };
    expect(out).toMatchObject({ ok: true, usage: '/teaser <需求>' });
  });

  it('校验不过 → 把错误交回模型', async () => {
    const tool = createSaveSkillTool(() =>
      Promise.resolve({ ok: false, errors: ['名称不合法', '正文太长'] }),
    );
    expect(JSON.parse(String(await tool.invoke(input)))).toEqual({
      error: '名称不合法；正文太长',
    });
  });

  it('存库抛异常 → 转成一句错误，不让异常拖垮整轮运行', async () => {
    const tool = createSaveSkillTool(() =>
      Promise.reject(new Error('Data too long for column content')),
    );
    const out = JSON.parse(String(await tool.invoke(input))) as {
      error: string;
    };
    expect(out.error).toContain('保存失败');
    expect(out.error).toContain('Data too long');
  });
});
