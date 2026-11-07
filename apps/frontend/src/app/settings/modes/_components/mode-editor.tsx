"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Loader2, RotateCcw, Search } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type AgentMode,
  type AgentModeInput,
  type GeneralModeSettings,
  type ModeCatalog,
  type ModePreview,
  createMode,
  getModeCatalog,
  previewGeneralMode,
  previewMode,
  updateGeneralMode,
  updateMode,
} from "@/lib/api";
import { asThinkingLevel, thinkingLevelsFor } from "@/lib/thinking-level";
import { cn } from "@/lib/utils";

import { MODEL_OPTIONS, modelDisplayName } from "@/app/agent/_lib/models";

import { count, GENERAL_MODE_QUERY_KEY, MODES_QUERY_KEY } from "./mode-list";
import { PromptPreviewDialog } from "./prompt-preview-dialog";

/** 目录缓存键（工具 / 连接器 / 技能 / 占位符 / 通用提示词 / 本环境 capability）。 */
export const MODE_CATALOG_KEY = ["mode-catalog"] as const;

/**
 * 编辑器打开方式：新建（可带预填，如「Duplicate general」）、编辑已有模式，或编辑通用模式
 * （名称固定、工具 / 连接器 / 技能恒为全部只读；只改提示词与默认模型，可恢复默认提示词）。
 */
export type ModeEditorTarget =
  | { mode: "create"; initial?: AgentModeInput }
  | { mode: "edit"; item: AgentMode }
  | { mode: "general"; settings: GeneralModeSettings };

const EMPTY_INPUT: AgentModeInput = {
  name: "",
  systemPrompt: "",
  toolNames: [],
  mcpServerIds: [],
  skillNames: [],
  defaultModel: null,
  defaultThinkingLevel: null,
};

/** Select 不接受 null 值：用哨兵表示「跟随会话」。 */
const FOLLOW = "__follow__";

/**
 * 模式编辑器：名称 + 完整 system prompt（可插入平台占位符）+ 工具 / 连接器 / 技能勾选
 * + 可选默认模型与思考深度；「Preview prompt」看后端拼装后的最终提示词。
 * 目录（可选项）打开时拉一次；表单初始值只取一次（按 target 重挂）。
 */
