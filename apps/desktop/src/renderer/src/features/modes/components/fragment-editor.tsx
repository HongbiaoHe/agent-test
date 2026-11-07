import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Variable } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createPromptFragment,
  MODE_CATALOG_KEY,
  PROMPT_FRAGMENTS_KEY,
  type PromptFragmentView,
  updatePromptFragment,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/** 片段正文里唯一可用的变量（同 core 的 SKILLS_DIR_VARIABLE；renderer 不能从 core 的 CJS dist 取值） */
const SKILLS_DIR_TOKEN = '{{skills_dir}}';
/** 同 core 的 FragmentTextSchema 上限 */
const TEXT_MAX = 20_000;
/** 同 core 的 FragmentTitleSchema 上限 */
const TITLE_MAX = 100;
/** 同 core 的 CUSTOM_FRAGMENT_PREFIX */
const CUSTOM_PREFIX = 'custom.';
/** 自建片段 id 去掉前缀后的名字：同 core 的 CustomFragmentIdSchema（/^custom\.[a-z0-9_]{1,48}$/），只做输入时的即时提示，host 仍会校验 */
const NAME_PATTERN = /^[a-z0-9_]{1,48}$/;
const NAME_MAX = 48;

/** create = 新建自建片段；edit = 改内置片段（正文 / 恢复默认）或自建片段（显示名 / 正文，id 只读） */
export type FragmentEditorTarget = { kind: 'create' } | { kind: 'edit'; fragment: PromptFragmentView };

