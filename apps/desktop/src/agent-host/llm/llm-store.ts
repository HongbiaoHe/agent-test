/**
 * 当前账号的 API 连接与模型（spark.db 的 llm_connection / llm_model / profile_setting 表）。
 * Key 不在这里：main 用系统钥匙串加密保存，经 config 消息把解密后的值交给本进程内存（keyOf）。
 *
 * 模型列表的合并规则（「刷新」）：
 *  - 拉到、库里没有 → 新增，默认不启用；连接拉过一次以后新出现的标 new；
 *  - 拉到、库里有 → 标 listed；用户没改过能力的，接口给的上下文窗口 / 展示名跟着更新；
 *  - 库里有（来源 listed）、这次没拉到 → 标 missing（已下架），不删、不改启用状态；
 *  - 手填的模型不参与下架判断。
 */
import { randomUUID } from 'node:crypto';
import {
  defaultCapabilities,
  thinkingLevelsForStyle,
} from '@agent-test/agent-core/providers/capabilities';
import { modelRef, parseModelRef } from '@agent-test/agent-core/providers/model-ref';
import { findPreset } from '@agent-test/agent-core/providers/presets';
import type { ModelTestResult } from '@agent-test/agent-core/providers/test-model';
import {
  type ListedModel,
  type ModelCapabilities,
  PROVIDER_PROTOCOLS,
  type ProviderProtocol,
  THINKING_STYLES,
} from '@agent-test/agent-core/providers/types';
import { THINKING_LEVELS } from '@agent-test/agent-core/agent/thinking-level';
import { z } from 'zod';
import {
  type LlmConnectionView,
  type LlmModelView,
  MODEL_LIST_STATES,
  MODEL_SOURCES,
  type ModelOption,
} from '../../shared/llm';
import { type Db, transaction } from '../db/database';
import { hostI18n } from '../i18n';

const connectionRow = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(PROVIDER_PROTOCOLS),
  base_url: z.string(),
  preset_id: z.string().nullable(),
  last_listed_at: z.number().nullable(),
  created_at: z.number(),
});
type ConnectionRow = z.infer<typeof connectionRow>;

const capabilitiesSchema = z.object({
  thinkingStyle: z.enum(THINKING_STYLES),
  thinkingLevels: z.array(z.enum(THINKING_LEVELS)).min(1),
  contextWindow: z.number().int().positive().nullable(),
  reasoningSummary: z.boolean().optional(),
});

const testSchema = z.object({
  status: z.enum(['ok', 'no_tools', 'error']),
  message: z.string().nullable(),
  testedAt: z.string(),
  latencyMs: z.number(),
});

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const modelRow = z.object({
  connection_id: z.string(),
  model_id: z.string(),
  display_name: z.string().nullable(),
  enabled: z.number(),
  source: z.enum(MODEL_SOURCES),
  list_state: z.enum(MODEL_LIST_STATES),
  capabilities: z.string(),
  capabilities_edited: z.number(),
  test: z.string().nullable(),
});
type ModelRow = z.infer<typeof modelRow>;

/** 解析出来的一个可用模型（构建模型实例用） */
export interface ResolvedModelEntry {
  connection: { id: string; protocol: ProviderProtocol; baseUrl: string; presetId: string | null };
  modelId: string;
  capabilities: ModelCapabilities;
}

export interface CreateConnectionInput {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  presetId: string | null;
}

const DEFAULT_MODEL_KEY = 'default_model';

export class LlmStore {
  constructor(
    private readonly db: Db,
    /** 某个连接的 Key（main 经 config 下发，只在内存里）；没有为 null */
    private readonly keyOf: (connectionId: string) => string | null,
  ) {}

  // ── 连接 ──────────────────────────────────────────────────────────────────

  listConnections(): LlmConnectionView[] {
    return this.db
      .prepare('SELECT * FROM llm_connection ORDER BY created_at')
      .all()
      .map((r) => this.connectionView(connectionRow.parse(r)));
  }

  getConnection(id: string): LlmConnectionView | null {
    const r = this.connectionRowOf(id);
    return r ? this.connectionView(r) : null;
  }

  createConnection(input: CreateConnectionInput, id: string = randomUUID()): LlmConnectionView {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO llm_connection (id, name, protocol, base_url, preset_id, last_listed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, input.name.trim(), input.protocol, input.baseUrl.trim(), input.presetId, now, now);
    return this.requireConnection(id);
  }

