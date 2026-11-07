"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { getGeneralMode, getModeCatalog } from "@/lib/api";

import { FragmentSection } from "./_components/fragment-list";
import { ModeEditor, MODE_CATALOG_KEY, type ModeEditorTarget } from "./_components/mode-editor";
import { GENERAL_MODE_QUERY_KEY, GeneralModeCard, ModeList } from "./_components/mode-list";

// /settings/modes：agent 模式管理——通用模式（置顶，只可编辑）+ 用户模式列表 / 新建 / 从通用模式复制 /
// 编辑 / 删除 / 预览最终提示词；页面底部是提示词片段（内置 {{platform.*}} 可改写，自建 {{custom.*}} 可增删改）。
export default function ModesSettingsPage() {
  const [editor, setEditor] = useState<ModeEditorTarget | null>(null);
  // 「Duplicate general」用生效的通用提示词（含用户自定义）+ 目录里全部可选项预填；与卡片 / 编辑器共用缓存
  const catalog = useQuery({ queryKey: MODE_CATALOG_KEY, queryFn: getModeCatalog });
  const general = useQuery({ queryKey: GENERAL_MODE_QUERY_KEY, queryFn: getGeneralMode });

  function duplicateGeneral() {
    const c = catalog.data;
    const g = general.data;
    if (!c || !g) return;
    setEditor({
      mode: "create",
      initial: {
        name: "General (copy)",
        systemPrompt: g.systemPrompt,
        toolNames: c.tools.map((t) => t.name),
        mcpServerIds: c.mcpServers.map((s) => s.id),
        skillNames: c.skills.map((s) => s.name),
        defaultModel: null,
        defaultThinkingLevel: null,
      },
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Modes</h2>
          <p className="text-sm text-muted-foreground">
            A mode gives the agent its own system prompt and a chosen set of
            tools, connectors and skills. Pick one per conversation; without
            one, the agent runs in the general mode with everything enabled.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            onClick={duplicateGeneral}
            disabled={!catalog.data || !general.data}
            title="Start from the general mode's prompt with everything selected"
          >
            <Copy /> Duplicate general
          </Button>
          <Button onClick={() => setEditor({ mode: "create" })}>
            <Plus /> New mode
          </Button>
        </div>
      </header>

      <div className="space-y-3">
        <GeneralModeCard onEdit={(settings) => setEditor({ mode: "general", settings })} />
        <ModeList onEdit={(item) => setEditor({ mode: "edit", item })} />
      </div>
      <FragmentSection />
      <ModeEditor target={editor} onClose={() => setEditor(null)} />
    </div>
  );
}
