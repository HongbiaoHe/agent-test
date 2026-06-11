"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PackageOpen, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type SkillInfo,
  deleteSkill,
  listSkills,
  toggleSkill,
} from "@/lib/api";

export const SKILLS_QUERY_KEY = ["skills"] as const;

/** 技能列表：加载骨架 / 空态 / 每条技能一张卡片（启停 + 删除，内置项隐藏控件）。 */
export function SkillList() {
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
          {query.error instanceof Error ? query.error.message : "Failed to load skills"}
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

  return (
    <div className="space-y-3">
      {skills.map((skill) => (
        <SkillCard key={skill.name} skill={skill} />
      ))}
    </div>
  );
}

/** 单条技能卡片：名称、描述（截断）、来源徽章、启停开关、删除（带确认）。 */
function SkillCard({ skill }: { skill: SkillInfo }) {
  const qc = useQueryClient();
  const isBuiltin = skill.source === "builtin";
  // 删除前需点两次确认，避免误删
  const [confirming, setConfirming] = useState(false);

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => toggleSkill(skill.name, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteSkill(skill.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
  });

  return (
    <Card>
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
          {(toggleMut.isError || deleteMut.isError) && (
            <p className="text-xs text-destructive" role="alert">
              {(toggleMut.error ?? deleteMut.error) instanceof Error
                ? (toggleMut.error ?? deleteMut.error)?.message
                : "Action failed"}
            </p>
          )}
        </div>

        {/* 内置技能不可启停/删除：隐藏控件 */}
        {!isBuiltin && (
          <div className="flex shrink-0 items-center gap-3">
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
