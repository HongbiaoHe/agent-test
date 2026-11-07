/**
 * agent 模式（desktop 版，对应 backend 的 ModesService）：SQLite `agent_mode` 表的 CRUD。
 * 行数据用 zod 收窄，JSON 列（勾选的工具名 / server id / 技能名）存 TEXT；对外形状是 core 的 AgentMode。
 * 保存时校验正文里的 {{platform.xxx}} 占位符（片段库没有的拒绝，决策 2）。
 * 删模式 → 引用它的会话 mode_id 置空（回到通用模式，决策 8）。
 * 通用模式（mode_id 为 NULL）的用户覆盖存单行表 `general_mode`（id = 1）：提示词 + 新建会话的默认模型 / 思考档位。
 * 平台片段的改写存 `prompt_fragment`（一行一个内置片段）；用户自建片段存 `custom_prompt_fragment`
 * （id = custom.<名字>，创建后不可改；仍被模式或自定义的通用提示词引用时不能删）。片段正文里只能用 {{skills_dir}}。
 */
import { randomUUID } from 'node:crypto';
import {
  type AgentMode,
  type AgentModeInput,
  AgentModeInputSchema,
  AgentModeSchema,
  type GeneralModeSettings,
  GeneralModeSettingsSchema,
} from '@agent-test/agent-core/modes/mode.schema';
import {
  type CustomFragments,
  CustomFragmentIdSchema,
  findFragmentReferences,
  findInvalidFragmentVariables,
  findUnknownPlaceholders,
  type FragmentOverrides,
  FragmentTextSchema,
  FragmentTitleSchema,
  isCustomFragmentId,
  isPromptFragmentId,
  PROMPT_FRAGMENT_DEFAULTS,
  PROMPT_FRAGMENT_IDS,
  type PromptFragmentId,
  SKILLS_DIR_VARIABLE,
} from '@agent-test/agent-core/modes/prompt-fragments';
import { z } from 'zod';
import type { PromptFragmentView } from '../../shared/rpc';
import type { Db } from '../db/database';
import { hostI18n } from '../i18n';
import { transaction } from '../db/database';

const jsonStringList = z.string().transform((text, ctx): string[] => {
  const parsed = z.array(z.string()).safeParse(parseJson(text));
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'not a JSON string array' });
    return [];
  }
  return parsed.data;
});

