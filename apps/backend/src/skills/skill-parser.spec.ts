import { parseSkillMd, validateSkill } from './skill-parser';

describe('parseSkillMd', () => {
  it('解析 frontmatter name/description 与正文', () => {
    const raw = `---\nname: docx\ndescription: Word 文档处理\n---\n# 正文`;
    expect(parseSkillMd(raw, 'docx')).toEqual({
      name: 'docx',
      description: 'Word 文档处理',
      body: '# 正文',
    });
  });
  it('无 frontmatter 时回退目录名', () => {
    expect(parseSkillMd('正文', 'fallback').name).toBe('fallback');
  });
});

describe('validateSkill', () => {
  const ok = { name: 'docx', description: 'x', dirName: 'docx' };
  it('合法技能通过', () => expect(validateSkill(ok)).toEqual([]));
  it('name 必须小写字母数字连字符且 ≤64', () => {
    expect(validateSkill({ ...ok, name: 'Bad_Name' })).not.toEqual([]);
    expect(validateSkill({ ...ok, name: 'a'.repeat(65) })).not.toEqual([]);
  });
  it('name 必须与目录名一致', () => {
    expect(validateSkill({ ...ok, dirName: 'other' })).not.toEqual([]);
  });
  it('description 必填且 ≤1024', () => {
    expect(validateSkill({ ...ok, description: '' })).not.toEqual([]);
    expect(validateSkill({ ...ok, description: 'a'.repeat(1025) })).not.toEqual([]);
  });
  it('可选 compatibility ≤500', () => {
    expect(validateSkill({ ...ok, compatibility: 'a'.repeat(501) })).not.toEqual([]);
    expect(validateSkill({ ...ok, compatibility: 'needs internet' })).toEqual([]);
  });
});
