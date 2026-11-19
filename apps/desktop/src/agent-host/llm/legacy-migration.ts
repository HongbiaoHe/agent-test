/**
 * 旧版模型配置迁移（每个账号只跑一次，profile_setting.legacy_models_migrated 记标记）：
 *
 * 旧版只有设备级的 Gemini / DeepSeek 两个 Key，模型写死成 9 个 `provider:model`。升级后 main 在这个账号
 * 第一次打开时，把设备级的旧 Key 复制进账号自己的加密文件、为它们生成连接 id，经 config 传进来
 * （legacyConnections）。这里负责：
 *  1. 按这些 id 建好「Google Gemini」「DeepSeek」两个连接，预置并启用原来的模型（不用重新填 Key、不用重新选）；
 *  2. 把会话、模式、通用模式里存的旧模型名改写成新的「连接 id/模型 id」，对不上的置空（按账号默认模型跑）；
 *  3. 设备级的旧默认模型改写后作为这个账号的默认模型。
 */
import { ALLOWED_MODELS } from '@agent-test/agent-core/agent/models';
import { modelRef, parseModelRef } from '@agent-test/agent-core/providers/model-ref';
import { findPreset } from '@agent-test/agent-core/providers/presets';
import { z } from 'zod';
import { type Db, transaction } from '../db/database';
import type { LlmStore } from './llm-store';

export const LEGACY_PRESETS = ['gemini', 'deepseek'] as const;
export type LegacyPreset = (typeof LEGACY_PRESETS)[number];

export interface LegacyConnection {
  id: string;
  presetId: LegacyPreset;
}

const MIGRATED_KEY = 'legacy_models_migrated';

/** 旧模型名 → 预设 + 模型 id：`google-genai:x` / 裸 `gemini-*` → gemini，`deepseek:x` → deepseek */
function legacyModel(old: string): { presetId: LegacyPreset; modelId: string } | null {
  const i = old.indexOf(':');
  if (i === -1) return old.startsWith('gemini-') ? { presetId: 'gemini', modelId: old } : null;
  const provider = old.slice(0, i);
  const modelId = old.slice(i + 1);
  if (!modelId) return null;
  if (provider === 'google-genai') return { presetId: 'gemini', modelId };
  if (provider === 'deepseek') return { presetId: 'deepseek', modelId };
  return null;
}

/** 某个预设原来那几个模型（core 的旧白名单） */
function legacyModelIds(presetId: LegacyPreset): string[] {
  return ALLOWED_MODELS.flatMap((name) => {
    const m = legacyModel(name);
    return m && m.presetId === presetId ? [m.modelId] : [];
  });
}

export function isLegacyMigrated(db: Db): boolean {
  return !!db.prepare('SELECT 1 FROM profile_setting WHERE key = ?').get(MIGRATED_KEY);
}

export function migrateLegacyModels(
  db: Db,
  store: LlmStore,
  input: { connections: readonly LegacyConnection[]; legacyDefaultModel: string | null },
): boolean {
  if (isLegacyMigrated(db)) return false;
  const connOf = new Map<LegacyPreset, string>();
  for (const c of input.connections) {
    const preset = findPreset(c.presetId);
    if (!preset) continue;
    if (!store.getConnection(c.id)) {
      store.createConnection(
        { name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, presetId: preset.id },
        c.id,
      );
      const ids = legacyModelIds(c.presetId);
      store.mergeListed(
        c.id,
        ids.map((id) => ({ id, displayName: null, contextWindow: null, thinking: null })),
      );
      store.setEnabled(c.id, ids, true);
    }
    connOf.set(c.presetId, c.id);
  }

  /** 旧值 → 新引用；已经是新格式的原样保留；对不上的返回 null */
  const rewrite = (old: string | null): string | null => {
    if (!old) return null;
    if (parseModelRef(old) && store.resolve(old)) return old;
    const m = legacyModel(old);
    const connId = m ? connOf.get(m.presetId) : undefined;
    const ref = m && connId ? modelRef(connId, m.modelId) : null;
    return ref && store.resolve(ref) ? ref : null;
  };

  const valueRows = z.array(z.object({ id: z.union([z.string(), z.number()]), v: z.string().nullable() }));
  transaction(db, () => {
    for (const [table, column] of [
      ['conversation', 'model'],
      ['agent_mode', 'default_model'],
      ['general_mode', 'default_model'],
    ] as const) {
      // 表名 / 列名来自上面的常量列表，不来自外部输入
      const rows = valueRows.parse(
        db.prepare(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all(),
      );
      for (const r of rows) {
        const next = rewrite(r.v);
        if (next !== r.v) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(next, r.id);
      }
    }
    const def = rewrite(input.legacyDefaultModel);
    if (def && !store.defaultModel()) store.setDefaultModel(def);
    db.prepare('INSERT INTO profile_setting (key, value) VALUES (?, ?)').run(MIGRATED_KEY, new Date().toISOString());
  });
  return true;
}
