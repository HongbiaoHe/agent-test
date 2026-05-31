"use client";

import { useParams } from "next/navigation";

import { AgentShell } from "../_components/agent-shell";

// /agent/[id]：具体会话。刷新按 URL 的 id 恢复；[id1]→[id2] 同段不重挂载。
export default function AgentConversationPage() {
  const params = useParams<{ id: string }>();
  return <AgentShell conversationId={params.id} />;
}
