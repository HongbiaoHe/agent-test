/**
 * 对话页：把会话数据（useConversation）接到拷自 Web 的 ChatThread / DetailPanel 上
 * （对应 Web agent-shell.tsx 里主区那一段）。模型、思考深度、权限、工作区都存在会话上，
 * 改动经 conversations.update 落到 agent-host，下一轮运行生效。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { agent } from '@/lib/agent-client';
import { asThinkingLevel, type ThinkingLevel } from '@/lib/thinking-level';
import type { HitlDecision } from '../../../../shared/rpc';
import type { WorkspacePermission } from '../../../../shared/workspace';
import { attachmentTypeOf } from '@/components/attachments/attachments';
import { ChatThread } from './components/chat-thread';
import { ConversationTitleMenu, ConversationToolbarIcons } from './components/conversation-toolbar';
import { PreviewAutoOpen } from './components/preview-card';
import { DetailPanel } from './components/detail-panel';
import { conversationKey, useConversation } from './hooks/use-conversation';
import { DEFAULT_MODEL } from './lib/models';
import type { ThreadItem } from './lib/thread';
import { FileViewerProvider } from '../viewer/file-viewer';

export function ChatView({
  id,
  hasKey,
  headerInset,
  onDeleted,
}: {
  id: string;
  hasKey: boolean;
  /** 侧栏收起时顶栏左侧的让位 */
  headerInset?: string;
  /** 在顶栏菜单里删除了本会话 */
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const thread = useConversation(id);
  // 标题同 Web：取侧栏会话列表里的这一条（发送后 goal 回填，列表随 conversations-changed 刷新）
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}) });
  const conv = list.data?.find((c) => c.id === id) ?? thread.summary;
  const [activeDetailId, setActiveDetailId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [stopRequested, setStopRequested] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: conversationKey(id) });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    // 外壳按会话模型判断「有没有 Key」（app.tsx 的 conversation-model 查询）
    void qc.invalidateQueries({ queryKey: ['conversation-model', id] });
  };
  const update = useMutation({
    mutationFn: (patch: {
      model?: string;
      thinkingLevel?: string | null;
      permission?: WorkspacePermission;
      workspaceDir?: string;
    }) => agent.call('conversations.update', { id, ...patch }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const stop = useMutation({
    mutationFn: () => agent.call('run.stop', { conversationId: id }),
    onError: (e) => toast.error(e.message),
  });

  if (stopRequested && !thread.busy) setStopRequested(false);

  function handleSend(text: string, attachments: string[]) {
    if (!hasKey) {
      toast.error(t('chat.view.noKey'));
      return;
    }
    thread.pushUserMessage(
      text,
      attachments.map((p) => {
        const filename = p.split(/[\\/]/).pop() ?? p;
        return { filename, path: p, size: 0, type: attachmentTypeOf(filename) };
      }),
    );
    agent.call('run.start', { conversationId: id, text, attachments }).then(
      () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
      (e: unknown) => {
        thread.markIdle();
        refresh();
        toast.error(e instanceof Error ? e.message : String(e));
      },
    );
  }

  async function changeWorkspace() {
    const dir = await window.desktop.pickFolder();
    if (dir) update.mutate({ workspaceDir: dir });
  }

  const selectedTool = activeDetailId
    ? thread.items.find(
        (it): it is Extract<ThreadItem, { kind: 'tool' }> => it.kind === 'tool' && it.id === activeDetailId,
      )
    : undefined;
  const model = conv?.model ?? DEFAULT_MODEL;
  const thinkingLevel: ThinkingLevel = asThinkingLevel(conv?.thinkingLevel) ?? 'auto';
  const untitled = t('shell.conversation.untitled');
  const title = conv ? conv.title ?? (conv.goal || untitled) : untitled;

  return (
    // 对话里的链接在这里预览：带会话 id 与工作区，相对路径能读到工作区文件
    <FileViewerProvider conversationId={id} workspaceDir={conv?.workspaceDir ?? null}>
      <PreviewAutoOpen conversationId={id} />
      <div className="flex h-full w-full overflow-clip">
        <ChatThread
          title={title}
          headerInset={headerInset}
          headerTitle={
            <ConversationTitleMenu
              conversationId={id}
              title={title}
              pinned={(conv?.pinnedAt ?? null) !== null}
              workspaceDir={conv?.workspaceDir ?? null}
              onDeleted={onDeleted}
            />
          }
          headerTools={<ConversationToolbarIcons items={thread.items} />}
          conversationId={id}
          items={thread.items}
          approval={thread.approval}
          busy={thread.busy}
          turnStartedAt={thread.turnStartedAt}
          isLoading={thread.isLoading}
          isNewChat={false}
          creating={false}
          onNewChat={() => undefined}
          activeDetailId={panelOpen ? activeDetailId : null}
          onOpenDetail={(detailId) => {
            setActiveDetailId(detailId);
            setPanelOpen(true);
          }}
          onDecide={(decisions) => {
            // ApprovalPanel / QuestionPanel 产出的就是 HITL 决策形状（rpc 侧还会再用 zod 校验）
            thread.respondApproval(decisions as HitlDecision[]).catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : String(e)),
            );
          }}
          onSend={handleSend}
          onStop={() => {
            if (stopRequested) return;
            setStopRequested(true);
            stop.mutate();
          }}
          stopping={stopRequested}
          model={model}
          onModelChange={(m) => update.mutate({ model: m })}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={(level) => update.mutate({ thinkingLevel: level === 'auto' ? null : level })}
          tokens={thread.tokens}
          workspaceDir={conv?.workspaceDir ?? null}
          permission={conv?.permission ?? 'ask'}
          onPermissionChange={(permission) => update.mutate({ permission })}
          canChangeWorkspace={thread.messageCount === 0 && !thread.busy}
          onChangeWorkspace={() => void changeWorkspace()}
        />
        {panelOpen && selectedTool && (
          <DetailPanel tool={selectedTool} onClose={() => setPanelOpen(false)} />
        )}
      </div>
    </FileViewerProvider>
  );
}
