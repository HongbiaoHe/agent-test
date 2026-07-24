"use client";

import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import type { Approval } from "../_lib/thread";
import { PromptPanel } from "./prompt-panel";

/** 前端倒计时：到点自动提交 approve（采纳建议答案）。服务端另有 10 分钟兜底。 */
const COUNTDOWN_S = 60;
/** 单选里「其他（自定义）」的 radio 值占位（不会与选项 label 冲突的内部哨兵） */
const CUSTOM_VALUE = "__custom__";

interface AskUserOption {
  label: string;
  description?: string;
}

interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserOption[];
  suggested: string[];
}

/**
 * 分流谓词：chat-thread 据此决定渲染 QuestionPanel 还是回退 ApprovalPanel。
 * 仅接管「单一 ask_user 调用且 questions 形状合法」；其余（混排/异常参数）走老面板兜底。
 */
export function isAskUserApproval(approval: Approval): boolean {
  if (approval.actionRequests.length !== 1) return false;
  const req = approval.actionRequests[0];
  if (req.name !== "ask_user") return false;
  const qs = (req.args as { questions?: unknown } | null)?.questions;
  return Array.isArray(qs) && qs.length > 0;
}

/** 每题的作答状态：selected=选中的选项 label；custom/useCustom=「其他」自定义 */
interface AnswerState {
  selected: string[];
  custom: string;
  useCustom: boolean;
}

/**
 * ask_user 提问面板（渲染在输入框上方，外壳与审批面板一致）：
 * - 单选 RadioGroup / 多选 Checkbox，每题带「其他（自定义）」；建议答案默认预选并带徽标。
 * - 60s 倒计时：无任何交互到点 → 自动提交 approve（= 采纳建议答案）；
 *   用户一旦交互（点选/输入）立即取消倒计时，转纯手动提交。
 * - 手动提交走 edit 决策：用户答案写进 args.answers，工具按改后参数执行
 *   （本版 langchain HITL 无 respond 决策，见 ask-user.tool.ts 注释）。
 */
