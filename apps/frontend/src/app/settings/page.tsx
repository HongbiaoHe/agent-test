import { redirect } from "next/navigation";

// /settings 默认进个人信息（Profile）分区
export default function SettingsPage() {
  redirect("/settings/profile");
}
