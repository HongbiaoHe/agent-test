import type { BaseStore } from '@langchain/langgraph';
import { absolutizeRefPaths, toFileData } from './skill-files';
import type { SkillDef } from './skills.service';

/**
 * worker 每 run 前调用：把该用户生效技能 diff 同步进 store（put 变更、delete 消失的键）。
 *
 * 为什么用 diff 而不是每次全量覆盖：
 * - toFileData 写入时间戳（created_at / modified_at）。全量覆盖会刷新所有时间戳，
 *   破坏 deepagents 模型侧感知文件"是否刚写入"的语义，也造成不必要的写放大。
 * - diff 语义：delete 消失的键、put 内容有变化的键、跳过内容完全相同的键（保留原时间戳）。
 *
 * namespace 格式：[userId, 'skills']，key = /skills/<name>/<rel>（与 StoreBackend 约定一致）。
 * SKILL.md 的相对路径引用经 absolutizeRefPaths 改写为绝对路径，确保模型调用 read_file 时精确命中。
 */
export async function seedSkillsStore(
  store: BaseStore,
  userId: string,
  defs: SkillDef[],
): Promise<void> {
  const ns = [userId, 'skills'];
  const now = new Date().toISOString();

  // 构建"期望状态"：Map<虚拟路径, 文件内容字符串>
  const want = new Map<string, string>();
  for (const def of defs) {
    for (const [rel, content] of Object.entries(def.files)) {
      // 只对 SKILL.md 做相对路径改写，其余文件（如引用的子文件）保持原样
      const injected = rel === 'SKILL.md' ? absolutizeRefPaths(def.name, content) : content;
      want.set(`/skills/${def.name}/${rel}`, injected);
    }
  }

  // 查出现有键（默认 limit=10 不够用，显式指定 1000；超出时抛错提醒调大）
  const existing = await store.search(ns, { limit: 1000 });
  if (existing.length >= 1000) {
    throw new Error('skills namespace 超过 1000 键，diff 会漏删——先提高 limit');
  }

  // delete：现有键中不再出现在期望状态里的，说明该技能已被移除或禁用
  for (const item of existing) {
    if (!want.has(String(item.key))) await store.delete(ns, String(item.key));
  }

  // put：新增或内容有变化的键；内容相同则跳过，保留原时间戳（避免刷新 modified_at）
  for (const [key, content] of want) {
    const cur = existing.find((i) => String(i.key) === key);
    const lines = (cur?.value as { content?: string[] } | undefined)?.content;
    if (lines && lines.join('\n') === content) continue;
    await store.put(ns, key, toFileData(content, now));
  }
}
