// modes 用例专用的接口工具（模式 CRUD、通用模式设置、平台片段）。
import type { Page } from "@playwright/test";

import type { AgentMode, AgentModeInput, GeneralModeSettings, PromptFragment } from "@/lib/api";

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

export function listFragments(page: Page): Promise<PromptFragment[]> {
  return apiOk<PromptFragment[]>(page, "/modes/fragments");
}

/** 某个平台片段的当前状态（GET /modes/fragments 里按 id 取）。 */
export async function getFragment(page: Page, id: string): Promise<PromptFragment> {
  const found = (await listFragments(page)).find((f) => f.id === id);
  if (!found) throw new Error(`fragment ${id} not listed`);
  return found;
}

/** 用接口改写片段正文（null = 恢复默认）。 */
export function setFragment(page: Page, id: string, text: string | null): Promise<PromptFragment> {
  return apiOk<PromptFragment>(page, `/modes/fragments/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { text },
  });
}

/** 清理：全部平台片段恢复默认。 */
export async function resetFragments(page: Page): Promise<void> {
  for (const f of await listFragments(page)) {
    if (f.isCustom) await setFragment(page, f.id, null);
  }
}

/** 用接口新建自建片段（id 形如 custom.<名字>）。 */
export function createCustomFragment(
  page: Page,
  input: { id: string; title: string; text: string },
): Promise<PromptFragment> {
  return apiOk<PromptFragment>(page, "/modes/fragments", { method: "POST", body: input });
}

/**
 * 清理：删掉全部自建片段。要排在删模式、重置通用设置之后，否则会被引用保护（409）挡住。
 */
export async function deleteAllCustomFragments(page: Page): Promise<void> {
  for (const f of await listFragments(page)) {
    if (f.kind === "custom") {
      await apiOk(page, `/modes/fragments/${encodeURIComponent(f.id)}`, { method: "DELETE" });
    }
  }
}
