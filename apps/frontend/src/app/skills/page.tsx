import { redirect } from "next/navigation";

// 旧路由迁移：技能管理已并入 /settings/skills
export default function SkillsPage() {
  redirect("/settings/skills");
}
