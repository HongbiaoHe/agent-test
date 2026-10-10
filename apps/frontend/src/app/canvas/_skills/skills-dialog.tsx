"use client";

import {
  ArrowLeft,
  FileText,
  Loader2,
  Lock,
  Plus,
  Slash,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { CanvasSkillInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

import { Markdown } from "../_components/markdown";
import {
  useCanvasSkillDetail,
  useCanvasSkillMutations,
  useCanvasSkills,
} from "./use-canvas-skills";

/** 新建技能入口：交给内置的 skills-creator 带着 agent 一起写 */
export const CREATOR_SKILL = "skills-creator";

/**
 * 画布技能管理：看有哪些技能、读它的说明、启停与删除自己的技能。
 * 内置技能只读（不能删、不能停）；新建与修改走 agent（skills-creator），这里不做表单——
 * 一份好的工作流说明要按画布能力来写，交给 agent 引导比让人对着空白文本框写靠谱。
 *
 * 列表用原生 overflow-y-auto 而不是 ScrollArea：弹窗用 max-h 时 ScrollArea 的视口不裁剪。
 */
export function SkillsDialog({
  open,
  onOpenChange,
  onUse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 把 `/技能名 ` 放进输入框（「使用」/「新建」都走它） */
  onUse: (name: string) => void;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const skills = useCanvasSkills();

  // 无论从哪条路关掉（×、遮罩、「使用」），下次打开都回到列表
  const setOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next) setViewing(null);
  };
  const use = (name: string) => {
    onUse(name);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[min(40rem,85vh)] flex-col gap-0 p-0 sm:max-w-xl">
        {viewing ? (
          <SkillDetail
            name={viewing}
            onBack={() => setViewing(null)}
            onUse={use}
          />
        ) : (
          <>
            <DialogHeader className="border-b border-border px-5 pt-5 pb-4">
              <DialogTitle>Skills</DialogTitle>
              <DialogDescription>
                Reusable workflows the canvas agent follows. Type{" "}
                <kbd className="rounded bg-muted px-1 font-mono text-[11px] text-foreground">
                  /
                </kbd>{" "}
                in the chat to run one.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {skills.isLoading ? (
                <div className="flex justify-center py-10 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : (
                <SkillList
                  skills={skills.data ?? []}
                  onOpen={setViewing}
                  onCreate={() => use(CREATOR_SKILL)}
                />
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                The agent writes new skills with you.
              </p>
              <Button size="sm" onClick={() => use(CREATOR_SKILL)}>
                <Plus className="size-3.5" />
                New skill
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SkillList({
  skills,
  onOpen,
  onCreate,
}: {
  skills: CanvasSkillInfo[];
  onOpen: (name: string) => void;
  onCreate: () => void;
}) {
  const builtins = skills.filter((s) => s.kind === "builtin");
  const mine = skills.filter((s) => s.kind === "user");
  return (
    <div className="space-y-3">
      <Group title="Built-in">
        {builtins.map((s) => (
          <SkillRow key={s.name} skill={s} onOpen={onOpen} />
        ))}
      </Group>
      <Group title="Your skills">
        {mine.length === 0 ? (
          <div className="mx-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
            <p className="text-sm text-foreground">No skills of your own yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Describe a workflow you repeat — like a product teaser in three
              shots — and the agent turns it into a skill.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={onCreate}
            >
              <Slash className="size-3.5" />
              {CREATOR_SKILL}
            </Button>
          </div>
        ) : (
          mine.map((s) => <SkillRow key={s.name} skill={s} onOpen={onOpen} />)
        )}
      </Group>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function SkillRow({
  skill,
  onOpen,
}: {
  skill: CanvasSkillInfo;
  onOpen: (name: string) => void;
}) {
  const { toggle, remove } = useCanvasSkillMutations();
  const [confirming, setConfirming] = useState(false);
  const builtin = skill.kind === "builtin";
  const busy = toggle.isPending || remove.isPending;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/60",
        !skill.enabled && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(skill.name)}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <span className="truncate">{skill.name}</span>
          {builtin && (
            <Lock
              className="size-3 shrink-0 text-muted-foreground"
              aria-label="Built-in, can't be removed"
            />
          )}
          {!skill.enabled && (
            <span className="text-xs font-normal text-muted-foreground">
              Off
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {skill.description}
        </span>
      </button>

      {!builtin &&
        (confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                remove.mutate(skill.name, {
                  onSettled: () => setConfirming(false),
                })
              }
            >
              {remove.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                "Delete"
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <Switch
              size="sm"
              checked={skill.enabled}
              disabled={busy}
              aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
              onCheckedChange={(enabled) =>
                toggle.mutate({ name: skill.name, enabled })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Delete ${skill.name}`}
              title="Delete"
              onClick={() => setConfirming(true)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
    </div>
  );
}

/** 去掉 frontmatter：名称和说明已在标题区，正文按 Markdown 渲染 */
function body(skillMd: string): string {
  return skillMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

function SkillDetail({
  name,
  onBack,
  onUse,
}: {
  name: string;
  onBack: () => void;
  onUse: (name: string) => void;
}) {
  const detail = useCanvasSkillDetail(name);
  const d = detail.data;

  return (
    <>
      <DialogHeader className="border-b border-border px-5 pt-4 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All skills
        </button>
        <DialogTitle className="flex items-center gap-1.5 pt-1">
          <span className="truncate">{name}</span>
          {d?.kind === "builtin" && (
            <Lock className="size-3.5 text-muted-foreground" aria-label="Built-in" />
          )}
        </DialogTitle>
        {d && <DialogDescription>{d.description}</DialogDescription>}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {detail.isLoading || !d ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <>
            {d.files.length > 1 && (
              <ul className="mb-4 space-y-1 rounded-lg bg-muted/60 px-3 py-2">
                {d.files.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                  >
                    <FileText className="size-3 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            )}
            <Markdown className="text-sm">{body(d.content)}</Markdown>
          </>
        )}
      </div>
      <div className="flex justify-end border-t border-border px-5 py-3">
        <Button
          size="sm"
          disabled={!d?.enabled}
          onClick={() => onUse(name)}
        >
          <Slash className="size-3.5" />
          Use in chat
        </Button>
      </div>
    </>
  );
}
