"use client";

import { MessageCircleQuestion } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { AskUserAnswer } from "../_lib/thread";

/**
 * ask_user 作答后的问答回显（对齐 Claude Code 的 "User answered Claude's questions"）：
 * 每题一行「问题 → 回答」，倒计时 / 超时自动采用建议答案的标出来，方便事后回看 agent 依据了什么。
 */
export function AskUserAnswers({ answers }: { answers: AskUserAnswer[] }) {
  const allAuto = answers.every((a) => a.auto);
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestion className="size-3.5" />
        {allAuto ? "No reply in time — suggested answers were used" : "You answered"}
      </div>
      <ul className="space-y-1.5">
        {answers.map((a, i) => (
          <li key={i} className="space-y-0.5">
            <div className="text-muted-foreground">{a.question}</div>
            <div className="flex flex-wrap items-center gap-2 pl-3">
              <span className="font-medium text-foreground">
                → {a.selected.length > 0 ? a.selected.join("、") : "—"}
              </span>
              {a.auto && !allAuto && <Badge variant="outline">Suggested</Badge>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
