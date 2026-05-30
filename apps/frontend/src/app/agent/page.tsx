"use client";

import { useMutation } from "@tanstack/react-query";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { TodoList, type Todo } from "@/components/agent/todo-list";
import { ToolCard, type ToolCall } from "@/components/agent/tool-card";
import { createConversation } from "@/lib/api";
import {
  respondControl,
  subscribeConversation,
  type ConversationEvent,
} from "@/lib/socket";

interface Approval {
  actionRequests: { name: string; args: unknown; description?: string }[];
  reviewConfigs: { actionName: string; allowedDecisions: string[] }[];
}

type Decision = "approve" | "reject" | "edit" | "respond";
const DECISION_LABEL: Record<Decision, string> = {
  approve: "批准",
  reject: "拒绝",
  edit: "编辑",
  respond: "回复",
};

export default function AgentPage() {
  // 未登录守卫由 middleware（next-auth）在服务端完成，这里无需客户端检查
  const [goal, setGoal] = useState(
    "给 test@example.com 发一封邮件，主题是问候，正文是你好",
  );
  const [conversationId, setConversationId] = useState("");
  const [status, setStatus] = useState("");
  const [todos, setTodos] = useState<Todo[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [answer, setAnswer] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);

  function handleEvent(e: ConversationEvent) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "plan_update":
        if (Array.isArray(p?.todos)) setTodos(p.todos as Todo[]);
        break;
      case "tool_start":
        setTools((prev) => [
          ...prev,
          ...(((p?.tool_calls as { name: string; args: unknown }[]) ?? []).map(
            (c) => ({ name: c.name, args: c.args, done: false }),
          )),
        ]);
        break;
      case "tool_end":
        setTools((prev) => {
          const next = [...prev];
          const idx = next.findIndex((t) => t.name === p?.name && !t.done);
          if (idx >= 0)
            next[idx] = { ...next[idx], result: String(p?.content ?? ""), done: true };
          return next;
        });
        break;
      case "token":
        if (p?.text) setAnswer((prev) => prev + String(p.text));
        break;
      case "message":
        if (p?.text) setAnswer(String(p.text));
        break;
      case "control_request":
        setApproval(p as unknown as Approval);
        setStatus("waiting_approval");
        break;
      case "result":
        setStatus("done");
        setApproval(null);
        break;
      case "error":
        setStatus("failed");
        setApproval(null);
        setAnswer((prev) => prev + `\n[错误] ${String(p?.message ?? "")}`);
        break;
    }
  }

  const mutation = useMutation({
    mutationFn: (g: string) => createConversation(g),
    onSuccess: ({ conversationId }) => {
      setConversationId(conversationId);
      setStatus("running");
      setTodos([]);
      setTools([]);
      setAnswer("");
      setApproval(null);
      subscribeConversation(conversationId, handleEvent);
    },
  });

  function decide(type: Decision) {
    if (!approval) return;
    let decisions: unknown[];
    if (type === "edit") {
      decisions = approval.actionRequests.map((a) => {
        const input = window.prompt(
          `编辑 ${a.name} 的参数 (JSON):`,
          JSON.stringify(a.args),
        );
        if (input === null) return { type: "reject" };
        try {
          return { type: "edit", editedAction: { name: a.name, args: JSON.parse(input) } };
        } catch {
          return { type: "reject" };
        }
      });
    } else if (type === "respond") {
      const input = window.prompt("回复内容（作为工具结果返回给 agent）:") ?? "";
      decisions = approval.actionRequests.map(() => ({ type: "respond", message: input }));
    } else {
      decisions = approval.actionRequests.map(() => ({ type }));
    }
    respondControl(conversationId, decisions);
    setApproval(null);
    setStatus("running");
  }

  const badgeVariant =
    status === "done" ? "default" : status === "failed" ? "destructive" : "secondary";
  const allowed = (approval?.reviewConfigs?.[0]?.allowedDecisions ?? [
    "approve",
    "reject",
  ]) as Decision[];

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8 font-sans">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agent 会话</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          退出
        </Button>
      </div>

      <div className="space-y-2">
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder="输入要让 agent 完成的目标…"
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={() => mutation.mutate(goal)}
            disabled={mutation.isPending || status === "running"}
          >
            {mutation.isPending ? "提交中…" : "提交任务"}
          </Button>
          {status && <Badge variant={badgeVariant}>{status}</Badge>}
          {mutation.isError && (
            <span className="text-sm text-red-600">
              {(mutation.error as Error).message}
            </span>
          )}
        </div>
      </div>

      {approval && (
        <Card className="space-y-3 border-amber-400 p-4">
          <h2 className="text-sm font-semibold text-amber-600">⚠️ 需要审批</h2>
          {approval.actionRequests.map((a, i) => (
            <div key={i} className="text-sm">
              <div>
                工具:{" "}
                <code className="rounded bg-muted px-1">{a.name}</code>
              </div>
              <pre className="mt-1 text-xs text-muted-foreground">
                {JSON.stringify(a.args, null, 2)}
              </pre>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {allowed.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={
                  d === "reject" ? "destructive" : d === "approve" ? "default" : "secondary"
                }
                onClick={() => decide(d)}
              >
                {DECISION_LABEL[d] ?? d}
              </Button>
            ))}
            {!allowed.includes("respond") && (
              <Button size="sm" variant="secondary" onClick={() => decide("respond")}>
                回复
              </Button>
            )}
          </div>
        </Card>
      )}

      {todos.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">规划 (write_todos)</h2>
          <TodoList todos={todos} />
        </Card>
      )}

      {tools.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">工具调用</h2>
          {tools.map((t, i) => (
            <ToolCard key={i} tool={t} />
          ))}
        </div>
      )}

      {answer && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">回答</h2>
          <p className="whitespace-pre-wrap text-sm">{answer}</p>
        </Card>
      )}
    </main>
  );
}
