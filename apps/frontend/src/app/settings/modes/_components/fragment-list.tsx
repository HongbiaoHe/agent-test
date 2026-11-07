"use client";

import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { listFragments, type PromptFragment } from "@/lib/api";

import { FragmentEditor, FRAGMENTS_QUERY_KEY } from "./fragment-editor";

/**
 * 「Platform fragments」区块：内置 4 个片段（不能新增），每行 id + 正文首行 + 改写标记 + 编辑。
 * 片段被所有引用它的模式共用；改写只对当前用户生效。
 */
export function FragmentSection() {
  const [editing, setEditing] = useState<PromptFragment | null>(null);
  const query = useQuery({ queryKey: FRAGMENTS_QUERY_KEY, queryFn: listFragments });

  return (
    <section className="space-y-3" aria-labelledby="platform-fragments-title">
      <div className="space-y-1">
        <h3 id="platform-fragments-title" className="text-base font-semibold">
          Platform fragments
        </h3>
        <p className="text-sm text-muted-foreground">
          The text each <code className="font-mono text-xs">{"{{platform.*}}"}</code> placeholder
          expands to. Your edits apply to every mode that uses the fragment, and only for you.
        </p>
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
            <ul className="divide-y">
              {query.data.map((f) => (
                <FragmentRow key={f.id} fragment={f} onEdit={() => setEditing(f)} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <FragmentEditor fragment={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function FragmentRow({
  fragment,
  onEdit,
}: {
  fragment: PromptFragment;
  onEdit: () => void;
}) {
  const firstLine = fragment.text.trim().split("\n")[0] ?? "";
  return (
    <li
      className="flex items-center justify-between gap-4 px-4 py-3"
      data-testid={`fragment-${fragment.id}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-medium">{fragment.id}</code>
          {fragment.isCustom && <Badge variant="outline">Customized</Badge>}
        </div>
        <p className="line-clamp-1 text-sm text-muted-foreground">{firstLine}</p>
      </div>
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
    </li>
  );
}
