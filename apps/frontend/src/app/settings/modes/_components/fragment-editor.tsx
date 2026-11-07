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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createFragment,
  CUSTOM_FRAGMENT_NAME_PATTERN,
  CUSTOM_FRAGMENT_PREFIX,
  type PromptFragment,
  updateFragment,
} from "@/lib/api";

import { MODE_CATALOG_KEY } from "./mode-editor";

/** 片段缓存键：新建 / 改写 / 恢复默认 / 删除后 invalidate（列表与编辑弹窗共用）。 */
export const FRAGMENTS_QUERY_KEY = ["fragments"] as const;

/** 片段正文里唯一可用的变量（运行时替换成技能库目录）。 */
const SKILLS_DIR_TOKEN = "{{skills_dir}}";

/** 弹窗打开方式：新建自建片段，或编辑已有片段（内置 / 自建）。 */
export type FragmentEditorTarget =
  | { mode: "create" }
  | { mode: "edit"; fragment: PromptFragment };

/**
 * 片段编辑弹窗，三种形态共用一套表单：
 * - 新建：id（固定 `custom.` 前缀，输入时校验格式）+ 显示名 + 正文；
 * - 编辑自建片段：id 只读，显示名与正文可改，没有恢复默认；
 * - 编辑内置片段：只改正文，可恢复默认。
 * 正文都可在光标处插入 {{skills_dir}}。
 */
export function FragmentEditor({
  target,
  onClose,
}: {
  target: FragmentEditorTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 弹窗内长内容用原生 overflow-y-auto（max-h 下 ScrollArea 不裁剪） */}
      <DialogContent className="flex max-h-[min(48rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        {target && (
          <FragmentForm
            key={target.mode === "edit" ? target.fragment.id : "create"}
            target={target}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FragmentForm({
  target,
  onClose,
}: {
  target: FragmentEditorTarget;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const fragment = target.mode === "edit" ? target.fragment : null;
  const isBuiltin = fragment?.kind === "builtin";
  const isCreate = fragment === null;

  const [name, setName] = useState("");
  const [title, setTitle] = useState(fragment?.title ?? "");
  const [text, setText] = useState(fragment?.text ?? "");
  const textRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 正文里最后一次的光标 / 选区（同 mode-editor 的 caretRef）：点插入按钮时 textarea 已失焦，
   * 受控 value 被 React 重写后 selectionStart 不可靠，所以自己记住。
   */
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  const nameValid = CUSTOM_FRAGMENT_NAME_PATTERN.test(name);
  // 空名字不提示（还没开始输入），只是禁用保存
  const nameError = name !== "" && !nameValid;
  const isDefault = isBuiltin && text === fragment.defaultText;
  const canSave =
    text.trim() !== "" && (isBuiltin || title.trim() !== "") && (!isCreate || nameValid);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!fragment) {
        return createFragment({ id: CUSTOM_FRAGMENT_PREFIX + name, title, text });
      }
      // 内置：与默认完全相同就存 null（跟随平台默认，以后默认更新也能跟上）
      if (fragment.kind === "builtin") {
        return updateFragment(fragment.id, { text: isDefault ? null : text });
      }
      return updateFragment(fragment.id, { title, text });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FRAGMENTS_QUERY_KEY });
      // 新建的自建片段要出现在模式编辑器的插入按钮里
      if (isCreate) void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
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

  const placeholderId = fragment ? fragment.id : `${CUSTOM_FRAGMENT_PREFIX}${name || "name"}`;

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle>{fragment ? `Edit ${fragment.id}` : "New fragment"}</DialogTitle>
        <DialogDescription>
          This text replaces <code className="font-mono text-xs">{`{{${placeholderId}}}`}</code> in
          every mode prompt that uses it.
          {isBuiltin ? " Changes apply only to you." : " Only you can see and use it."}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {!isBuiltin && (
          <>
            <div className="space-y-1.5">
              <label htmlFor="fragment-id" className="text-sm font-medium">
                ID
              </label>
              {isCreate ? (
                <>
                  {/* 固定前缀 + 名字输入：外框承担输入框的边框与焦点环，内层 Input 去掉自身边框 */}
                  <div
                    aria-invalid={nameError || undefined}
                    className="flex h-8 items-center rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30"
                  >
                    <span className="pl-2.5 font-mono text-sm text-muted-foreground select-none">
                      {CUSTOM_FRAGMENT_PREFIX}
                    </span>
                    <Input
                      id="fragment-id"
                      value={name}
                      onChange={(e) => {
                        // 粘贴了完整 id 也认：去掉重复的前缀
                        const v = e.target.value;
                        setName(v.startsWith(CUSTOM_FRAGMENT_PREFIX) ? v.slice(CUSTOM_FRAGMENT_PREFIX.length) : v);
                      }}
                      placeholder="tone"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                      aria-invalid={nameError || undefined}
                      aria-describedby="fragment-id-hint"
                      className="h-full rounded-none border-0 bg-transparent pl-0 font-mono shadow-none focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent"
                    />
                  </div>
                  <p
                    id="fragment-id-hint"
                    className={nameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                  >
                    Lowercase letters, digits and underscores, 1–48 characters. The ID can&apos;t be
                    changed later.
                  </p>
                </>
              ) : (
                <Input id="fragment-id" value={fragment?.id ?? ""} readOnly disabled className="font-mono" />
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="fragment-title" className="text-sm font-medium">
                Title
              </label>
              <Input
                id="fragment-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Friendly tone"
                maxLength={100}
                disabled={pending}
              />
            </div>
          </>
        )}

        <div className="space-y-1.5">
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
        </div>

        {saveMut.isError && (
          <p className="text-sm text-destructive" role="alert">
            {saveMut.error instanceof Error ? saveMut.error.message : "Save failed"}
          </p>
        )}
      </div>

      {/* 弹窗是 p-0 自排版：抵消 DialogFooter 默认为 p-4 内容准备的 -mx-4 -mb-4 */}
      <DialogFooter className="mx-0 mb-0 px-5 py-3 sm:justify-between">
        {isBuiltin ? (
          <Button
            variant="ghost"
            onClick={() => {
              setText(fragment.defaultText ?? "");
              caretRef.current = null;
            }}
            disabled={pending || isDefault}
          >
            <RotateCcw /> Restore default
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || pending}>
            {saveMut.isPending && <Loader2 className="animate-spin" />}
            {isCreate ? "Create fragment" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
