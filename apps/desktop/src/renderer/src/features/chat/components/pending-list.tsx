/**
 * 待发消息：agent 在跑的时候用户又发来、还没送达的消息，固定在输入框上方。
 * - steer：主 agent 下一次调用模型前插入；queue：这一轮结束后发（以 / 开头的命令只能排队）。
 * - 每条可以删除，或点编辑退回输入框重写。
 * - 会话空闲时（被停止 / 失败 / 重启后）它们不会自己发出去：顶上给一个「发送」，作为新的一轮发出。
 */
import { Paperclip, Pencil, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { PendingMessage } from '../../../../../shared/rpc';

export function PendingList({
  items,
  idle,
  onRemove,
  onEdit,
  onSend,
}: {
  items: PendingMessage[];
  /** 会话没在运行：这些消息不会自己送达，显示「发送」 */
  idle: boolean;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const labelOf = (m: PendingMessage) =>
    m.kind === 'steer'
      ? t('chat.pending.steer')
      : m.text.trimStart().startsWith('/')
        ? t('chat.pending.command')
        : t('chat.pending.queue');
  return (
    <section
      aria-label={t('chat.pending.title')}
      data-testid="pending-list"
      className="mb-2 rounded-xl border border-border bg-muted/40 p-1.5"
    >
      {idle && (
        <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
          <span className="text-xs text-muted-foreground">{t('chat.pending.idleTitle', { count: items.length })}</span>
          <Button size="xs" onClick={onSend} data-testid="pending-send">
            <Send />
            {t('chat.pending.send')}
          </Button>
        </div>
      )}
      <ul className="space-y-1">
        {items.map((m) => (
          <li
            key={m.id}
            data-testid="pending-item"
            className="flex items-start gap-2 rounded-lg bg-card px-2 py-1.5 text-sm"
          >
            <Badge variant={m.kind === 'steer' ? 'secondary' : 'outline'} className="mt-0.5 shrink-0">
              {labelOf(m)}
            </Badge>
            <span className="min-w-0 flex-1">
              {m.text && <span className="line-clamp-2 break-words whitespace-pre-wrap">{m.text}</span>}
              {m.attachments.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {t('chat.pending.attachments', { count: m.attachments.length })}
                </span>
              )}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('chat.pending.edit')}
              title={t('chat.pending.edit')}
              onClick={() => onEdit(m.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('chat.pending.remove')}
              title={t('chat.pending.remove')}
              onClick={() => onRemove(m.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
