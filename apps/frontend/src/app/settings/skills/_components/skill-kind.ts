import type { SkillKind } from "@/lib/api";

/** 技能分类的展示名（列表分组、徽章、详情共用）。 */
export const KIND_LABEL: Record<SkillKind, string> = {
  builtin: "Built-in",
  github: "GitHub",
  custom: "Custom",
};
