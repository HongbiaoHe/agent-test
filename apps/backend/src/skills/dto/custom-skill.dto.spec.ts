import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCustomSkillDto } from './custom-skill.dto';

/** 与全局 ValidationPipe({ whitelist, transform }) 同一套：先 transform 再校验。 */
async function fields(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateCustomSkillDto, body);
  const errors = await validate(dto, { whitelist: true });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('CreateCustomSkillDto', () => {
  it('合法输入通过，首尾空白去掉', async () => {
    const { dto, fields: f } = await fields({
      name: ' my-skill ',
      description: ' 说明 ',
      body: '\n# 正文\n',
    });
    expect(f).toEqual([]);
    expect([dto.name, dto.description, dto.body]).toEqual([
      'my-skill',
      '说明',
      '# 正文',
    ]);
  });

  it('名字不合规（大写 / 下划线 / 连字符开头）→ 拒绝', async () => {
    for (const name of ['MySkill', 'my_skill', '-skill', '']) {
      expect(
        (await fields({ name, description: 'd', body: 'b' })).fields,
      ).toEqual(['name']);
    }
  });

  it('说明或正文为空、超长 → 拒绝', async () => {
    expect(
      (await fields({ name: 'a', description: '  ', body: 'b' })).fields,
    ).toEqual(['description']);
    expect(
      (await fields({ name: 'a', description: 'd', body: 'x'.repeat(100_001) }))
        .fields,
    ).toEqual(['body']);
  });
});
