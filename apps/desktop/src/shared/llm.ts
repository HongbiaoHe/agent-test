/**
 * 「API 连接」与模型的界面形状（renderer ↔ agent-host 共用）。
 * 连接元数据与模型列表存在当前账号的 spark.db；Key 只在 main 里加密保存，这里只有「是否已配置」。
 */
import type {
  ConnectionTestResult,
  ModelTestResult,
} from '@agent-test/agent-core/providers/test-model';
import type {
  ModelCapabilities,
  ProviderProtocol,
} from '@agent-test/agent-core/providers/types';

export type { ConnectionTestResult, ModelCapabilities, ModelTestResult, ProviderProtocol };

export interface LlmConnectionView {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  presetId: string | null;
  /** 预设要求 Key（本地服务 / 自定义不要求） */
  keyRequired: boolean;
  keyConfigured: boolean;
  modelCount: number;
  enabledCount: number;
  /** 最近一次拉取模型列表的时间；从没拉过为 null */
  lastListedAt: string | null;
  createdAt: string;
}

/** 刷新后的状态：listed = 这次拉到了；new = 上次没有、这次新出现；missing = 已有但这次没拉到（已下架） */
export const MODEL_LIST_STATES = ['listed', 'new', 'missing'] as const;
export type ModelListState = (typeof MODEL_LIST_STATES)[number];

/** listed = 从接口拉到的；manual = 用户手填的（不参与「已下架」判断） */
export const MODEL_SOURCES = ['listed', 'manual'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export interface LlmModelView {
  connectionId: string;
  modelId: string;
  /** 「连接 id/模型 id」：会话、模式、默认模型里存的就是它 */
  ref: string;
  displayName: string | null;
  enabled: boolean;
  source: ModelSource;
  listState: ModelListState;
  capabilities: ModelCapabilities;
  /** 用户改过能力（之后刷新不再覆盖） */
  capabilitiesEdited: boolean;
  test: ModelTestResult | null;
}

/** 模型下拉的一项：已启用的模型 + 所属连接名（按连接分组展示） */
export interface ModelOption extends LlmModelView {
  connectionName: string;
}
