/**
 * 对话里的画布卡片：agent 的 create_canvas / open_canvas 成功后在工具 chip 之后出现，
 * 「打开画布」把本对话的当前画布切到这一块并进入画布视图（右侧对话栏就是本对话）。
 */
import { Network, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { agent } from '@/lib/agent-client';
import { useOpenCanvas } from '../open-canvas-context';
import type { CanvasCardInfo } from '../lib/tool-result';

export function CanvasCard({ conversationId, info }: { conversationId: string; info: CanvasCardInfo }) {
  const { t } = useTranslation();
  const open = useOpenCanvas();
  const title = info.title ?? t('canvas.list.untitled');
  return (
    <div className="flex max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5" data-testid="canvas-card">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Network className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {info.nodes !== undefined && (
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {t('canvas.card.nodes', { count: info.nodes })}
          </p>
        )}
      </div>
      {open && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            // 用户点开 = 把本对话的当前画布切到这一块（agent 之后操作的就是它）
            agent.call('conversations.setCanvas', { conversationId, canvasId: info.canvasId }).then(
              () => open({ canvasId: info.canvasId, conversationId }),
              (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          <SquarePen />
          {t('canvas.card.open')}
        </Button>
      )}
    </div>
  );
}
