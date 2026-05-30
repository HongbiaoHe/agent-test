"use client";

import {
  Activity,
  FileText,
  Globe,
  Loader,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { Attachment, Detail, Message } from "../_data/mock";

const TOOL_ICON: Record<string, LucideIcon> = {
  read_file: FileText,
  run_command: Terminal,
  web_search: Globe,
  analyze_bundle: Activity,
};

function AttachmentChip({
  attachment,
  detail,
  active,
  onOpen,
}: {
  attachment: Attachment;
  detail?: Detail;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const isFile = attachment.type === "file";
  const Icon =
    detail?.kind === "tool"
      ? (TOOL_ICON[detail.name] ?? Terminal)
      : FileText;
  const running = detail?.kind === "tool" && detail.status === "running";

  return (
    <button
      type="button"
      onClick={() => onOpen(attachment.detailId)}
      className={cn(
        "inline-flex max-w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
        active
          ? "border-ring bg-accent"
          : "bg-card hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {running ? (
        <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate font-medium">{attachment.label}</span>
      {isFile && (
        <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
          文件
        </span>
      )}
    </button>
  );
}

export function ChatMessage({
  message,
  details,
  activeDetailId,
  onOpenDetail,
}: {
  message: Message;
  details: Record<string, Detail>;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <p className="text-sm leading-relaxed text-foreground/90">
          {message.content}
        </p>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.attachments.map((att) => (
              <AttachmentChip
                key={att.detailId}
                attachment={att}
                detail={details[att.detailId]}
                active={activeDetailId === att.detailId}
                onOpen={onOpenDetail}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
