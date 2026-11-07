import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { Capability } from '@agent-test/agent-core/modes/capabilities';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type AgentMode,
  type AgentModeInput,
  createMode,
  GENERAL_MODE_KEY,
  type GeneralModeView,
  getModeCatalog,
  MODE_CATALOG_KEY,
  type ModeCatalog,
  type ModePreview,
  MODES_QUERY_KEY,
  previewGeneralMode,
  previewMode,
  updateGeneralMode,
  updateMode,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { asThinkingLevel, thinkingLevelsFor } from '@/lib/thinking-level';
import { MODEL_OPTIONS, modelDisplayName } from '../../chat/lib/models';
import { PromptPreviewDialog } from './prompt-preview-dialog';

/** 「跟随会话」在 Select 里的值（base-ui Select 的值是字符串） */
const FOLLOW = '';
const NAME_MAX = 100;
const PROMPT_MAX = 100_000;

/**
 * 打开方式：新建（可预填，如「从通用复制」）/ 编辑已有模式 / 编辑通用模式
 * （名称固定、工具 / 连接器 / 技能恒为全部，只能改提示词与默认模型，可恢复默认提示词）
 */
export type ModeEditorTarget =
  | { kind: 'create'; initial?: AgentModeInput }
  | { kind: 'edit'; mode: AgentMode }
  | { kind: 'general'; general: GeneralModeView };

