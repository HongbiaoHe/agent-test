import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Variable } from 'lucide-react';
import { useRef, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { PROMPT_FRAGMENTS_KEY, type PromptFragmentView, updatePromptFragment } from '@/lib/api';

/** 片段正文里唯一可用的变量（同 core 的 SKILLS_DIR_VARIABLE；renderer 不能从 core 的 CJS dist 取值） */
const SKILLS_DIR_TOKEN = '{{skills_dir}}';
/** 同 core 的 FragmentTextSchema 上限 */
const TEXT_MAX = 20_000;

/** 编辑一个平台片段：正文 + 在光标处插入 {{skills_dir}} + 恢复默认 + 保存（保存被拒时显示报错） */
export function FragmentEditor({ fragment, onClose }: { fragment: PromptFragmentView | null; onClose: () => void }) {
  return (
    <Dialog open={fragment !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(44rem,90vh)] flex-col gap-0 p-0 sm:max-w-2xl">
        {fragment && <FragmentForm key={fragment.id} fragment={fragment} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function FragmentForm({ fragment, onClose }: { fragment: PromptFragmentView; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState(fragment.text);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** 正文最后的光标 / 选区（同 mode-editor：点按钮时 textarea 已失焦，在 onChange / onSelect 里自己记）；null = 插到末尾 */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const save = useMutation({
    // 与默认相同就存 null（= 跟随 core 默认）；host 也会按恢复默认处理
    mutationFn: () => updatePromptFragment(fragment.id, text === fragment.defaultText ? null : text),
    onSuccess: () => {
      // host 也会广播 modes-changed（按 modes 前缀失效，含片段列表）；这里先刷自己，关窗即见
      void qc.invalidateQueries({ queryKey: PROMPT_FRAGMENTS_KEY });
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
    setText(fragment.defaultText);
    caretRef.current = null;
  };

  const canSave = text.trim() !== '' && text.length <= TEXT_MAX;
  const busy = save.isPending;

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>{t('settings.modes.fragments.editorTitle', { id: fragment.id })}</DialogTitle>
        <DialogDescription>{t('settings.modes.fragments.hint', { variable: SKILLS_DIR_TOKEN })}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
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
        {save.isError && (
          <p className="text-sm text-destructive" role="alert">
            {save.error instanceof Error ? save.error.message : t('settings.modes.editor.saveFailed')}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3 sm:justify-between">
        <Button variant="ghost" onClick={restoreDefault} disabled={busy || text === fragment.defaultText}>
          <RotateCcw /> {t('settings.modes.editor.restoreDefault')}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('common.save')}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