  /** 名称与 Base URL 可改；协议不能改（要换协议就新建连接） */
  updateConnection(id: string, patch: { name?: string; baseUrl?: string }): LlmConnectionView {
    const cur = this.requireRow(id);
    this.db
      .prepare('UPDATE llm_connection SET name = ?, base_url = ?, updated_at = ? WHERE id = ?')
      .run(patch.name?.trim() || cur.name, patch.baseUrl?.trim() ?? cur.base_url, Date.now(), id);
    return this.requireConnection(id);
  }

  /** 连接下的模型由外键级联删除；引用它的会话 / 模式在运行时回落到默认模型 */
  deleteConnection(id: string): void {
    this.requireRow(id);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM llm_connection WHERE id = ?').run(id);
      const def = parseModelRef(this.defaultModel());
      if (def?.connectionId === id) this.setDefaultModel(null);
    });
  }

  // ── 模型 ──────────────────────────────────────────────────────────────────

  listModels(connectionId: string): LlmModelView[] {
    this.requireRow(connectionId);
    return this.db
      .prepare('SELECT * FROM llm_model WHERE connection_id = ? ORDER BY model_id')
      .all(connectionId)
      .map((r) => modelView(modelRow.parse(r)));
  }

  /** 刷新：把这次拉到的列表并进库（规则见文件头） */
  mergeListed(connectionId: string, listed: readonly ListedModel[]): LlmModelView[] {
    const conn = this.requireRow(connectionId);
    const presetStyle = findPreset(conn.preset_id)?.thinkingStyle ?? 'none';
    const firstListing = conn.last_listed_at === null;
    const now = Date.now();
    transaction(this.db, () => {
      const existing = new Map(
        this.db
          .prepare('SELECT * FROM llm_model WHERE connection_id = ?')
          .all(connectionId)
          .map((r) => {
            const row = modelRow.parse(r);
            return [row.model_id, row] as const;
          }),
      );
      const seen = new Set<string>();
      for (const m of listed) {
        seen.add(m.id);
        const cur = existing.get(m.id);
        if (!cur) {
          const caps = defaultCapabilities(conn.protocol, presetStyle, m);
          this.insertModel(connectionId, m.id, m.displayName, 'listed', firstListing ? 'listed' : 'new', caps, now);
          continue;
        }
        const caps = cur.capabilities_edited
          ? null
          : { ...parseCaps(cur.capabilities), contextWindow: m.contextWindow ?? parseCaps(cur.capabilities).contextWindow };
        this.db
          .prepare(
            `UPDATE llm_model SET display_name = ?, list_state = ?, capabilities = COALESCE(?, capabilities), updated_at = ?
             WHERE connection_id = ? AND model_id = ?`,
          )
          .run(
            m.displayName ?? cur.display_name,
            // 上次标 new 的这次仍在：保持 new，直到用户启用（启用即确认）
            cur.list_state === 'new' && !cur.enabled ? 'new' : 'listed',
            caps ? JSON.stringify(caps) : null,
            now,
            connectionId,
            m.id,
          );
      }
      for (const [id, row] of existing) {
        if (row.source === 'listed' && !seen.has(id)) {
          this.db
            .prepare(`UPDATE llm_model SET list_state = 'missing', updated_at = ? WHERE connection_id = ? AND model_id = ?`)
            .run(now, connectionId, id);
        }
      }
      this.db.prepare('UPDATE llm_connection SET last_listed_at = ?, updated_at = ? WHERE id = ?').run(now, now, connectionId);
    });
    return this.listModels(connectionId);
  }

  /** 手填模型（服务没有 /models 或列表不全）；默认启用 */
  addManualModel(connectionId: string, modelId: string): LlmModelView {
    const conn = this.requireRow(connectionId);
    const id = modelId.trim();
    if (!id) throw new Error(hostI18n.t('errors.models.emptyModelId'));
    if (this.modelRowOf(connectionId, id)) {
      this.setEnabled(connectionId, [id], true);
    } else {
      const caps = defaultCapabilities(conn.protocol, findPreset(conn.preset_id)?.thinkingStyle ?? 'none', {
        id,
        thinking: null,
        contextWindow: null,
      });
      this.insertModel(connectionId, id, null, 'manual', 'listed', caps, Date.now(), true);
    }
    return this.requireModel(connectionId, id);
  }

  /** 启用 / 停用；启用即确认「新」标记 */
  setEnabled(connectionId: string, modelIds: readonly string[], enabled: boolean): void {
    this.requireRow(connectionId);
    transaction(this.db, () => {
      for (const id of modelIds) {
        this.db
          .prepare(
            `UPDATE llm_model SET enabled = ?, list_state = CASE WHEN ? AND list_state = 'new' THEN 'listed' ELSE list_state END,
               updated_at = ? WHERE connection_id = ? AND model_id = ?`,
          )
          .run(enabled ? 1 : 0, enabled ? 1 : 0, Date.now(), connectionId, id);
      }
    });
    if (!enabled) this.clearDefaultIfDisabled();
  }

  removeModel(connectionId: string, modelId: string): void {
    this.db.prepare('DELETE FROM llm_model WHERE connection_id = ? AND model_id = ?').run(connectionId, modelId);
    this.clearDefaultIfDisabled();
  }

  /** 用户改能力：档位按写法重算（写法与档位不匹配的部分去掉），之后刷新不再覆盖 */
  updateCapabilities(connectionId: string, modelId: string, caps: ModelCapabilities): LlmModelView {
    this.requireModel(connectionId, modelId);
    const allowed = thinkingLevelsForStyle(caps.thinkingStyle, modelId);
    const levels = caps.thinkingLevels.filter((l) => allowed.includes(l));
    const next: ModelCapabilities = {
      thinkingStyle: caps.thinkingStyle,
      thinkingLevels: levels.includes('auto') ? levels : ['auto', ...levels],
      contextWindow: caps.contextWindow,
      ...(caps.reasoningSummary === false && { reasoningSummary: false }),
    };
    this.db
      .prepare(
        `UPDATE llm_model SET capabilities = ?, capabilities_edited = 1, updated_at = ? WHERE connection_id = ? AND model_id = ?`,
      )
      .run(JSON.stringify(next), Date.now(), connectionId, modelId);
    return this.requireModel(connectionId, modelId);
  }

  /**
   * 存测试结果。测出「带思考摘要不行、去掉就行」（OpenAI 未验证的组织）时顺带把摘要关掉：
   * 不算用户改过能力（刷新模型列表时 reasoningSummary 随原能力保留）
   */
  saveTest(connectionId: string, modelId: string, result: ModelTestResult): LlmModelView {
    const { reasoningSummaryUnsupported, ...test } = result;
    const caps = reasoningSummaryUnsupported
      ? { ...this.requireModel(connectionId, modelId).capabilities, reasoningSummary: false }
      : null;
    this.db
      .prepare(
        `UPDATE llm_model SET test = ?, capabilities = COALESCE(?, capabilities), updated_at = ?
         WHERE connection_id = ? AND model_id = ?`,
      )
      .run(JSON.stringify(test), caps ? JSON.stringify(caps) : null, Date.now(), connectionId, modelId);
    return this.requireModel(connectionId, modelId);
  }

  /** 模型下拉：已启用的模型（按连接创建顺序、模型 id 排序） */
  enabledModels(): ModelOption[] {
    return this.db
      .prepare(
        `SELECT m.*, c.name AS connection_name FROM llm_model m JOIN llm_connection c ON c.id = m.connection_id
         WHERE m.enabled = 1 ORDER BY c.created_at, m.model_id`,
      )
      .all()
      .map((r) => {
        const row = modelRow.extend({ connection_name: z.string() }).parse(r);
        return { ...modelView(row), connectionName: row.connection_name };
      });
  }

  /** 按引用解析（连接与模型都在，且模型已启用）；解析不了返回 null */
  resolve(ref: string | null | undefined): ResolvedModelEntry | null {
    const parsed = parseModelRef(ref);
    if (!parsed) return null;
    const conn = this.connectionRowOf(parsed.connectionId);
    const row = this.modelRowOf(parsed.connectionId, parsed.modelId);
    if (!conn || !row || !row.enabled) return null;
    return {
      connection: { id: conn.id, protocol: conn.protocol, baseUrl: conn.base_url, presetId: conn.preset_id },
      modelId: row.model_id,
      capabilities: parseCaps(row.capabilities),
    };
  }

  // ── 默认模型（按账号）────────────────────────────────────────────────────

  defaultModel(): string | null {
    const r = this.db.prepare('SELECT value FROM profile_setting WHERE key = ?').get(DEFAULT_MODEL_KEY);
    const parsed = z.object({ value: z.string() }).safeParse(r);
    return parsed.success ? parsed.data.value : null;
  }

  setDefaultModel(ref: string | null): void {
    if (ref === null) {
      this.db.prepare('DELETE FROM profile_setting WHERE key = ?').run(DEFAULT_MODEL_KEY);
      return;
    }
    if (!this.resolve(ref)) throw new Error(hostI18n.t('errors.models.defaultMustBeEnabled'));
    this.db
      .prepare(
        `INSERT INTO profile_setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(DEFAULT_MODEL_KEY, ref);
  }

  /**
   * 运行时实际用的引用：会话 / 模式的引用解析得到就用它；否则账号默认模型；再否则第一个启用的模型。
   * 一个可用模型都没有返回 null（界面应已引导用户先添加连接）。
   */
  effectiveRef(ref: string | null | undefined): string | null {
    if (ref && this.resolve(ref)) return ref;
    const def = this.defaultModel();
    if (def && this.resolve(def)) return def;
    return this.enabledModels()[0]?.ref ?? null;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private insertModel(
    connectionId: string,
    modelId: string,
    displayName: string | null,
    source: 'listed' | 'manual',
    listState: 'listed' | 'new',
    caps: ModelCapabilities,
    now: number,
    enabled = false,
  ): void {
    this.db
      .prepare(
        `INSERT INTO llm_model (connection_id, model_id, display_name, enabled, source, list_state, capabilities,
           capabilities_edited, test, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(connectionId, modelId, displayName, enabled ? 1 : 0, source, listState, JSON.stringify(caps), now, now);
  }

  private clearDefaultIfDisabled(): void {
    const def = this.defaultModel();
    if (def && !this.resolve(def)) this.setDefaultModel(null);
  }

  private connectionView(r: ConnectionRow): LlmConnectionView {
    const counts = z
      .object({ total: z.number(), enabled: z.number().nullable() })
      .parse(
        this.db
          .prepare('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM llm_model WHERE connection_id = ?')
          .get(r.id),
      );
    return {
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      baseUrl: r.base_url,
      presetId: r.preset_id,
      keyRequired: findPreset(r.preset_id)?.keyRequired ?? false,
      keyConfigured: !!this.keyOf(r.id),
      modelCount: counts.total,
      enabledCount: counts.enabled ?? 0,
      lastListedAt: r.last_listed_at === null ? null : new Date(r.last_listed_at).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private connectionRowOf(id: string): ConnectionRow | null {
    const r = this.db.prepare('SELECT * FROM llm_connection WHERE id = ?').get(id);
    return r ? connectionRow.parse(r) : null;
  }

  private requireRow(id: string): ConnectionRow {
    const r = this.connectionRowOf(id);
    if (!r) throw new Error(hostI18n.t('errors.models.connectionNotFound', { id }));
    return r;
  }

  private requireConnection(id: string): LlmConnectionView {
    return this.connectionView(this.requireRow(id));
  }

  private modelRowOf(connectionId: string, modelId: string): ModelRow | null {
    const r = this.db
      .prepare('SELECT * FROM llm_model WHERE connection_id = ? AND model_id = ?')
      .get(connectionId, modelId);
    return r ? modelRow.parse(r) : null;
  }

  private requireModel(connectionId: string, modelId: string): LlmModelView {
    const r = this.modelRowOf(connectionId, modelId);
    if (!r) throw new Error(hostI18n.t('errors.models.modelNotFound', { id: modelId }));
    return modelView(r);
  }
}

/** 库里的能力 JSON 解析不了（手改 / 旧格式）就按最保守的 none 处理，不让整个列表读挂 */
function parseCaps(text: string): ModelCapabilities {
  const parsed = capabilitiesSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : { thinkingStyle: 'none', thinkingLevels: ['auto'], contextWindow: null };
}

function modelView(r: ModelRow): LlmModelView {
  const test = testSchema.safeParse(parseJson(r.test));
  return {
    connectionId: r.connection_id,
    modelId: r.model_id,
    ref: modelRef(r.connection_id, r.model_id),
    displayName: r.display_name,
    enabled: r.enabled === 1,
    source: r.source,
    listState: r.list_state,
    capabilities: parseCaps(r.capabilities),
    capabilitiesEdited: r.capabilities_edited === 1,
    test: test.success ? test.data : null,
  };
}
