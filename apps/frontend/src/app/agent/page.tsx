"use client";

import { AgentShell } from "./_components/agent-shell";

// /agent：新会话（未选中任何会话）。首次发送后创建会话并跳转到 /agent/[id]。
export default function AgentNewChatPage() {
  return <AgentShell conversationId={null} />;
}
