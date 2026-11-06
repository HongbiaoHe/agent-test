import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateConversationDto } from './update-conversation.dto';

/** 与全局 ValidationPipe({ whitelist, transform }) 同一套：先 transform 再校验。 */
async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateConversationDto, body);
  const errors = await validate(dto, { whitelist: true });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('UpdateConversationDto', () => {
  it('只传 pinned / 只传 title 都合法', async () => {
    expect((await check({ pinned: true })).fields).toEqual([]);
    expect((await check({ title: '新名字' })).fields).toEqual([]);
  });

  it('title 去掉首尾空白；去空白后按 200 字限长', async () => {
    const { dto, fields } = await check({ title: `  ${'a'.repeat(200)}  ` });
    expect(fields).toEqual([]);
    expect(dto.title).toBe('a'.repeat(200));
    expect((await check({ title: 'a'.repeat(201) })).fields).toEqual(['title']);
  });

  it('modeId 可以是字符串或 null（回通用模式）；非字符串拒绝', async () => {
    expect((await check({ modeId: 'm1' })).fields).toEqual([]);
    const nulled = await check({ modeId: null });
    expect(nulled.fields).toEqual([]);
    expect(nulled.dto.modeId).toBeNull();
    expect((await check({ modeId: 1 })).fields).toEqual(['modeId']);
  });

  it('title 非字符串、pinned 非布尔 → 拒绝', async () => {
    expect((await check({ title: 123 })).fields).toEqual(['title']);
    expect((await check({ pinned: 'yes' })).fields).toEqual(['pinned']);
  });
});
