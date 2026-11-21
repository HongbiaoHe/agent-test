"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** 复制到剪贴板，成功后图标变勾 1.5 秒 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon-sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** 一段可复制的等宽代码 */
export function CopyBlock({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/50 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre">
        {value}
      </pre>
      <CopyButton value={value} label={label} />
    </div>
  );
}
