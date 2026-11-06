// modes 用例专用的接口工具（模式 CRUD、通用模式设置）。
import type { Page } from "@playwright/test";

import type { AgentMode, AgentModeInput, GeneralModeSettings } from "@/lib/api";

import { apiOk } from "../helpers";

export function listModes(page: Page): Promise<AgentMode[]> {
  return apiOk<AgentMode[]>(page, "/modes");
}

export function getGeneral(page: Page): Promise<GeneralModeSettings> {
  return apiOk<GeneralModeSettings>(page, "/modes/general");
}

/** 用接口建一个模式（未给的字段取空 / 跟随会话）。 */
export function createMode(
  page: Page,
  input: Partial<AgentModeInput> & Pick<AgentModeInput, "name" | "systemPrompt">,
): Promise<AgentMode> {
  return apiOk<AgentMode>(page, "/modes", {
    method: "POST",
    body: {
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
      ...input,
    },
  });
}

/** 清理：删掉测试账号下的全部模式（账号专用，留下的只可能是本套用例建的）。 */
export async function deleteAllModes(page: Page): Promise<void> {
  for (const m of await listModes(page)) {
    await apiOk(page, `/modes/${m.id}`, { method: "DELETE" });
  }
}

/** 清理：通用模式恢复全默认（默认提示词、跟随会话的模型与思考档位）。 */
export async function resetGeneral(page: Page): Promise<void> {
  await apiOk(page, "/modes/general", {
    method: "PUT",
    body: { systemPrompt: null, defaultModel: null, defaultThinkingLevel: null },
  });
}
