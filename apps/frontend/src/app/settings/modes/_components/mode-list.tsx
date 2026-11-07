"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
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
import {
  type AgentMode,
  deleteMode,
  type GeneralModeSettings,
  getGeneralMode,
  listModes,
} from "@/lib/api";

import { modelDisplayName } from "@/app/agent/_lib/models";

/** 模式列表缓存键：设置页与会话内模式切换器共用（增删改后都要 invalidate）。 */
export const MODES_QUERY_KEY = ["modes"] as const;
/** 通用模式设置缓存键：设置页与新建会话（回填默认模型）共用，保存后 invalidate。 */
export const GENERAL_MODE_QUERY_KEY = ["general-mode"] as const;

/** 用户模式列表（通用模式卡片另见 GeneralModeCard）：名称 + 工具 / 连接器 / 技能计数 + 默认模型；编辑 / 删除（带确认）。 */
export function ModeList({ onEdit }: { onEdit: (mode: AgentMode) => void }) {
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<AgentMode | null>(null);

  const query = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMode(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MODES_QUERY_KEY });
      // 引用它的会话已被后端置回通用模式：会话列表与打开的会话都要重拉
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["conversation"] });
      setPendingDelete(null);
    },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load modes"}
        </CardContent>
      </Card>
    );
  }

  const modes = query.data ?? [];

  if (modes.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <SlidersHorizontal className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No custom modes yet. Conversations without one use General above;
            create a mode to give the agent a focused prompt and a narrower
            toolset.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {modes
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((mode) => (
          <ModeCard
            key={mode.id}
            name={mode.name}
            systemPrompt={mode.systemPrompt}
            defaultModel={mode.defaultModel}
            defaultThinkingLevel={mode.defaultThinkingLevel}
            details={
              <>
                <Badge variant="outline">{count(mode.toolNames.length, "tool")}</Badge>
                <Badge variant="outline">
                  {count(mode.mcpServerIds.length, "connector")}
                </Badge>
                <Badge variant="outline">{count(mode.skillNames.length, "skill")}</Badge>
              </>
            }
            onEdit={() => onEdit(mode)}
            onDelete={() => setPendingDelete(mode)}
          />
        ))}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleteMut.isPending && setPendingDelete(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete mode?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="line-clamp-2 font-medium break-all text-foreground">
                {pendingDelete?.name}
              </span>
              Conversations using it will fall back to the general mode. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => pendingDelete && deleteMut.mutate(pendingDelete.id)}
            >
              {deleteMut.isPending && <Loader2 className="animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * 通用模式卡片：固定在列表最上方，只能编辑不能删除（工具 / 连接器 / 技能恒为全部）。
 * 设置每个用户一份，没存过 = 全默认。
 */
export function GeneralModeCard({
  onEdit,
}: {
  onEdit: (settings: GeneralModeSettings) => void;
}) {
  const query = useQuery({ queryKey: GENERAL_MODE_QUERY_KEY, queryFn: getGeneralMode });

  if (query.isLoading) return <Skeleton className="h-20 w-full rounded-xl" />;
  if (!query.data) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load the general mode"}
        </CardContent>
      </Card>
    );
  }

  const settings = query.data;
  return (
    <ModeCard
      name="General"
      tags={
        <>
          <Badge variant="outline">Default</Badge>
          {settings.isCustom && <Badge variant="outline">Customized</Badge>}
        </>
      }
      systemPrompt={settings.systemPrompt}
      defaultModel={settings.defaultModel}
      defaultThinkingLevel={settings.defaultThinkingLevel}
      details={
        <span className="text-xs text-muted-foreground">
          Every tool, connector and skill — including ones added later
        </span>
      }
      onEdit={() => onEdit(settings)}
    />
  );
}

/** 单条模式卡片：名称（+ 标签）、默认模型、提示词首行、底部明细；编辑 / 删除（不传 onDelete 则无删除）。 */
function ModeCard({
  name,
  tags,
  systemPrompt,
  defaultModel,
  defaultThinkingLevel,
  details,
  onEdit,
  onDelete,
}: {
  name: string;
  tags?: React.ReactNode;
  systemPrompt: string;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
  details: React.ReactNode;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const firstLine = systemPrompt.trim().split("\n")[0] ?? "";
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            {tags}
            {defaultModel && (
              <Badge variant="secondary" className="font-mono">
                {modelDisplayName(defaultModel)}
                {defaultThinkingLevel ? ` · ${defaultThinkingLevel}` : ""}
              </Badge>
            )}
          </div>
          <p className="line-clamp-1 text-sm text-muted-foreground">
            {firstLine || "(Empty prompt)"}
          </p>
          <div className="flex flex-wrap gap-1.5">{details}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${name}`}
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
                    aria-label={`Delete ${name}`}
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
      </CardContent>
    </Card>
  );
}
