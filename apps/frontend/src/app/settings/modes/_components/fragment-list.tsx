"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { deleteFragment, listFragments, type PromptFragment } from "@/lib/api";

import { FragmentEditor, type FragmentEditorTarget, FRAGMENTS_QUERY_KEY } from "./fragment-editor";
import { MODE_CATALOG_KEY } from "./mode-editor";

/**
 * 「Prompt fragments」区块：内置 4 个片段（可改写 / 恢复默认）在前，用户自建片段（可新建 / 编辑 / 删除）在后。
 * 片段被所有引用它的模式共用；改写与自建都只对当前用户生效。
 */
export function FragmentSection() {
  const [editor, setEditor] = useState<FragmentEditorTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PromptFragment | null>(null);
  const query = useQuery({ queryKey: FRAGMENTS_QUERY_KEY, queryFn: listFragments });

  return (
    <section className="space-y-3" aria-labelledby="prompt-fragments-title">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 id="prompt-fragments-title" className="text-base font-semibold">
            Prompt fragments
          </h3>
          <p className="text-sm text-muted-foreground">
            The text each <code className="font-mono text-xs">{"{{platform.*}}"}</code> or{" "}
            <code className="font-mono text-xs">{"{{custom.*}}"}</code> placeholder expands to.
            Edit the built-in ones or add your own; changes apply only to you.
          </p>
        </div>
        <Button variant="outline" className="shrink-0" onClick={() => setEditor({ mode: "create" })}>
          <Plus /> New fragment
        </Button>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : !query.data ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load fragments"}
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            {/* 后端已按「内置在前、自建按创建时间在后」排好序 */}
            <ul className="divide-y">
              {query.data.map((f) => (
                <FragmentRow
                  key={f.id}
                  fragment={f}
                  onEdit={() => setEditor({ mode: "edit", fragment: f })}
                  onDelete={f.kind === "custom" ? () => setPendingDelete(f) : undefined}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <FragmentEditor target={editor} onClose={() => setEditor(null)} />
      <DeleteFragmentDialog fragment={pendingDelete} onClose={() => setPendingDelete(null)} />
    </section>
  );
}

function FragmentRow({
  fragment,
  onEdit,
  onDelete,
}: {
  fragment: PromptFragment;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const firstLine = fragment.text.trim().split("\n")[0] ?? "";
  return (
    <li
      className="flex items-center justify-between gap-4 px-4 py-3"
      data-testid={`fragment-${fragment.id}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {fragment.title && (
            <span className="truncate text-sm font-medium">{fragment.title}</span>
          )}
          <code
            className={
              fragment.title
                ? "font-mono text-xs text-muted-foreground"
                : "font-mono text-sm font-medium"
            }
          >
            {fragment.id}
          </code>
          {fragment.isCustom && <Badge variant="outline">Customized</Badge>}
        </div>
        <p className="line-clamp-1 text-sm text-muted-foreground">{firstLine}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${fragment.id}`}
                onClick={onEdit}
              />
            }
          >
            <Pencil />
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        {onDelete && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${fragment.id}`}
                  onClick={onDelete}
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * 删除自建片段的确认框。仍被模式或通用提示词引用时后端 409，message 列出引用处：
 * 弹窗不关、就地显示（全局 toast 也会弹一次）。
 */
function DeleteFragmentDialog({
  fragment,
  onClose,
}: {
  fragment: PromptFragment | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFragment(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FRAGMENTS_QUERY_KEY });
      // 插入按钮里不再有它
      void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
      onClose();
    },
  });

  return (
    <AlertDialog
      open={fragment !== null}
      onOpenChange={(open) => {
        if (open || deleteMut.isPending) return;
        deleteMut.reset();
        onClose();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete fragment?</AlertDialogTitle>
          <AlertDialogDescription>
            <code className="block font-mono text-xs break-all text-foreground">
              {fragment?.id}
            </code>
            Modes can no longer reference it. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteMut.isError && (
          <p className="text-center text-sm text-destructive" role="alert">
            {deleteMut.error instanceof Error ? deleteMut.error.message : "Delete failed"}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={deleteMut.isPending}
            onClick={() => fragment && deleteMut.mutate(fragment.id)}
          >
            {deleteMut.isPending && <Loader2 className="animate-spin" />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
