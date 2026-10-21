"use client";

import { Plus, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  CustomSkillEditor,
  type CustomSkillEditorTarget,
} from "./_components/custom-skill-editor";
import { InstallForm } from "./_components/install-form";
import { SkillList, type SourceFilter } from "./_components/skill-list";

// /settings/skills：技能管理——搜索 / 来源筛选 / 分类（Built-in/GitHub/Custom）分组 / 安装 / 手写新建与编辑 / 启停 / 更新 / 删除 / 详情。
export default function SkillsSettingsPage() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [editor, setEditor] = useState<CustomSkillEditorTarget | null>(null);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="text-sm text-muted-foreground">
            Manage the skills available to the agent: built-in skills ship with
            the system, you can install third-party skills from GitHub, or
            write your own in Markdown.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setEditor({ mode: "create" })}>
          <Plus /> New skill
        </Button>
      </header>

      <InstallForm />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills…"
            className="h-9 pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Tabs value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
            <TabsTrigger value="github">GitHub</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <SkillList
        search={search}
        source={source}
        onEdit={(name) => setEditor({ mode: "edit", name })}
      />
      <CustomSkillEditor target={editor} onClose={() => setEditor(null)} />
    </div>
  );
}
