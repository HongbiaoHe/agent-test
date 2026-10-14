import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * 对话流里的报错提示（agent 与画布共用）。
 *
 * 模型/网关报错常带超长 URL 与整段 JSON（无空格，默认不会换行，会撑出边框）：
 * - overflow-wrap:anywhere 允许在任意位置断行，min-w-0 让网格列能收窄到容器宽度；
 * - whitespace-pre-wrap 保留原文换行；
 * - 限高 + 内部滚动，避免一条报错占满整屏。
 */
export function ErrorNotice({ message }: { message: string }) {
  return (
    <Alert
      variant="destructive"
      className="rounded-xl border-destructive/40 bg-destructive/10 px-3"
    >
      <CircleAlert />
      <AlertDescription className="max-h-48 min-w-0 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {message}
      </AlertDescription>
    </Alert>
  );
}
