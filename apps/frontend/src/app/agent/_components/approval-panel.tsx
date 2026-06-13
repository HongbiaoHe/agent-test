"use client";

import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import type { Approval, Decision } from "../_lib/thread";
import { PromptPanel } from "./prompt-panel";

const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approve",
  reject: "Reject",
  edit: "Edit",
  respond: "Reply",
};

type View = "review" | "edit" | "reply";

/**
 * 审批面板（基于 PromptPanel，渲染在输入框上方）：
 * - review：工具参数按 key-value 友好展示 + 决策按钮
 * - edit：面板内逐字段表单（字符串字段直接编辑，非字符串编辑 JSON 文本）
 * - reply：面板内输入回复，作为工具结果返回 agent
 * 自行组装完整 decisions（顺序对应 actionRequests），经 onSubmit 上抛。
 */
export function ApprovalPanel({
  approval,
  onSubmit,
}: {
  approval: Approval;
  onSubmit: (decisions: unknown[]) => void;
}) {
  const [view, setView] = useState<View>("review");
  const [reply, setReply] = useState("");
  // drafts[i][key]：第 i 个 actionRequest 的字段编辑文本（非字符串字段为 JSON 文本）
  const [drafts, setDrafts] = useState<Record<string, string>[]>([]);
  const [editError, setEditError] = useState<string | null>(null);

  const allowed = (approval.reviewConfigs?.[0]?.allowedDecisions ?? [
    "approve",
    "reject",
  ]) as Decision[];

  const argEntries = (a: Approval["actionRequests"][number]) =>
    Object.entries((a.args ?? {}) as Record<string, unknown>);

  function startEdit() {
    setDrafts(
      approval.actionRequests.map((a) =>
        Object.fromEntries(
          argEntries(a).map(([k, v]) => [
            k,
            typeof v === "string" ? v : JSON.stringify(v, null, 2),
          ]),
        ),
      ),
    );
    setEditError(null);
    setView("edit");
  }

  function submitSimple(d: "approve" | "reject") {
    onSubmit(approval.actionRequests.map(() => ({ type: d })));
  }

  function submitEdit() {
    try {
      const decisions = approval.actionRequests.map((a, i) => {
        const orig = (a.args ?? {}) as Record<string, unknown>;
        const args = Object.fromEntries(
          Object.entries(drafts[i] ?? {}).map(([k, text]) => [
            k,
            typeof orig[k] === "string" ? text : JSON.parse(text),
          ]),
        );
        return { type: "edit", editedAction: { name: a.name, args } };
      });
      onSubmit(decisions);
    } catch {
      setEditError("Invalid JSON in a non-text field — fix it and try again.");
    }
  }

  function submitReply() {
    onSubmit(
      approval.actionRequests.map(() => ({ type: "respond", message: reply })),
    );
  }

  return (
    <PromptPanel
      icon={ShieldAlert}
      title="Needs your sign-off"
      glow
      footer={
        view === "review" ? (
          <>
            {allowed.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={
                  d === "reject"
                    ? "destructive"
                    : d === "approve"
                      ? "default"
                      : "secondary"
                }
                onClick={() =>
                  d === "edit"
                    ? startEdit()
                    : d === "respond"
                      ? setView("reply")
                      : submitSimple(d)
                }
              >
                {DECISION_LABEL[d] ?? d}
              </Button>
            ))}
            {!allowed.includes("respond") && (
              <Button size="sm" variant="secondary" onClick={() => setView("reply")}>
                Reply
              </Button>
            )}
          </>
        ) : view === "edit" ? (
          <>
            <Button size="sm" onClick={submitEdit}>
              Save & approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setView("review")}>
              Cancel
            </Button>
            {editError && (
              <p className="text-xs text-destructive" role="alert">
                {editError}
              </p>
            )}
          </>
        ) : (
          <>
            <Button size="sm" disabled={!reply.trim()} onClick={submitReply}>
              Send reply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setView("review")}>
              Cancel
            </Button>
          </>
        )
      }
    >
      {view === "reply" ? (
        <Textarea
          autoFocus
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Your reply is returned to the agent as the tool result…"
          className="min-h-20"
        />
      ) : (
        <div className="space-y-4">
          {approval.actionRequests.map((a, i) => (
            <div key={i} className="space-y-2 text-sm">
              <div className="text-muted-foreground">
                Tool:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                  {a.name}
                </code>
              </div>
              {view === "edit" ? (
                <div className="space-y-2">
                  {Object.entries(drafts[i] ?? {}).map(([k, text]) => (
                    <label key={k} className="block space-y-1">
                      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {k}
                      </span>
                      <Textarea
                        value={text}
                        onChange={(e) =>
                          setDrafts((prev) =>
                            prev.map((d, j) =>
                              j === i ? { ...d, [k]: e.target.value } : d,
                            ),
                          )
                        }
                        className="min-h-9"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <dl className="space-y-1.5">
                  {argEntries(a).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {k}
                      </dt>
                      <dd className="whitespace-pre-wrap text-foreground/90">
                        {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          ))}
        </div>
      )}
    </PromptPanel>
  );
}
