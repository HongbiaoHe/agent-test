/**
 * agent 模式（desktop 版，对应 backend 的 ModesService）：SQLite `agent_mode` 表的 CRUD。
 * 行数据用 zod 收窄，JSON 列（勾选的工具名 / server id / 技能名）存 TEXT；对外形状是 core 的 AgentMode。
 * 保存时校验正文里的 {{platform.xxx}} 占位符（片段库没有的拒绝，决策 2）。
 * 删模式 → 引用它的会话 mode_id 置空（回到通用模式，决策 8）。
 * 通用模式（mode_id 为 NULL）的用户覆盖存单行表 `general_mode`（id = 1）：提示词 + 新建会话的默认模型 / 思考档位。
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
import { findUnknownPlaceholders } from '@agent-test/agent-core/modes/prompt-fragments';
import { z } from 'zod';
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
    if (input.systemPrompt !== null) assertKnownPlaceholders(input.systemPrompt);
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

  private validate(raw: AgentModeInput): AgentModeInput {
    const input = AgentModeInputSchema.parse(raw);
    assertKnownPlaceholders(input.systemPrompt);
    return input;
  }
}

function assertKnownPlaceholders(text: string): void {
  const unknown = findUnknownPlaceholders(text);
  if (unknown.length) {
    throw new Error(hostI18n.t('errors.modes.unknownPlaceholder', { ids: unknown.join(', ') }));
  }
}
