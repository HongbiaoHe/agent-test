/**
 * 设置 → 技能（内容拷自 Web /settings/skills：搜索 / 来源筛选 / 按 Built-in · GitHub · Custom 分组 / 安装 /
 * 手写新建与编辑 / 启停 / 更新 / 删除 / 详情）。安装表单改为兼容 npx skills add 的单栏写法。
 */
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CustomSkillEditor, type CustomSkillEditorTarget } from './components/custom-skill-editor';
import { InstallForm } from './components/install-form';
import { SkillList, type SourceFilter } from './components/skill-list';

const SOURCES: readonly SourceFilter[] = ['all', 'builtin', 'github', 'custom'];
const isSource = (v: unknown): v is SourceFilter => SOURCES.some((s) => s === v);

export function SkillsSettings() {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [editor, setEditor] = useState<CustomSkillEditorTarget | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          也可以在对话里用 <code className="font-mono">/create-skills</code> 让 agent 帮你写一个技能。
        </p>
        <Button className="shrink-0" onClick={() => setEditor({ mode: 'create' })}>
          <Plus /> New skill
        </Button>
      </div>

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
        <Tabs value={source} onValueChange={(v) => isSource(v) && setSource(v)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
            <TabsTrigger value="github">GitHub</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <SkillList search={search} source={source} onEdit={(name) => setEditor({ mode: 'edit', name })} />
      <CustomSkillEditor target={editor} onClose={() => setEditor(null)} />
    </div>
  );
}
