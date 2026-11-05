import { File, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/** 输入框上方待发送的附件（本地路径；发送时由 agent-host 复制） */
export function ComposerAttachments({
  items,
  onRemove,
}: {
  items: string[];
  onRemove: (path: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Pending attachments" className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((p) => (
        <li
          key={p}
          title={p}
          className="flex max-w-56 items-center gap-1.5 rounded-lg border bg-muted/50 py-1 pr-1 pl-2 text-xs"
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{p.split(/[\\/]/).pop()}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${p.split(/[\\/]/).pop()}`}
            onClick={() => onRemove(p)}
          >
            <X />
          </Button>
        </li>
      ))}
    </ul>
  );
}
