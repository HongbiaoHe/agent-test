"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Braces, Loader2, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { type PromptFragment, updateFragment } from "@/lib/api";

/** 平台片段缓存键：改写 / 恢复默认后 invalidate（列表与编辑弹窗共用）。 */
export const FRAGMENTS_QUERY_KEY = ["fragments"] as const;

/** 片段正文里唯一可用的变量（运行时替换成技能库目录）。 */
const SKILLS_DIR_TOKEN = "{{skills_dir}}";

/** 平台片段编辑弹窗：改写正文、在光标处插入 {{skills_dir}}、恢复默认。 */
export function FragmentEditor({
  fragment,
  onClose,
}: {
  fragment: PromptFragment | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={fragment !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(48rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        {fragment && <FragmentForm key={fragment.id} fragment={fragment} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function FragmentForm({
  fragment,
  onClose,
}: {
  fragment: PromptFragment;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(fragment.text);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 正文里最后一次的光标 / 选区（同 mode-editor 的 caretRef）：点插入按钮时 textarea 已失焦，
   * 受控 value 被 React 重写后 selectionStart 不可靠，所以自己记住。
   */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const isDefault = text === fragment.defaultText;
  const canSave = text.trim() !== "";

  const saveMut = useMutation({
    // 与默认完全相同就存 null（跟随平台默认，以后默认更新也能跟上）
    mutationFn: () => updateFragment(fragment.id, isDefault ? null : text),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FRAGMENTS_QUERY_KEY });
      onClose();
    },
  });
  const pending = saveMut.isPending;

  /** 在最后的光标处插入 {{skills_dir}}（没点过正文就追加到末尾），光标放到插入内容之后。 */
  function insertSkillsDir() {
    const el = textRef.current;
    const len = text.length;
    const caret = caretRef.current ?? { start: len, end: len };
    const start = Math.min(caret.start, len);
    const end = Math.min(Math.max(caret.end, start), len);
    setText(text.slice(0, start) + SKILLS_DIR_TOKEN + text.slice(end));
    const after = start + SKILLS_DIR_TOKEN.length;
    caretRef.current = { start: after, end: after };
    // 视觉上把焦点和光标还给正文（等 React 写回 value）；插入位置本身不依赖这一步
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(after, after);
    });
  }

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>{`Edit ${fragment.id}`}</DialogTitle>
        <DialogDescription>
          This text replaces <code className="font-mono text-xs">{`{{${fragment.id}}}`}</code> in
          every mode prompt that uses it. Changes apply only to you.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 py-4">
        <label htmlFor="fragment-text" className="text-sm font-medium">
          Fragment text
        </label>
        <Textarea
          id="fragment-text"
          ref={textRef}
          rows={12}
          value={text}
          onChange={(e) => {
            // 输入（含粘贴 / 输入法）不一定触发 onSelect，这里同步记一次光标
            caretRef.current = {
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            };
            setText(e.target.value);
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
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            disabled={pending}
            onClick={insertSkillsDir}
          >
            <Braces /> {`Insert ${SKILLS_DIR_TOKEN}`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Shared by every mode that references this fragment. The only variable allowed is{" "}
          <code className="font-mono">{SKILLS_DIR_TOKEN}</code>, which becomes the skills
          directory at run time; other placeholders are rejected on save.
        </p>

        {saveMut.isError && (
          <p className="pt-2 text-sm text-destructive" role="alert">
            {saveMut.error instanceof Error ? saveMut.error.message : "Save failed"}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3 sm:justify-between">
        <Button
          variant="ghost"
          onClick={() => {
            setText(fragment.defaultText);
            caretRef.current = null;
          }}
          disabled={pending || isDefault}
        >
          <RotateCcw /> Restore default
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || pending}>
            {saveMut.isPending && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
