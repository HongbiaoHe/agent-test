"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PackageOpen, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type SkillInfo,
  deleteSkill,
  installSkill,
  listSkills,
  parseGithubSource,
  toggleSkill,
} from "@/lib/api";

import { SkillDetailSheet, skillDetailKey } from "./skill-detail-sheet";

export const SKILLS_QUERY_KEY = ["skills"] as const;

export type SourceFilter = "all" | "builtin" | "github";

/** 技能列表：搜索过滤 / 来源筛选 / domain 分组 / 启停 / 删除 / 更新 / 详情。 */
export function SkillList({
  search,
  source,
}: {
  search: string;
  source: SourceFilter;
}) {
  const [detailName, setDetailName] = useState<string | null>(null);

  const query = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: listSkills,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load skills"}
        </CardContent>
      </Card>
    );
  }

  const skills = query.data ?? [];

  if (skills.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <PackageOpen className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No skills yet — install one from the form above.
          </p>
        </CardContent>
      </Card>
    );
  }

  const q = search.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    if (source === "builtin" && s.source !== "builtin") return false;
    if (source === "github" && s.source === "builtin") return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  });

  if (filtered.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No skills match your filters.
          </p>
        </CardContent>
      </Card>
    );
  }

  const groups = new Map<string, SkillInfo[]>();
  for (const s of filtered) {
    const list = groups.get(s.domain) ?? [];
    list.push(s);
    groups.set(s.domain, list);
  }
  const domains = [...groups.keys()].sort();

  return (
    <div className="space-y-6">
      {domains.map((domain) => (
        <section key={domain} className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {domain}
          </h3>
          <div className="space-y-3">
            {groups.get(domain)!.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                onOpenDetail={() => setDetailName(skill.name)}
              />
            ))}
          </div>
        </section>
      ))}
      <SkillDetailSheet name={detailName} onClose={() => setDetailName(null)} />
    </div>
  );
}

/** 单条技能卡片：名称、描述（截断）、来源徽章、更新（GitHub）、启停开关、删除（带确认）。 */
function SkillCard({
  skill,
  onOpenDetail,
}: {
  skill: SkillInfo;
  onOpenDetail: () => void;
}) {
  const qc = useQueryClient();
  const isBuiltin = skill.source === "builtin";
  const [confirming, setConfirming] = useState(false);

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => toggleSkill(skill.name, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: skillDetailKey(skill.name) });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteSkill(skill.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      qc.removeQueries({ queryKey: skillDetailKey(skill.name) });
    },
  });

  const updateMut = useMutation({
    mutationFn: () => {
      const src = parseGithubSource(skill.source);
      if (!src) throw new Error("Unrecognized source format");
      return installSkill(src);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: skillDetailKey(skill.name) });
    },
  });

  const hasError =
    toggleMut.isError || deleteMut.isError || updateMut.isError;
  const errorMessage = (
    toggleMut.error ?? deleteMut.error ?? updateMut.error
  ) instanceof Error
    ? ((toggleMut.error ?? deleteMut.error ?? updateMut.error) as Error)
        .message
    : "Action failed";

  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        !skill.enabled && "opacity-60",
      )}
      role="button"
      tabIndex={0}
      aria-label={`View ${skill.name} details`}
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        // 只响应卡片自身的按键：内部 Switch/按钮的 keydown 会冒泡上来，
        // 若不拦截，preventDefault 会取消原生按钮激活且误开详情
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{skill.name}</span>
            <Badge variant={isBuiltin ? "secondary" : "outline"}>
              {isBuiltin ? "Built-in" : "GitHub"}
            </Badge>
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {skill.description || "(No description)"}
          </p>
          {hasError && (
            <p className="text-xs text-destructive" role="alert">
              {errorMessage}
            </p>
          )}
        </div>

        {/* 内置技能不可启停/删除/更新：隐藏控件 */}
        {!isBuiltin && (
          <div
            className="flex shrink-0 items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Update skill"
                    disabled={updateMut.isPending}
                    onClick={() => updateMut.mutate()}
                  />
                }
              >
                {updateMut.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
              </TooltipTrigger>
              <TooltipContent>Reinstall from source</TooltipContent>
            </Tooltip>

            <Switch
              aria-label={skill.enabled ? "Disable skill" : "Enable skill"}
              checked={skill.enabled}
              disabled={toggleMut.isPending}
              onCheckedChange={(checked) => toggleMut.mutate(checked)}
            />
            {confirming ? (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteMut.isPending}
                  onClick={() => deleteMut.mutate()}
                >
                  {deleteMut.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Confirm delete"
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deleteMut.isPending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete skill"
                onClick={() => setConfirming(true)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