export function ModeEditor({
  target,
  onClose,
}: {
  target: ModeEditorTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(52rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        {target && (
          <CatalogLoader
            key={target.mode === "edit" ? target.item.id : target.mode}
            target={target}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 先拉目录（勾选项来源），拿到再挂表单。 */
function CatalogLoader({
  target,
  onClose,
}: {
  target: ModeEditorTarget;
  onClose: () => void;
}) {
  const query = useQuery({ queryKey: MODE_CATALOG_KEY, queryFn: getModeCatalog });
  if (query.data) {
    return <EditorForm target={target} catalog={query.data} onClose={onClose} />;
  }
  return (
    <div className="space-y-3 p-5">
      {query.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {query.error instanceof Error ? query.error.message : "Failed to load"}
        </p>
      ) : (
        [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)
      )}
    </div>
  );
}

function toggle(list: string[], name: string, on: boolean): string[] {
  if (on) return list.includes(name) ? list : [...list, name];
  return list.filter((x) => x !== name);
}

function EditorForm({
  target,
  catalog,
  onClose,
}: {
  target: ModeEditorTarget;
  catalog: ModeCatalog;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const general = target.mode === "general" ? target.settings : null;
  const [form, setForm] = useState<AgentModeInput>(() => {
    if (target.mode === "general") {
      const g = target.settings;
      return {
        ...EMPTY_INPUT,
        name: "General",
        systemPrompt: g.systemPrompt,
        defaultModel: g.defaultModel,
        defaultThinkingLevel: g.defaultThinkingLevel,
      };
    }
    if (target.mode === "edit") {
      const m = target.item;
      return {
        name: m.name,
        systemPrompt: m.systemPrompt,
        toolNames: m.toolNames,
        mcpServerIds: m.mcpServerIds,
        skillNames: m.skillNames,
        defaultModel: m.defaultModel,
        defaultThinkingLevel: m.defaultThinkingLevel,
      };
    }
    return target.initial ?? EMPTY_INPUT;
  });
  const [skillQuery, setSkillQuery] = useState("");
  const [preview, setPreview] = useState<ModePreview | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 正文里最后一次的光标 / 选区。点插入按钮时 textarea 已失焦，受控 value 被 React 重写后
   * selectionStart 不可靠（会被重置），所以自己记住，插入后同步更新，不依赖下一帧回填。
   */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const patch = (p: Partial<AgentModeInput>) => setForm((f) => ({ ...f, ...p }));

  const canSave = form.name.trim() !== "" && form.systemPrompt.trim() !== "";
  const payload = (): AgentModeInput => ({ ...form, name: form.name.trim() });
  /** 通用模式：提示词与默认完全相同就存 null（跟随平台默认，以后默认更新也能跟上）。 */
  const generalPrompt = (g: GeneralModeSettings): string | null =>
    form.systemPrompt === g.defaultPrompt ? null : form.systemPrompt;

  const saveMut = useMutation({
    mutationFn: async () => {
      if (target.mode === "general") {
        await updateGeneralMode({
          systemPrompt: generalPrompt(target.settings),
          defaultModel: form.defaultModel,
          defaultThinkingLevel: form.defaultThinkingLevel,
        });
      } else if (target.mode === "edit") {
        await updateMode(target.item.id, payload());
      } else {
        await createMode(payload());
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: target.mode === "general" ? GENERAL_MODE_QUERY_KEY : MODES_QUERY_KEY,
      });
      onClose();
    },
  });
  const previewMut = useMutation({
    mutationFn: () =>
      target.mode === "general"
        ? previewGeneralMode(generalPrompt(target.settings))
        : previewMode(payload()),
    onSuccess: setPreview,
  });
  const pending = saveMut.isPending || previewMut.isPending;

  /** 在最后的光标处插入占位符（没点过正文就追加到末尾），并把光标放到插入内容之后。 */
  function insertFragment(id: string) {
    const el = promptRef.current;
    const len = form.systemPrompt.length;
    const caret = caretRef.current ?? { start: len, end: len };
    const start = Math.min(caret.start, len);
    const end = Math.min(Math.max(caret.end, start), len);
    // 片段正文以「## 标题」开头：光标前不是行首就先补一个换行，否则标题会接在上一段末尾
    const before = form.systemPrompt[start - 1];
    const token = before !== undefined && before !== "\n" ? `\n{{${id}}}` : `{{${id}}}`;
    const next = form.systemPrompt.slice(0, start) + token + form.systemPrompt.slice(end);
    patch({ systemPrompt: next });
    const after = start + token.length;
    caretRef.current = { start: after, end: after };
    // 视觉上把焦点和光标还给正文（等 React 写回 value）；插入位置本身不依赖这一步
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(after, after);
    });
  }

  const capabilities = new Set(catalog.capabilities);
  const missingFor = (requires: string[]) => requires.filter((r) => !capabilities.has(r));

  const q = skillQuery.trim().toLowerCase();
  const shownSkills = q
    ? catalog.skills.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      )
    : catalog.skills;

  const modelItems: Record<string, string> = { [FOLLOW]: "Follow conversation" };
  for (const m of MODEL_OPTIONS) modelItems[m.value] = modelDisplayName(m.value);
  const levelOptions = form.defaultModel ? thinkingLevelsFor(form.defaultModel) : [];
  const levelItems: Record<string, string> = { [FOLLOW]: "Follow conversation" };
  for (const o of levelOptions) levelItems[o.value] = o.label;

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>
          {target.mode === "edit"
            ? `Edit ${target.item.name}`
            : target.mode === "general"
              ? "Edit General"
              : "New mode"}
        </DialogTitle>
        <DialogDescription>
          {general ? (
            <>
              General is used by conversations without a mode. You can change
              its prompt and default model; it always has every tool, connector
              and skill.
            </>
          ) : (
            <>
              A mode is a complete system prompt plus the tools, connectors and
              skills the agent may use. Built-in tools (files, todos, asking
              you) are always on.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor="mode-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="mode-name"
            placeholder="Image studio"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            disabled={pending || general !== null}
            maxLength={64}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="mode-prompt" className="text-sm font-medium">
            System prompt
          </label>
          <Textarea
            id="mode-prompt"
            ref={promptRef}
            rows={12}
            placeholder="You are an image-generation assistant…"
            value={form.systemPrompt}
            onChange={(e) => {
              // 输入（含粘贴 / 输入法 / 程序化 insertText）不一定触发 onSelect，这里同步记一次光标
              caretRef.current = {
                start: e.target.selectionStart,
                end: e.target.selectionEnd,
              };
              patch({ systemPrompt: e.target.value });
            }}
            onSelect={(e) => {
              caretRef.current = {
                start: e.currentTarget.selectionStart,
                end: e.currentTarget.selectionEnd,
              };
            }}
            disabled={pending}
            className="min-h-56 font-mono text-xs leading-relaxed"
          />
          {catalog.fragments.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Insert</span>
              {catalog.fragments.map((id) => (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="font-mono"
                  disabled={pending}
                  onClick={() => insertFragment(id)}
                >
                  {`{{${id}}}`}
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Placeholders are expanded with the fragment text (see Prompt
            fragments) when the agent runs. Unknown placeholders are rejected on save.
          </p>
        </div>

        {general ? (
          <section className="space-y-2">
            <span className="text-sm font-medium">Tools, connectors &amp; skills</span>
            <div className="space-y-1 rounded-lg border px-3 py-2.5">
              <p className="text-sm font-medium">
                All {count(catalog.tools.length, "tool")} ·{" "}
                {count(catalog.mcpServers.length, "connector")} ·{" "}
                {count(catalog.skills.length, "skill")}
              </p>
              <p className="text-xs text-muted-foreground">
                General always uses everything, including tools, connectors and
                skills added later. Create a mode to narrow it down.
              </p>
            </div>
          </section>
        ) : (
          <>
            <Section
              title="Tools"
              hint={`${form.toolNames.length} of ${catalog.tools.length} selected`}
            >
              {catalog.tools.length === 0 ? (
                <EmptyRow>No optional tools registered.</EmptyRow>
              ) : (
                catalog.tools.map((t) => {
                  const missing = missingFor(t.requires);
                  return (
                    <OptionRow
                      key={t.name}
                      checked={form.toolNames.includes(t.name)}
                      disabled={pending}
                      onCheckedChange={(on) =>
                        patch({ toolNames: toggle(form.toolNames, t.name, on) })
                      }
                      title={t.title || t.name}
                      code={t.title && t.title !== t.name ? t.name : undefined}
                      description={t.description}
                      unavailable={
                        missing.length > 0
                          ? `Not available in this environment: ${missing.join(", ")}`
                          : undefined
                      }
                    />
                  );
                })
              )}
            </Section>

            <Section
              title="Connectors"
              hint={`${form.mcpServerIds.length} of ${catalog.mcpServers.length} selected`}
            >
              {catalog.mcpServers.length === 0 ? (
                <EmptyRow>No connectors added yet.</EmptyRow>
              ) : (
                catalog.mcpServers.map((s) => (
                  <OptionRow
                    key={s.id}
                    checked={form.mcpServerIds.includes(s.id)}
                    disabled={pending}
                    onCheckedChange={(on) =>
                      patch({ mcpServerIds: toggle(form.mcpServerIds, s.id, on) })
                    }
                    title={s.name}
                    code={s.slug}
                  />
                ))
              )}
            </Section>

            <Section
              title="Skills"
              hint={`${form.skillNames.length} of ${catalog.skills.length} selected`}
              toolbar={
                catalog.skills.length > 0 ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label="Search skills"
                      placeholder="Search skills…"
                      className="h-8 pl-8"
                      value={skillQuery}
                      onChange={(e) => setSkillQuery(e.target.value)}
                    />
                  </div>
                ) : undefined
              }
            >
              {catalog.skills.length === 0 ? (
                <EmptyRow>No skills installed.</EmptyRow>
              ) : shownSkills.length === 0 ? (
                <EmptyRow>No skills match your search.</EmptyRow>
              ) : (
                shownSkills.map((s) => (
                  <OptionRow
                    key={s.name}
                    checked={form.skillNames.includes(s.name)}
                    disabled={pending}
                    onCheckedChange={(on) =>
                      patch({ skillNames: toggle(form.skillNames, s.name, on) })
                    }
                    title={s.name}
                    description={s.description}
                  />
                ))
              )}
            </Section>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Default model</span>
            <Select
              items={modelItems}
              value={form.defaultModel ?? FOLLOW}
              onValueChange={(v) => {
                const model = v === FOLLOW || v === null ? null : v;
                // 换模型后原档位可能不再可用（DeepSeek 无 low/medium/high）→ 回到跟随
                const level = asThinkingLevel(form.defaultThinkingLevel);
                const keep =
                  model && level && thinkingLevelsFor(model).some((o) => o.value === level);
                patch({ defaultModel: model, defaultThinkingLevel: keep ? level : null });
              }}
              disabled={pending}
            >
              <SelectTrigger aria-label="Default model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(modelItems).map((v) => (
                  <SelectItem key={v} value={v} className={v === FOLLOW ? "" : "font-mono"}>
                    {modelItems[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applied when a new conversation starts in this mode.
            </p>
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Default thinking</span>
            <Select
              items={levelItems}
              value={form.defaultThinkingLevel ?? FOLLOW}
              onValueChange={(v) =>
                patch({ defaultThinkingLevel: v === FOLLOW || v === null ? null : v })
              }
              disabled={pending || !form.defaultModel}
            >
              <SelectTrigger aria-label="Default thinking level" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(levelItems).map((v) => (
                  <SelectItem key={v} value={v}>
                    {levelItems[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Levels depend on the default model.
            </p>
          </div>
        </div>

        {saveMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {saveMut.error instanceof Error ? saveMut.error.message : "Save failed"}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3 sm:justify-between">
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => previewMut.mutate()}
            disabled={!canSave || pending}
          >
            {previewMut.isPending ? <Loader2 className="animate-spin" /> : <Eye />}
            Preview prompt
          </Button>
          {general && (
            <Button
              variant="ghost"
              onClick={() => {
                patch({ systemPrompt: general.defaultPrompt });
                caretRef.current = null;
              }}
              disabled={pending || form.systemPrompt === general.defaultPrompt}
            >
              <RotateCcw /> Restore default
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || pending}>
            {saveMut.isPending && <Loader2 className="animate-spin" />}
            {target.mode === "create" ? "Create mode" : "Save"}
          </Button>
        </div>
      </DialogFooter>

      <PromptPreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function Section({
  title,
  hint,
  toolbar,
  children,
}: {
  title: string;
  hint: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {toolbar}
      <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">{children}</ul>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <li className="px-3 py-6 text-center text-sm text-muted-foreground">{children}</li>;
}

/**
 * 一行勾选项：Checkbox + 标题（可附 code 名）+ 描述。
 * unavailable 有值 = 本环境缺 capability：整行标灰 + Tooltip 说明，但仍可勾（换环境即生效）。
 */
function OptionRow({
  checked,
  disabled,
  onCheckedChange,
  title,
  code,
  description,
  unavailable,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (on: boolean) => void;
  title: string;
  code?: string;
  description?: string;
  unavailable?: string;
}) {
  const row = (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40",
        unavailable && "opacity-50",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(c) => onCheckedChange(c === true)}
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {title}
          {code && <code className="font-mono text-xs text-muted-foreground">{code}</code>}
        </span>
        {description && (
          <span className="line-clamp-2 block text-xs text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
  if (!unavailable) return <li>{row}</li>;
  return (
    <li>
      <Tooltip>
        <TooltipTrigger render={<div />}>{row}</TooltipTrigger>
        <TooltipContent side="top" align="start">
          {unavailable}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}
