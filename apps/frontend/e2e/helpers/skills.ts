// skills 用例专用的接口工具（技能 CRUD、/ 命令清单）。
import type { Page } from "@playwright/test";

import type { CommandInfo, SkillDetail, SkillInfo } from "@/lib/api";

import { apiOk } from "../helpers";

export function listSkills(page: Page): Promise<SkillInfo[]> {
  return apiOk<SkillInfo[]>(page, "/skills");
}

export function getSkill(page: Page, name: string): Promise<SkillDetail> {
  return apiOk<SkillDetail>(page, `/skills/${encodeURIComponent(name)}`);
}

export function listCommands(page: Page): Promise<CommandInfo[]> {
  return apiOk<CommandInfo[]>(page, "/commands");
}

/** 用接口建一个手写技能。 */
export function createCustomSkill(
  page: Page,
  input: { name: string; description: string; body: string },
): Promise<SkillInfo> {
  return apiOk<SkillInfo>(page, "/skills/custom", { method: "POST", body: input });
}

/** 清理：删掉测试账号下全部非内置技能（账号专用，留下的只可能是本套用例建 / 装的）。 */
export async function deleteUserSkills(page: Page): Promise<void> {
  for (const s of await listSkills(page)) {
    if (s.kind === "builtin") continue;
    await apiOk(page, `/skills/${encodeURIComponent(s.name)}`, { method: "DELETE" });
  }
}
