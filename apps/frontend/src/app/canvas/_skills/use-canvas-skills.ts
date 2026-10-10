"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteCanvasSkill,
  getCanvasSkill,
  listCanvasSkills,
  setCanvasSkillEnabled,
} from "@/lib/api";

export const CANVAS_SKILLS_KEY = ["canvas-skills"] as const;

/** 当前用户的画布技能（含停用的；补全菜单自己过滤 enabled）。 */
export function useCanvasSkills() {
  return useQuery({
    queryKey: CANVAS_SKILLS_KEY,
    queryFn: listCanvasSkills,
    staleTime: 30_000,
  });
}

export function useCanvasSkillDetail(name: string | null) {
  return useQuery({
    queryKey: [...CANVAS_SKILLS_KEY, "detail", name],
    // enabled 已挡住 null；这里再收窄一次，不用断言
    queryFn: () =>
      name ? getCanvasSkill(name) : Promise.reject(new Error("no skill")),
    enabled: !!name,
  });
}

/** 启停 / 删除：成功后刷新列表（补全菜单与管理弹窗共用同一份缓存） */
export function useCanvasSkillMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: CANVAS_SKILLS_KEY });
  return {
    toggle: useMutation({
      mutationFn: (v: { name: string; enabled: boolean }) =>
        setCanvasSkillEnabled(v.name, v.enabled),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (name: string) => deleteCanvasSkill(name),
      onSuccess: refresh,
    }),
    refresh,
  };
}