/** 片段弹窗：正文 + 在光标处插入 {{skills_dir}} + 保存（被拒时显示报错）；内置片段可恢复默认，新建时填 id 与显示名 */
export function FragmentEditor({ target, onClose }: { target: FragmentEditorTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(44rem,90vh)] flex-col gap-0 p-0 sm:max-w-2xl">
        {target && (
          <FragmentForm
            key={target.kind === 'edit' ? target.fragment.id : 'create'}
            fragment={target.kind === 'edit' ? target.fragment : null}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FragmentForm({ fragment, onClose }: { fragment: PromptFragmentView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const idHintId = useId();
  const builtin = fragment?.kind === 'builtin' ? fragment : null;
  const [name, setName] = useState('');
  const [title, setTitle] = useState(fragment?.kind === 'custom' ? fragment.title : '');
  const [text, setText] = useState(fragment?.text ?? '');
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** 正文最后的光标 / 选区（同 mode-editor：点按钮时 textarea 已失焦，在 onChange / onSelect 里自己记）；null = 插到末尾 */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const nameValid = NAME_PATTERN.test(name);
  const id = fragment?.id ?? `${CUSTOM_PREFIX}${nameValid ? name : 'xxx'}`;

  const save = useMutation({
    mutationFn: () => {
      if (!fragment) return createPromptFragment({ id: `${CUSTOM_PREFIX}${name}`, title: title.trim(), text });
      // 内置：与默认相同就存 null（= 跟随 core 默认）；host 也会按恢复默认处理
      if (fragment.kind === 'builtin') {
        return updatePromptFragment(fragment.id, { text: text === fragment.defaultText ? null : text });
      }
      return updatePromptFragment(fragment.id, { title: title.trim(), text });
    },
    onSuccess: () => {
      // host 也会广播 modes-changed（按 modes 前缀失效片段列表、并刷新模式编辑器的目录）；这里先刷自己，关窗即见
      void qc.invalidateQueries({ queryKey: PROMPT_FRAGMENTS_KEY });
      void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
      onClose();
    },
  });

  const insertVariable = () => {
    const el = textRef.current;
    const len = text.length;
    const caret = caretRef.current ?? { start: len, end: len };
    const start = Math.min(caret.start, len);
    const end = Math.min(Math.max(caret.end, start), len);
    setText(text.slice(0, start) + SKILLS_DIR_TOKEN + text.slice(end));
    const pos = start + SKILLS_DIR_TOKEN.length;
    caretRef.current = { start: pos, end: pos };
    // 只是把焦点和光标视觉上还给正文（等 React 写回 value）；插入位置不依赖这一步
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const restoreDefault = () => {
    if (!builtin) return;
    setText(builtin.defaultText);
    caretRef.current = null;
  };

  const titleOk = builtin !== null || (title.trim() !== '' && title.trim().length <= TITLE_MAX);
  const canSave = text.trim() !== '' && text.length <= TEXT_MAX && titleOk && (fragment !== null || nameValid);
  const busy = save.isPending;
  const nameInvalid = name !== '' && !nameValid;

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>
          {fragment
            ? t('settings.modes.fragments.editorTitle', { id: fragment.id })
            : t('settings.modes.fragments.createTitle')}
        </DialogTitle>
        <DialogDescription>
          {builtin
            ? t('settings.modes.fragments.hint', { variable: SKILLS_DIR_TOKEN })
            : t('settings.modes.fragments.createHint', { ref: `{{${id}}}`, variable: SKILLS_DIR_TOKEN })}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {!builtin && (
          <>
            <div className="space-y-1.5">
              <label htmlFor="fragment-id" className="text-sm font-medium">
                {t('settings.modes.fragments.idLabel')}
              </label>
              {fragment ? (
                <Input id="fragment-id" value={fragment.id} readOnly aria-describedby={idHintId} className="font-mono" />
              ) : (
                <div className="flex">
                  <span className="inline-flex h-8 shrink-0 items-center rounded-l-lg border border-r-0 border-input bg-muted px-2.5 font-mono text-sm text-muted-foreground">
                    {CUSTOM_PREFIX}
                  </span>
                  <Input
                    id="fragment-id"
                    value={name}
                    maxLength={NAME_MAX}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={nameInvalid}
                    aria-describedby={idHintId}
                    disabled={busy}
                    className="rounded-l-none font-mono"
                  />
                </div>
              )}
              <p id={idHintId} className={cn('text-xs', nameInvalid ? 'text-destructive' : 'text-muted-foreground')}>
                {nameInvalid ? t('settings.modes.fragments.idInvalid') : t('settings.modes.fragments.idLocked')}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="fragment-title" className="text-sm font-medium">
                {t('settings.modes.fragments.titleLabel')}
              </label>
              <Input
                id="fragment-title"
                value={title}
                maxLength={TITLE_MAX}
                placeholder={t('settings.modes.fragments.titlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
              />
            </div>
          </>
        )}

        <div className="space-y-2">
          <label htmlFor="fragment-text" className="text-sm font-medium">
            {t('settings.modes.fragments.textLabel')}
          </label>
          <Textarea
            id="fragment-text"
            ref={textRef}
            rows={10}
            value={text}
            maxLength={TEXT_MAX}
            onChange={(e) => {
              // 输入（含粘贴 / 输入法 / 程序化输入）不一定触发 onSelect，这里同步记一次光标
              caretRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
              setText(e.target.value);
            }}
            onSelect={(e) => {
              caretRef.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
            }}
            disabled={busy}
            className="min-h-48 font-mono text-xs leading-relaxed"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            aria-label={t('settings.modes.fragments.insertVariable', { variable: SKILLS_DIR_TOKEN })}
            onClick={insertVariable}
            disabled={busy}
          >
            <Variable /> {SKILLS_DIR_TOKEN}
          </Button>
        </div>
        {save.isError && (
          <p className="text-sm text-destructive" role="alert">
            {save.error instanceof Error ? save.error.message : t('settings.modes.editor.saveFailed')}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4；自建片段没有「恢复默认」 */}
      <DialogFooter className={cn('mx-0 mb-0 px-5 py-3', builtin && 'sm:justify-between')}>
        {builtin && (
          <Button variant="ghost" onClick={restoreDefault} disabled={busy || text === builtin.defaultText}>
            <RotateCcw /> {t('settings.modes.editor.restoreDefault')}
          </Button>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {fragment ? t('common.save') : t('settings.modes.fragments.create')}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
