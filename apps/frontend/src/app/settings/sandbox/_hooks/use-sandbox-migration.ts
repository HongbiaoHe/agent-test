"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { fetchSandboxMigration, switchSandboxSize } from "@/lib/api";

const MIGRATION_QUERY_KEY = ["sandbox-migration"] as const;

/**
 * 换档迁移：发起 + 进度轮询（进行中每 2s 拉一次，结束即停）。
 * 迁移从进行中变为结束时，刷新沙箱设置（当前档位）与沙箱状态（规格、沙箱 id 都换了）。
 */
export function useSandboxMigration() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: MIGRATION_QUERY_KEY,
    queryFn: fetchSandboxMigration,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: switchSandboxSize,
    onSuccess: (data) => qc.setQueryData(MIGRATION_QUERY_KEY, data),
  });

  const status = query.data?.status;
  const prev = useRef(status);
  useEffect(() => {
    if (prev.current === "running" && status && status !== "running") {
      void qc.invalidateQueries({ queryKey: ["sandbox-settings"] });
      void qc.invalidateQueries({ queryKey: ["sandbox-status"] });
    }
    prev.current = status;
  }, [status, qc]);

  return { query, start };
}
