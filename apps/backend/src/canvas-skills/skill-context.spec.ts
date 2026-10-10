import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  CANVAS_SKILLS_PROMPT,
  SKILL_INVOCATION_TYPE,
  SKILLS_LISTING_MARKER,
  SKILLS_LISTING_TYPE,
  buildSkillInvocation,
  buildSkillMd,
  buildSkillsListing,
  buildSkillsListingUpdate,
  parseSlashCommand,
  planSkillContext,
} from './skill-context';
import { parseSkillMd } from '../skills/skill-parser';

const creator = {
  name: 'skills-creator',
  description: '创建技能',
  files: {
    'SKILL.md':
      '---\nname: skills-creator\ndescription: 创建技能\n---\n\n先读 `./references/canvas-capabilities.md`',
  },
};
const teaser = {
  name: 'product-teaser',
  description: '产品预告片',
  files: {
    'SKILL.md': '---\nname: product-teaser\ndescription: x\n---\n\n步骤',
  },
};

describe('parseSlashCommand', () => {
  it('解析名称与参数', () => {
    expect(parseSlashCommand('/product-teaser 做一条耳机的')).toEqual({
      name: 'product-teaser',
      args: '做一条耳机的',
    });
    expect(parseSlashCommand('  /skills-creator\n多行\n输入 ')).toEqual({
      name: 'skills-creator',
      args: '多行\n输入',
    });
    expect(parseSlashCommand('/skills-creator')).toEqual({
      name: 'skills-creator',
      args: '',
    });
  });

  it('不是规范的 /名称 开头就不算调用', () => {
    expect(parseSlashCommand('帮我 /skills-creator')).toBeNull();
    expect(parseSlashCommand('/Skills-Creator x')).toBeNull();
    expect(parseSlashCommand('/-bad x')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
  });
});

describe('buildSkillsListing', () => {
  it('同一组技能逐字相同（比对是否变化靠全文相等）', () => {
    expect(buildSkillsListing([creator, teaser])).toBe(
      buildSkillsListing([creator, teaser]),
    );
  });

  it('以标记开头、每个技能一行、多行说明压成一行', () => {
    const text = buildSkillsListing([
      { name: 'a', description: '第一行\n第二行' },
    ]);
    expect(text.startsWith(SKILLS_LISTING_MARKER)).toBe(true);
    expect(text).toContain('- a：第一行 第二行');
  });

  it('没有技能时也给出明确说法', () => {
    expect(buildSkillsListing([])).toContain('（暂无可用技能）');
  });
});

describe('buildSkillMd', () => {
  it('产出能被解析回来的规范 frontmatter（说明里有冒号/引号也不坏）', () => {
    const md = buildSkillMd(
      'teaser',
      '做预告片: 用于 "产品" 场景',
      '# 正文\n步骤',
    );
    const parsed = parseSkillMd(md, 'fallback');
    expect(parsed.name).toBe('teaser');
    expect(md).toContain('description: "做预告片: 用于 \\"产品\\" 场景"');
    expect(parsed.body).toBe('# 正文\n步骤');
  });

  it('模型自带的 frontmatter 被替换，不会出现两段', () => {
    const md = buildSkillMd(
      'teaser',
      'd',
      '---\nname: other\ndescription: y\n---\n\n正文',
    );
    expect(md.match(/^---$/gm)).toHaveLength(2);
    expect(md).toContain('name: teaser');
    expect(md).not.toContain('name: other');
  });
});

describe('planSkillContext', () => {
  const listing = buildSkillsListing([creator, teaser]);

  it('清单没变、也没有 /调用 → 什么都不写（历史逐字不变）', () => {
    expect(
      planSkillContext({
        listing,
        lastListing: listing,
        userText: '做一条视频',
        alreadyInvoked: false,
        skills: [creator, teaser],
      }),
    ).toEqual([]);
  });

  it('清单变了（或从没写过）→ 写一份新的', () => {
    const rows = planSkillContext({
      listing,
      lastListing: null,
      userText: '做一条视频',
      alreadyInvoked: false,
      skills: [creator, teaser],
    });
    expect(rows).toEqual([{ type: SKILLS_LISTING_TYPE, text: listing }]);
  });

  it('/技能名 → 追加 SKILL.md 全文，相对路径改写成 /skills/ 绝对路径', () => {
    const rows = planSkillContext({
      listing,
      lastListing: listing,
      userText: '/skills-creator 做个预告片技能',
      alreadyInvoked: false,
      skills: [creator, teaser],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(SKILL_INVOCATION_TYPE);
    expect(rows[0].name).toBe('skills-creator');
    expect(rows[0].text).toContain('本次输入：做个预告片技能');
    expect(rows[0].text).toContain(
      '`/skills/skills-creator/references/canvas-capabilities.md`',
    );
  });

  it('同一条消息已经注入过（重试 / 续跑）→ 不重复', () => {
    expect(
      planSkillContext({
        listing,
        lastListing: listing,
        userText: '/skills-creator x',
        alreadyInvoked: true,
        skills: [creator],
      }),
    ).toEqual([]);
  });

  it('调用不存在 / 已停用的技能 → 不注入', () => {
    expect(
      planSkillContext({
        listing,
        lastListing: listing,
        userText: '/nope x',
        alreadyInvoked: false,
        skills: [creator],
      }),
    ).toEqual([]);
  });

  it('清单在前、调用在后', () => {
    const rows = planSkillContext({
      listing,
      lastListing: null,
      userText: '/product-teaser 耳机',
      alreadyInvoked: false,
      skills: [creator, teaser],
    });
    expect(rows.map((r) => r.type)).toEqual([
      SKILLS_LISTING_TYPE,
      SKILL_INVOCATION_TYPE,
    ]);
  });
});

describe('buildSkillsListingUpdate（运行中清单变化）', () => {
  it('与最后一份相同 → 不更新 state', async () => {
    const listing = buildSkillsListing([creator]);
    const state = {
      messages: [new HumanMessage('做视频'), new HumanMessage(listing)],
    };
    await expect(
      buildSkillsListingUpdate(state, () => Promise.resolve(listing)),
    ).resolves.toBeUndefined();
  });

  it('变了 → 只追加一条新的，既有消息原样保留（前缀 append-only）', async () => {
    const before = buildSkillsListing([creator]);
    const after = buildSkillsListing([creator, teaser]);
    const messages = [
      new HumanMessage('做视频'),
      new HumanMessage(before),
      new AIMessage('好的'),
    ];
    const snapshot = messages.map((m) => m.text);
    const update = await buildSkillsListingUpdate({ messages }, () =>
      Promise.resolve(after),
    );
    expect(update?.messages).toHaveLength(1);
    expect(update?.messages[0].text).toBe(after);
    expect(messages.map((m) => m.text)).toEqual(snapshot);
  });

  it('没有提供器 → 不动', async () => {
    await expect(
      buildSkillsListingUpdate({ messages: [] }),
    ).resolves.toBeUndefined();
  });
});

describe('系统提示里的技能说明', () => {
  it('是固定文本：不含任何技能名，不随技能库变化', () => {
    expect(CANVAS_SKILLS_PROMPT).not.toContain('product-teaser');
    expect(CANVAS_SKILLS_PROMPT).toContain('read_file');
    expect(CANVAS_SKILLS_PROMPT).toContain('save_skill');
  });

  it('调用文本带标记与输入', () => {
    const text = buildSkillInvocation('a', 'BODY', '');
    expect(text.startsWith('## 已调用技能：a')).toBe(true);
    expect(text).toContain('本次输入：（无，按技能说明执行）');
    expect(text.endsWith('BODY')).toBe(true);
  });
});
