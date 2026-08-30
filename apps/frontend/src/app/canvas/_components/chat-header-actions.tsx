"use client";

import { Eraser, Loader2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { TokenUsageDialog } from "./token-usage-dialog";

/**
 * 对话面板标题栏右侧的业务操作：token 用量徽标 + 清空会话记录。
 * 从 CanvasChat 的自带头部抽出来——桌面端它挂进 FloatingPanel 的标题栏，手机端挂进抽屉
 * 标题栏，两处共用一份，面板不会出现「外壳标题栏 + 内容标题栏」两条。
 */
export function ChatHeaderActions({
  sessionId,
  tokens,
  busy,
  clearing,
  onClear,
}: {
  /** 当前会话 id（null=未选中画布）；用于拉 token 用量详情 */
  sessionId: string | null;
  tokens: number;
  /** agent 运行中：清空按钮禁用 */
  busy: boolean;
  /** 清空请求在途：按钮转圈禁用 */
  clearing: boolean;
  onClear: () => void;
}) {
  const [usageOpen, setUsageOpen] = useState(false);

  return (
    <>
      {/* 点开看详情：按模型 / 每轮 / 每次调用 + 缓存命中率。无会话时降级为静态徽标 */}
      <Badge
        variant="secondary"
        render={sessionId ? <button type="button" /> : undefined}
        className={sessionId ? "cursor-pointer hover:bg-accent" : undefined}
        title={
          sessionId
            ? "Total tokens for this canvas (click for the breakdown)"
            : "Total tokens for this canvas (clearing history keeps it)"
        }
        onClick={sessionId ? () => setUsageOpen(true) : undefined}
      >
        {tokens.toLocaleString()} tokens
      </Badge>
      {/* 清空会话记录 + agent 上下文（节点与 token 统计保留）；运行期禁用 */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear chat history"
        title={
          busy
            ? "Cannot clear while running"
            : "Clear chat history and agent context (nodes stay)"
        }
        disabled={busy || clearing}
        onClick={onClear}
      >
        {clearing ? <Loader2 className="animate-spin" /> : <Eraser />}
      </Button>
      {sessionId && (
        <TokenUsageDialog
          sessionId={sessionId}
          open={usageOpen}
          onOpenChange={setUsageOpen}
        />
      )}
    </>
  );
}
