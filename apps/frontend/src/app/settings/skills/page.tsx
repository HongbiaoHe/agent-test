"use client";

import { Search } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { InstallForm } from "./_components/install-form";
import { SkillList, type SourceFilter } from "./_components/skill-list";

// /settings/skills：技能管理——搜索 / 来源筛选 / domain 分组 / 安装 / 启停 / 更新 / 删除 / 详情。
export default function SkillsSettingsPage() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Skills</h2>
        <p className="text-sm text-muted-foreground">
          Manage the skills available to the agent: built-in skills ship with
          the system, and you can install third-party skills from GitHub.
        </p>
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
          </TabsList>
        </Tabs>
      </div>

      <SkillList search={search} source={source} />
    </div>
  );
}