const modeRow = z.object({
  id: z.string(),
  name: z.string(),
  system_prompt: z.string(),
  tool_names: jsonStringList,
  mcp_server_ids: jsonStringList,
  skill_names: jsonStringList,
  default_model: z.string().nullable(),
  default_thinking_level: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const fragmentRow = z.object({ id: z.string(), text: z.string() });

const customFragmentRow = z.object({ id: z.string(), title: z.string(), text: z.string() });

/** 改片段：内置片段只认 text（null = 恢复默认）；自建片段可改 title / text（text 不能为 null）。不传的字段不动 */
export interface FragmentPatch {
  text?: string | null;
  title?: string;
}

const generalRow = z.object({
  system_prompt: z.string().nullable(),
  default_model: z.string().nullable(),
  default_thinking_level: z.string().nullable(),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toMode(r: z.infer<typeof modeRow>): AgentMode {
  return AgentModeSchema.parse({
    id: r.id,
    name: r.name,
    systemPrompt: r.system_prompt,
    toolNames: r.tool_names,
    mcpServerIds: r.mcp_server_ids,
    skillNames: r.skill_names,
    defaultModel: r.default_model,
    defaultThinkingLevel: r.default_thinking_level,
  });
}

export class ModeStore {
  constructor(private readonly db: Db) {}

  /** 按名字排序（设置页列表 / 会话内选择器共用） */
  list(): AgentMode[] {
    return this.db
      .prepare('SELECT * FROM agent_mode ORDER BY name COLLATE NOCASE, created_at')
      .all()
      .map((r) => toMode(modeRow.parse(r)));
  }

  /** 不存在（已被删）返回 null：会话上残留的 modeId 按通用模式跑 */
  get(id: string): AgentMode | null {
    const r = this.db.prepare('SELECT * FROM agent_mode WHERE id = ?').get(id);
    return r ? toMode(modeRow.parse(r)) : null;
  }

  require(id: string): AgentMode {
    const m = this.get(id);
    if (!m) throw new Error(hostI18n.t('errors.modes.notFound', { id }));
    return m;
  }

  create(raw: AgentModeInput): AgentMode {
    const input = this.validate(raw);
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_mode (id, name, system_prompt, tool_names, mcp_server_ids, skill_names,
           default_model, default_thinking_level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.systemPrompt,
        JSON.stringify(input.toolNames),
        JSON.stringify(input.mcpServerIds),
        JSON.stringify(input.skillNames),
        input.defaultModel,
        input.defaultThinkingLevel,
        now,
        now,
      );
    return this.require(id);
  }

  update(id: string, raw: AgentModeInput): AgentMode {
    this.require(id);
    const input = this.validate(raw);
    this.db
      .prepare(
        `UPDATE agent_mode SET name = ?, system_prompt = ?, tool_names = ?, mcp_server_ids = ?, skill_names = ?,
           default_model = ?, default_thinking_level = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name,
        input.systemPrompt,
        JSON.stringify(input.toolNames),
        JSON.stringify(input.mcpServerIds),
        JSON.stringify(input.skillNames),
        input.defaultModel,
        input.defaultThinkingLevel,
        Date.now(),
        id,
      );
    return this.require(id);
  }

  /** 删除并把引用它的会话退回通用模式；返回受影响的会话数 */
  remove(id: string): number {
    this.require(id);
    return transaction(this.db, () => {
      const res = this.db.prepare('UPDATE conversation SET mode_id = NULL WHERE mode_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_mode WHERE id = ?').run(id);
      return Number(res.changes);
    });
  }

  /** 通用模式的用户覆盖；没存过（无行）= 全 null（提示词用 core 默认） */
  getGeneral(): GeneralModeSettings {
    const r = this.db
      .prepare('SELECT system_prompt, default_model, default_thinking_level FROM general_mode WHERE id = 1')
      .get();
    if (!r) return GeneralModeSettingsSchema.parse({});
    const row = generalRow.parse(r);
    return GeneralModeSettingsSchema.parse({
      systemPrompt: row.system_prompt,
      defaultModel: row.default_model,
      defaultThinkingLevel: row.default_thinking_level,
    });
  }

  /** 整份覆盖（upsert id = 1）；systemPrompt 为 null = 恢复默认提示词 */
  updateGeneral(raw: GeneralModeSettings): GeneralModeSettings {
    const input = GeneralModeSettingsSchema.parse(raw);
    if (input.systemPrompt !== null) this.assertKnownPlaceholders(input.systemPrompt);
    this.db
      .prepare(
        `INSERT INTO general_mode (id, system_prompt, default_model, default_thinking_level, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET system_prompt = excluded.system_prompt, default_model = excluded.default_model,
           default_thinking_level = excluded.default_thinking_level, updated_at = excluded.updated_at`,
      )
      .run(input.systemPrompt, input.defaultModel, input.defaultThinkingLevel, Date.now());
    return this.getGeneral();
  }

  /** 内置 4 个片段（按 PROMPT_FRAGMENT_IDS 顺序：生效正文 + 默认正文 + 是否改写过），其后是自建片段（按 id） */
  listFragments(): PromptFragmentView[] {
    const overrides = this.fragmentOverrides();
    return [
      ...PROMPT_FRAGMENT_IDS.map((id) => builtinView(id, overrides)),
      ...this.customRows().map(customView),
    ];
  }

  /** 改写过的片段正文（给 resolveMode）；库里残留的未知 id（core 下线了某片段）忽略 */
  fragmentOverrides(): FragmentOverrides {
    const out: FragmentOverrides = {};
    for (const r of this.db.prepare('SELECT id, text FROM prompt_fragment').all()) {
      const row = fragmentRow.parse(r);
      if (isPromptFragmentId(row.id)) out[row.id] = row.text;
    }
    return out;
  }

  /** 自建片段 id → 正文（给 resolveMode；按 id 排序，模式编辑器的插入按钮也按这个顺序） */
  customFragments(): CustomFragments {
    const out: Record<string, string> = {};
    for (const row of this.customRows()) out[row.id] = row.text;
    return out;
  }

  /** 新建自建片段：id 须为 custom.<名字> 且未被占用；正文同内置片段的规则（只能用 {{skills_dir}}） */
  createFragment(raw: { id: string; title: string; text: string }): PromptFragmentView {
    if (!CustomFragmentIdSchema.safeParse(raw.id).success) {
      throw new Error(hostI18n.t('errors.modes.fragmentInvalidId', { id: raw.id }));
    }
    if (this.customRow(raw.id)) throw new Error(hostI18n.t('errors.modes.fragmentExists', { id: raw.id }));
    const title = parseTitle(raw.title);
    assertFragmentText(raw.text);
    const now = Date.now();
    this.db
      .prepare('INSERT INTO custom_prompt_fragment (id, title, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(raw.id, title, raw.text, now, now);
    return customView(this.requireCustom(raw.id));
  }

  /**
   * 改片段。内置：text 为 null 或与默认正文相同 = 恢复默认（删行，以后 core 默认更新也能跟上），不能改 title；
   * 自建：改 title / text，text 为 null 报错（没有默认正文可恢复）。
   */
  updateFragment(id: string, patch: FragmentPatch): PromptFragmentView {
    if (isCustomFragmentId(id)) return this.updateCustom(id, patch);
    if (!isPromptFragmentId(id)) throw new Error(hostI18n.t('errors.modes.fragmentNotFound', { id }));
    if (patch.title !== undefined) throw new Error(hostI18n.t('errors.modes.fragmentBuiltinTitle', { id }));
    const text = patch.text;
    if (text === null || text === PROMPT_FRAGMENT_DEFAULTS[id]) {
      this.db.prepare('DELETE FROM prompt_fragment WHERE id = ?').run(id);
    } else if (text !== undefined) {
      assertFragmentText(text);
      this.db
        .prepare(
          `INSERT INTO prompt_fragment (id, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        )
        .run(id, text, Date.now());
    }
    return builtinView(id, this.fragmentOverrides());
  }

  /** 删自建片段：内置不能删；仍被模式或自定义的通用提示词引用时拒绝，报错里列出引用处 */
  deleteFragment(id: string): void {
    if (isPromptFragmentId(id)) throw new Error(hostI18n.t('errors.modes.fragmentBuiltinDelete', { id }));
    this.requireCustom(id);
    const refs: string[] = this.list()
      .filter((m) => findFragmentReferences(m.systemPrompt).includes(id))
      .map((m) => hostI18n.t('errors.modes.fragmentRefMode', { name: m.name }));
    const general = this.getGeneral().systemPrompt;
    if (general !== null && findFragmentReferences(general).includes(id)) {
      refs.push(hostI18n.t('errors.modes.fragmentRefGeneral'));
    }
    if (refs.length) {
      throw new Error(
        hostI18n.t('errors.modes.fragmentInUse', { id, refs: refs.join(hostI18n.t('errors.modes.fragmentRefSeparator')) }),
      );
    }
    this.db.prepare('DELETE FROM custom_prompt_fragment WHERE id = ?').run(id);
  }

  private updateCustom(id: string, patch: FragmentPatch): PromptFragmentView {
    const row = this.requireCustom(id);
    if (patch.text === null) throw new Error(hostI18n.t('errors.modes.fragmentCustomNoDefault', { id }));
    const title = patch.title === undefined ? row.title : parseTitle(patch.title);
    const text = patch.text ?? row.text;
    if (patch.text !== undefined) assertFragmentText(patch.text);
    this.db
      .prepare('UPDATE custom_prompt_fragment SET title = ?, text = ?, updated_at = ? WHERE id = ?')
      .run(title, text, Date.now(), id);
    return customView(this.requireCustom(id));
  }

  private customRows(): z.infer<typeof customFragmentRow>[] {
    return this.db
      .prepare('SELECT id, title, text FROM custom_prompt_fragment ORDER BY id')
      .all()
      .map((r) => customFragmentRow.parse(r));
  }

  private customRow(id: string): z.infer<typeof customFragmentRow> | null {
    const r = this.db.prepare('SELECT id, title, text FROM custom_prompt_fragment WHERE id = ?').get(id);
    return r ? customFragmentRow.parse(r) : null;
  }

  private requireCustom(id: string): z.infer<typeof customFragmentRow> {
    const row = this.customRow(id);
    if (!row) throw new Error(hostI18n.t('errors.modes.fragmentNotFound', { id }));
    return row;
  }

  /** 模式 / 通用提示词里的占位符必须是内置片段或已有的自建片段 */
  private assertKnownPlaceholders(text: string): void {
    const unknown = findUnknownPlaceholders(text, Object.keys(this.customFragments()));
    if (unknown.length) {
      throw new Error(hostI18n.t('errors.modes.unknownPlaceholder', { ids: unknown.join(', ') }));
    }
  }

  private validate(raw: AgentModeInput): AgentModeInput {
    const input = AgentModeInputSchema.parse(raw);
    this.assertKnownPlaceholders(input.systemPrompt);
    return input;
  }
}

function builtinView(id: PromptFragmentId, overrides: FragmentOverrides): PromptFragmentView {
  const custom = overrides[id];
  return {
    kind: 'builtin',
    id,
    title: null,
    text: custom ?? PROMPT_FRAGMENT_DEFAULTS[id],
    defaultText: PROMPT_FRAGMENT_DEFAULTS[id],
    isCustom: custom !== undefined,
  };
}

function customView(row: z.infer<typeof customFragmentRow>): PromptFragmentView {
  return { kind: 'custom', id: row.id, title: row.title, text: row.text, defaultText: null, isCustom: false };
}

function parseTitle(raw: string): string {
  const parsed = FragmentTitleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(hostI18n.t('errors.modes.fragmentTitleLength', { max: String(FragmentTitleSchema.maxLength) }));
  }
  return parsed.data;
}

/** 片段正文：非空、不超长，且只能用 {{skills_dir}}（不能引用别的片段） */
function assertFragmentText(text: string): void {
  if (!FragmentTextSchema.safeParse(text).success) {
    throw new Error(hostI18n.t('errors.modes.fragmentTextLength', { max: String(FragmentTextSchema.maxLength) }));
  }
  const invalid = findInvalidFragmentVariables(text);
  if (invalid.length) {
    throw new Error(
      hostI18n.t('errors.modes.fragmentInvalidVariable', {
        variable: `{{${SKILLS_DIR_VARIABLE}}}`,
        vars: invalid.map((v) => `{{${v}}}`).join(', '),
      }),
    );
  }
}
