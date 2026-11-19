/**
 * API 连接 / 模型的数据接口（agent-host RPC + preload 的 Key 读写）。
 * 所有 query 都挂在 LLM_QUERY_KEY 前缀下：host 广播 llm-changed 时按前缀一起失效（见 app.tsx）。
 */
import { useQuery } from '@tanstack/react-query';
import { agent } from '@/lib/agent-client';

export const LLM_QUERY_KEY = ['llm'] as const;
/** models.list：当前账号所有已启用的模型（模型下拉） */
export const MODEL_OPTIONS_KEY = ['llm', 'options'] as const;
/** host.status：默认模型 / 有没有可用模型 */
export const HOST_STATUS_KEY = ['llm', 'status'] as const;
export const CONNECTIONS_KEY = ['llm', 'connections'] as const;
export const connectionModelsKey = (connectionId: string) => ['llm', 'models', connectionId] as const;

export function useModelOptions() {
  return useQuery({ queryKey: MODEL_OPTIONS_KEY, queryFn: () => agent.call('models.list', {}) });
}

export function useHostStatus() {
  return useQuery({ queryKey: HOST_STATUS_KEY, queryFn: () => agent.call('host.status', {}) });
}
