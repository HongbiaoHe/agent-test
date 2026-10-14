"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchSandboxSettings, updateSandboxSettings } from "@/lib/api";

const SANDBOX_SETTINGS_QUERY_KEY = ["sandbox-settings"] as const;

/**
 * 沙箱设置的读取与局部更新（提供方卡片与生命周期卡片共用同一缓存）。
 * 保存成功后同时刷新沙箱状态（agent 页的沙箱面板 / 本页的当前沙箱卡片）。
 */
export function useSandboxSettings() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: SANDBOX_SETTINGS_QUERY_KEY,
    queryFn: fetchSandboxSettings,
  });
  const mutation = useMutation({
    mutationFn: updateSandboxSettings,
    onSuccess: (data) => {
      qc.setQueryData(SANDBOX_SETTINGS_QUERY_KEY, data);
      qc.invalidateQueries({ queryKey: ["sandbox-status"] });
    },
  });
  return { query, mutation };
}
