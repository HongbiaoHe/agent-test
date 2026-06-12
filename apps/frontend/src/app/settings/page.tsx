import { redirect } from "next/navigation";

// /settings 默认进 Skills 分区
export default function SettingsPage() {
  redirect("/settings/skills");
}
