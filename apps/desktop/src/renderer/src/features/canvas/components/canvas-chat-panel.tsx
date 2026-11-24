/**
 * 画布视图的右侧对话栏：
 *  - 已有对话：就是那个对话本身（同一个 ChatView，消息、审批、模型切换都一样）；
 *  - 还没有对话（从画布列表打开、没有对话绑定过这块画布）：一个只管第一条消息的输入框，
 *    发出时才新建对话、把这块画布设为它的当前画布并开跑——不为「看一眼画布」留下空对话。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { agent } from '@/lib/agent-client';
import { ChatView } from '../../chat/chat-view';
import { readModePreference } from '../../modes/mode-preference';

export function CanvasChatPanel({
  canvasId,
  conversationId,
  hasModels,
  onOpenModelSettings,
  onConversationStarted,
  onDeleted,
}: {
  canvasId: string;
  conversationId: string | null;
  hasModels: boolean;
  onOpenModelSettings: () => void;
  /** 第一条消息发出后：视图把右侧栏接到新对话上 */
  onConversationStarted: (conversationId: string) => void;
  /** 在对话的顶栏菜单里删除了它 */
  onDeleted: () => void;
}) {
  if (conversationId) {
    return (
      <ChatView
        key={conversationId}
        id={conversationId}
        hasModels={hasModels}
        onOpenModelSettings={onOpenModelSettings}
        onDeleted={onDeleted}
        embedded
      />
    );
  }
  return (
    <FirstMessage
      canvasId={canvasId}
      hasModels={hasModels}
      onOpenModelSettings={onOpenModelSettings}
      onStarted={onConversationStarted}
    />
  );
}

function FirstMessage({
  canvasId,
  hasModels,
  onOpenModelSettings,
  onStarted,
}: {
  canvasId: string;
  hasModels: boolean;
  onOpenModelSettings: () => void;
  onStarted: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const start = useMutation({
    mutationFn: async (message: string) => {
      // 新对话带上最近用的模式（同首页「新对话」）；建好先绑画布再开跑，第一轮就能看到画布
      // 一定新建（不复用空会话）：下面开跑失败会删掉它，不能删到用户已有的会话
      const conv = await agent.call('conversations.create', { modeId: readModePreference() ?? undefined, reuseEmpty: false });
      try {
        await agent.call('conversations.setCanvas', { conversationId: conv.id, canvasId });
        await agent.call('run.start', { conversationId: conv.id, text: message, attachments: [] });
      } catch (e) {
        // 没开跑起来：删掉刚建的对话，免得每重试一次就多一个绑着这块画布的空对话（输入框里的话还在，可直接重发）
        await agent.call('conversations.delete', { id: conv.id }).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        throw e;
      }
      return conv.id;
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      onStarted(id);
    },
  });
  const send = () => {
    const message = text.trim();
    if (!message || start.isPending) return;
    start.mutate(message);
  };

  return (
    <div className="flex h-full flex-col" data-testid="canvas-first-message">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('canvas.panel.title')}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium">{t('canvas.panel.emptyTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('canvas.panel.emptyDescription')}</p>
      </div>
      <div className="shrink-0 space-y-2 p-3">
        {start.isError && (
          <p className="text-sm text-destructive" role="alert">
            {t('canvas.panel.startFailed', { message: start.error.message })}
          </p>
        )}
        {hasModels ? (
          <div className="rounded-xl border bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/40">
            <Textarea
              aria-label={t('canvas.panel.placeholder')}
              placeholder={t('canvas.panel.placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={start.isPending}
              className="min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="flex justify-end">
              <Button
                size="icon-sm"
                aria-label={start.isPending ? t('canvas.panel.sending') : t('canvas.panel.send')}
                disabled={!text.trim() || start.isPending}
                onClick={send}
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
        ) : (
          <Button className="w-full" variant="outline" onClick={onOpenModelSettings}>
            {t('canvas.panel.noModels')}
          </Button>
        )}
      </div>
    </div>
  );
}