export function QuestionPanel({
  approval,
  onSubmit,
}: {
  approval: Approval;
  onSubmit: (decisions: unknown[]) => void;
}) {
  // isAskUserApproval 已校验过形状，这里做同构反序列化（自有协议数据，安全）
  const args = approval.actionRequests[0].args as { questions: AskUserQuestion[] };
  const questions = args.questions;

  const [answers, setAnswers] = useState<AnswerState[]>(() =>
    questions.map((q) => {
      // 防御性归一化（与 ask-user.tool.ts 的 normalizeSuggested 同规则）：
      // suggested 过滤到合法 label，全无效回退首选项；单选只取第一个
      const labels = new Set(q.options.map((o) => o.label));
      const valid = q.suggested.filter((s) => labels.has(s));
      const picks = valid.length > 0 ? valid : [q.options[0]?.label ?? ""];
      return {
        selected: q.multiSelect ? picks : [picks[0]],
        custom: "",
        useCustom: false,
      };
    }),
  );
  const [interacted, setInteracted] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_S);
  const submittedRef = useRef(false);

  // 倒计时递减：interacted 后停表（setTimeout 链，回调内 setState 合规）
  useEffect(() => {
    if (interacted || secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft, interacted]);

  // 到点自动采纳建议答案（approve）；submittedRef 防 StrictMode/重渲染重复提交
  useEffect(() => {
    if (interacted || secondsLeft > 0 || submittedRef.current) return;
    submittedRef.current = true;
    onSubmit([{ type: "approve" }]);
  }, [secondsLeft, interacted, onSubmit]);

  function touch() {
    if (!interacted) setInteracted(true);
  }

  function patchAnswer(i: number, patch: Partial<AnswerState>) {
    touch();
    setAnswers((prev) =>
      prev.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    );
  }

  function submit() {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const payload = questions.map((q, i) => {
      const a = answers[i];
      const picks = [...a.selected];
      if (a.useCustom && a.custom.trim())
        picks.push(`自定义：${a.custom.trim()}`);
      return { header: q.header, selected: picks };
    });
    onSubmit([
      {
        type: "edit",
        editedAction: { name: "ask_user", args: { questions, answers: payload } },
      },
    ]);
  }

  /** 每题至少有一个有效答案（选项或非空自定义）才允许提交 */
  const canSubmit = answers.every(
    (a) => a.selected.length > 0 || (a.useCustom && a.custom.trim().length > 0),
  );

  return (
    <PromptPanel
      icon={MessageCircleQuestion}
      title="Spark 想确认几件事"
      glow
      footer={
        <>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            提交回答
          </Button>
          {!interacted && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width] duration-1000 ease-linear"
                  style={{ width: `${(secondsLeft / COUNTDOWN_S) * 100}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {secondsLeft}s 后自动采用建议答案
              </span>
            </div>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {questions.map((q, i) => {
          const a = answers[i];
          return (
            <div key={i} className="space-y-2 text-sm">
              <div className="font-medium text-foreground">{q.question}</div>
              {q.multiSelect ? (
                <div className="space-y-1.5">
                  {q.options.map((opt) => (
                    <label
                      key={opt.label}
                      className="flex cursor-pointer items-start gap-2"
                    >
                      <Checkbox
                        checked={a.selected.includes(opt.label)}
                        onCheckedChange={(checked) =>
                          patchAnswer(i, {
                            selected: checked
                              ? [...a.selected, opt.label]
                              : a.selected.filter((s) => s !== opt.label),
                          })
                        }
                        className="mt-0.5"
                      />
                      <OptionText
                        option={opt}
                        suggested={q.suggested.includes(opt.label)}
                      />
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-start gap-2">
                    <Checkbox
                      checked={a.useCustom}
                      onCheckedChange={(checked) =>
                        patchAnswer(i, { useCustom: checked === true })
                      }
                      className="mt-0.5"
                    />
                    <span className="text-foreground/90">其他（补充说明）</span>
                  </label>
                </div>
              ) : (
                <RadioGroup
                  value={a.useCustom ? CUSTOM_VALUE : (a.selected[0] ?? "")}
                  onValueChange={(value) =>
                    value === CUSTOM_VALUE
                      ? patchAnswer(i, { useCustom: true, selected: [] })
                      : patchAnswer(i, {
                          useCustom: false,
                          selected: typeof value === "string" ? [value] : [],
                        })
                  }
                  className="gap-1.5"
                >
                  {q.options.map((opt) => (
                    <label
                      key={opt.label}
                      className="flex cursor-pointer items-start gap-2"
                    >
                      <RadioGroupItem value={opt.label} className="mt-0.5" />
                      <OptionText
                        option={opt}
                        suggested={q.suggested.includes(opt.label)}
                      />
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-start gap-2">
                    <RadioGroupItem value={CUSTOM_VALUE} className="mt-0.5" />
                    <span className="text-foreground/90">其他（自定义）</span>
                  </label>
                </RadioGroup>
              )}
              {a.useCustom && (
                <Input
                  autoFocus
                  value={a.custom}
                  onChange={(e) => patchAnswer(i, { custom: e.target.value })}
                  onFocus={touch}
                  placeholder="输入你的答案…"
                  className="h-8"
                />
              )}
            </div>
          );
        })}
      </div>
    </PromptPanel>
  );
}

/** 选项文案：label +（可选）description，建议项带徽标 */
function OptionText({
  option,
  suggested,
}: {
  option: AskUserOption;
  suggested: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className="text-foreground/90">{option.label}</span>
      {suggested && (
        <Badge variant="secondary" className="ml-1.5 align-middle">
          建议
        </Badge>
      )}
      {option.description && (
        <span className="block text-xs text-muted-foreground">
          {option.description}
        </span>
      )}
    </span>
  );
}
