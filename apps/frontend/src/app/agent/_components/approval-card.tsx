"use client";

import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import type { Approval, Decision } from "../_lib/thread";

const DECISION_LABEL: Record<Decision, string> = {
  approve: "批准",
  reject: "拒绝",
  edit: "编辑",
  respond: "回复",
};

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (d: Decision) => void;
}) {
  const allowed = (approval.reviewConfigs?.[0]?.allowedDecisions ?? [
    "approve",
    "reject",
  ]) as Decision[];

  return (
    <Card className="gap-3 border-primary/40 bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert className="size-4 text-primary" />
        需要你的审批
      </div>
      <div className="space-y-2">
        {approval.actionRequests.map((a, i) => (
          <div key={i} className="text-sm">
            <div className="text-muted-foreground">
              工具：
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                {a.name}
              </code>
            </div>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-muted/60 p-2 font-mono text-xs text-foreground/90">
              {JSON.stringify(a.args, null, 2)}
            </pre>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
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
            onClick={() => onDecide(d)}
          >
            {DECISION_LABEL[d] ?? d}
          </Button>
        ))}
        {!allowed.includes("respond") && (
          <Button size="sm" variant="secondary" onClick={() => onDecide("respond")}>
            回复
          </Button>
        )}
      </div>
    </Card>
  );
}
