/**
 * 运行期按引用（「连接 id/模型 id」）构建模型：Key 来自 main 下发的内存表，Base URL / 协议 / 能力来自账号的
 * 连接配置（见 llm-store.ts）。引用解析不了（连接已删、模型已停用或下架后被移除）时按账号默认模型、再按第一个
 * 已启用的模型；一个都没有就报错（界面会先引导用户添加连接）。
 */
import type { ModelResolver } from '@agent-test/agent-core/agent/agent.factory';
import { buildChatModel, keepsNativeBlocksFor } from '@agent-test/agent-core/providers/build-model';
import type { ProviderConnection } from '@agent-test/agent-core/providers/types';
import { hostI18n } from '../i18n';
import type { LlmStore, ResolvedModelEntry } from './llm-store';

export type KeyOf = (connectionId: string) => string | null;

/** 连接 → 带解密 Key 的连接参数（构建模型 / 拉列表 / 测试共用） */
export function providerConnection(
  conn: ResolvedModelEntry['connection'],
  keyOf: KeyOf,
): ProviderConnection {
  return { protocol: conn.protocol, baseUrl: conn.baseUrl, apiKey: keyOf(conn.id) };
}

export function createModelResolver(store: LlmStore, keyOf: KeyOf): ModelResolver {
  return (ref, thinkingLevel) => {
    const effective = store.effectiveRef(ref);
    const entry = effective ? store.resolve(effective) : null;
    if (!entry) return Promise.reject(new Error(hostI18n.t('errors.models.noneAvailable')));
    const conn = providerConnection(entry.connection, keyOf);
    return Promise.resolve({
      model: buildChatModel(conn, entry.modelId, entry.capabilities, thinkingLevel),
      keepsNativeBlocks: keepsNativeBlocksFor(conn),
    });
  };
}
