"use client";

import { useParams } from "next/navigation";

import { AgentShell } from "./agent-shell";

/**
 * 读取 URL 中的 conversationId（/agent/[id]），注入 AgentShell。
 * 放在 layout 层，保证 /agent ↔ /agent/[id] 切换时 AgentShell 不重挂载，
 * 会话列表查询不重置。
 */
export function AgentWrapper() {
  const params = useParams<{ id?: string }>();
  const conversationId = params?.id ?? null;

  return <AgentShell conversationId={conversationId} />;
}