export function ModeEditor({ target, onClose }: { target: ModeEditorTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  const catalog = useQuery({ queryKey: MODE_CATALOG_KEY, queryFn: getModeCatalog });
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(52rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        {target && catalog.data ? (
          <EditorForm
            key={target.kind === 'edit' ? target.mode.id : target.kind}
            target={target}
            catalog={catalog.data}
            onClose={onClose}
          />
        ) : (
          <div className="space-y-3 p-5">
            {catalog.isError ? (
              <p className="text-sm text-destructive" role="alert">
                {catalog.error instanceof Error ? catalog.error.message : t('settings.modes.list.loadFailed')}
              </p>
            ) : (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editing = target.kind === 'edit';
  const general = target.kind === 'general' ? target.general : null;
  const initial: Partial<AgentModeInput> =
    target.kind === 'edit'
      ? target.mode
      : target.kind === 'general'
        ? {
            name: t('settings.modes.general'),
            systemPrompt: target.general.systemPrompt,
            defaultModel: target.general.defaultModel,
            defaultThinkingLevel: target.general.defaultThinkingLevel,
          }
        : (target.initial ?? {});
  const [name, setName] = useState(initial.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '');
  const [toolNames, setToolNames] = useState<string[]>(initial.toolNames ?? []);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(initial.mcpServerIds ?? []);
  const [skillNames, setSkillNames] = useState<string[]>(initial.skillNames ?? []);
  const [defaultModel, setDefaultModel] = useState<string | null>(initial.defaultModel ?? null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<string | null>(initial.defaultThinkingLevel ?? null);
  const [skillSearch, setSkillSearch] = useState('');
  const [preview, setPreview] = useState<ModePreview | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 正文最后的光标 / 选区。点插入按钮那一刻 textarea 已失焦，selectionStart 不可靠（后台标签页、程序化输入时
   * 会被重置），所以在 onChange / onSelect 里自己记，插入后同步更新；null = 没点过正文，插到末尾。
   */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const input = (): AgentModeInput => ({
    name: name.trim(),
    systemPrompt,
    toolNames,
    mcpServerIds,
    skillNames,
    defaultModel,
    defaultThinkingLevel: defaultModel ? defaultThinkingLevel : null,
  });
  /** 通用模式：与默认提示词完全相同就存 null（= 跟随 core 默认，以后默认更新也能跟上） */
  const generalPrompt = (): string | null => (general && systemPrompt === general.defaultPrompt ? null : systemPrompt);
  const canSave = name.trim() !== '' && name.trim().length <= NAME_MAX && systemPrompt.trim() !== '' && systemPrompt.length <= PROMPT_MAX;

  const saveMut = useMutation({
    mutationFn: (): Promise<unknown> => {
      if (target.kind === 'general') {
        const { defaultModel: model, defaultThinkingLevel: level } = input();
        return updateGeneralMode({ systemPrompt: generalPrompt(), defaultModel: model, defaultThinkingLevel: level });
      }
      return target.kind === 'edit' ? updateMode(target.mode.id, input()) : createMode(input());
    },
    onSuccess: () => {
      if (general) {
        void qc.invalidateQueries({ queryKey: GENERAL_MODE_KEY });
        // 目录里的 generalPrompt（「从通用复制」用）是生效的通用提示词
        void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
      } else {
        void qc.invalidateQueries({ queryKey: MODES_QUERY_KEY });
      }
      onClose();
    },
  });
  const previewMut = useMutation({
    mutationFn: () => (general ? previewGeneralMode(generalPrompt()) : previewMode(input())),
    onSuccess: setPreview,
    onError: (e) => toast.error(e.message || t('settings.modes.preview.failed')),
  });

  /**
   * 在最后的光标处插入 {{id}}（没点过正文就追加到末尾），光标放到插入内容之后。
   * 片段正文以「## 标题」开头：光标前一个字符存在且不是换行时先补一个换行，免得标题接在上一段末尾。
   */
  const insertFragment = (id: string) => {
    const el = promptRef.current;
    const len = systemPrompt.length;
    const caret = caretRef.current ?? { start: len, end: len };
    const start = Math.min(caret.start, len);
    const end = Math.min(Math.max(caret.end, start), len);
    const before = systemPrompt.slice(0, start);
    const token = `${before !== '' && !before.endsWith('\n') ? '\n' : ''}{{${id}}}`;
    setSystemPrompt(before + token + systemPrompt.slice(end));
    const pos = start + token.length;
    caretRef.current = { start: pos, end: pos };
    // 只是把焦点和光标视觉上还给正文（等 React 写回 value）；插入位置不依赖这一步
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const restoreDefault = () => {
    if (!general) return;
    setSystemPrompt(general.defaultPrompt);
    caretRef.current = null;
  };

  const capabilities = new Set<Capability>(catalog.capabilities);
  const missingOf = (requires: readonly Capability[] | undefined) => (requires ?? []).filter((c) => !capabilities.has(c));
  const q = skillSearch.trim().toLowerCase();
  const skills = catalog.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  const thinkingOptions = defaultModel ? thinkingLevelsFor(defaultModel) : [];
  const busy = saveMut.isPending || previewMut.isPending;

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>
          {general
            ? t('settings.modes.editor.generalTitle')
            : editing
              ? t('settings.modes.editor.editTitle', { name: target.mode.name })
              : t('settings.modes.editor.createTitle')}
        </DialogTitle>
        <DialogDescription>
          {general ? t('settings.modes.editor.generalDescription') : t('settings.modes.editor.description')}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor="mode-name" className="text-sm font-medium">
            {t('settings.modes.editor.nameLabel')}
          </label>
          <Input
            id="mode-name"
            value={name}
            maxLength={NAME_MAX}
            placeholder={t('settings.modes.editor.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            readOnly={general !== null}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="mode-prompt" className="text-sm font-medium">
            {t('settings.modes.editor.promptLabel')}
          </label>
          <Textarea
            id="mode-prompt"
            ref={promptRef}
            rows={12}
            value={systemPrompt}
            placeholder={t('settings.modes.editor.promptPlaceholder')}
            onChange={(e) => {
              // 输入（含粘贴 / 输入法 / 程序化输入）不一定触发 onSelect，这里同步记一次光标
              caretRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
              setSystemPrompt(e.target.value);
            }}
            onSelect={(e) => {
              caretRef.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
            }}
            disabled={busy}
            className="min-h-56 font-mono text-xs leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('settings.modes.editor.fragments')}</span>
            {catalog.fragments.map((id) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="xs"
                className="font-mono"
                aria-label={t('settings.modes.editor.insert', { id })}
                onClick={() => insertFragment(id)}
                disabled={busy}
              >
                {`{{${id}}}`}
              </Button>
            ))}
          </div>
        </div>

        {general ? (
          <>
            <AllOf label={t('settings.modes.editor.toolsLabel')}>
              {t('settings.modes.editor.allTools', { count: catalog.tools.length })}
            </AllOf>
            <AllOf label={t('settings.modes.editor.connectorsLabel')}>
              {t('settings.modes.editor.allConnectors', { count: catalog.mcpServers.length })}
            </AllOf>
            <AllOf label={t('settings.modes.editor.skillsLabel')}>
              {t('settings.modes.editor.allSkills', { count: catalog.skills.length })}
            </AllOf>
          </>
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('settings.modes.editor.toolsLabel')}</legend>
              <p className="text-xs text-muted-foreground">{t('settings.modes.editor.toolsHint')}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {catalog.tools.map((tool) => {
                  const missing = missingOf(tool.requires);
                  const row = (
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 hover:bg-accent/40',
                        missing.length > 0 && 'opacity-50',
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={toolNames.includes(tool.name)}
                        onCheckedChange={(on) => setToolNames((cur) => toggle(cur, tool.name, on === true))}
                        disabled={busy}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {tool.title} <code className="font-mono text-xs text-muted-foreground">{tool.name}</code>
                        </span>
                        <span className="block text-xs text-muted-foreground">{tool.description}</span>
                      </span>
                    </label>
                  );
                  if (missing.length === 0) return <div key={tool.name}>{row}</div>;
                  return (
                    <Tooltip key={tool.name}>
                      <TooltipTrigger render={<div />}>{row}</TooltipTrigger>
                      <TooltipContent>
                        {t('settings.modes.editor.unavailable', {
                          caps: missing.map((c) => t(`settings.modes.capability.${c}`)).join(', '),
                        })}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('settings.modes.editor.connectorsLabel')}</legend>
              {catalog.mcpServers.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('settings.modes.editor.noConnectors')}</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {catalog.mcpServers.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 hover:bg-accent/40">
                      <Checkbox
                        checked={mcpServerIds.includes(s.id)}
                        onCheckedChange={(on) => setMcpServerIds((cur) => toggle(cur, s.id, on === true))}
                        disabled={busy}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {s.name} <code className="font-mono text-xs text-muted-foreground">{s.slug}</code>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('settings.modes.editor.skillsLabel')}</legend>
              {catalog.skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('settings.modes.editor.noSkills')}</p>
              ) : (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={t('settings.modes.editor.skillsSearch')}
                      className="h-8 pl-8"
                      value={skillSearch}
                      onChange={(e) => setSkillSearch(e.target.value)}
                    />
                  </div>
                  {skills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('settings.modes.editor.noSkillMatch')}</p>
                  ) : (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {skills.map((s) => (
                        <label key={s.name} className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 hover:bg-accent/40">
                          <Checkbox
                            className="mt-0.5"
                            checked={skillNames.includes(s.name)}
                            onCheckedChange={(on) => setSkillNames((cur) => toggle(cur, s.name, on === true))}
                            disabled={busy}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-sm">{s.name}</span>
                            <span className="line-clamp-2 block text-xs text-muted-foreground">{s.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </fieldset>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('settings.modes.editor.defaultModel')}</span>
            <Select
              items={{
                [FOLLOW]: t('settings.modes.editor.followConversation'),
                ...Object.fromEntries(MODEL_OPTIONS.map((m) => [m.value, modelDisplayName(m.value)])),
              }}
              value={defaultModel ?? FOLLOW}
              onValueChange={(v) => {
                if (typeof v !== 'string') return;
                setDefaultModel(v || null);
                setDefaultThinkingLevel(null);
              }}
            >
              <SelectTrigger aria-label={t('settings.modes.editor.defaultModel')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>{t('settings.modes.editor.followConversation')}</SelectItem>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {modelDisplayName(m.value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('settings.modes.editor.defaultThinking')}</span>
            <Select
              items={{
                [FOLLOW]: t('settings.modes.editor.followConversation'),
                ...Object.fromEntries(thinkingOptions.map((o) => [o.value, o.label])),
              }}
              value={(defaultModel && asThinkingLevel(defaultThinkingLevel)) || FOLLOW}
              disabled={!defaultModel}
              onValueChange={(v) => {
                if (typeof v === 'string') setDefaultThinkingLevel(v || null);
              }}
            >
              <SelectTrigger aria-label={t('settings.modes.editor.defaultThinking')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>{t('settings.modes.editor.followConversation')}</SelectItem>
                {thinkingOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {saveMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {saveMut.error instanceof Error ? saveMut.error.message : t('settings.modes.editor.saveFailed')}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3 sm:justify-between">
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => previewMut.mutate()} disabled={!canSave || busy}>
            {previewMut.isPending && <Loader2 className="animate-spin" />}
            {t('settings.modes.editor.preview')}
          </Button>
          {general && (
            <Button variant="ghost" onClick={restoreDefault} disabled={busy || systemPrompt === general.defaultPrompt}>
              <RotateCcw /> {t('settings.modes.editor.restoreDefault')}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || busy}>
            {saveMut.isPending && <Loader2 className="animate-spin" />}
            {target.kind === 'create' ? t('settings.modes.editor.create') : t('common.save')}
          </Button>
        </div>
      </DialogFooter>
      <PromptPreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}

/** 通用模式的工具 / 连接器 / 技能栏：恒为全部，只读说明 */
function AllOf({ label, children }: { label: string; children: string }) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
