/**
 * 对话页：把会话数据（useConversation）接到拷自 Web 的 ChatThread / DetailPanel 上
 * （对应 Web agent-shell.tsx 里主区那一段）。模型、思考深度、权限、工作区都存在会话上，
 * 改动经 conversations.update 落到 agent-host，下一轮运行生效。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, PanelRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { useConversationOutputs } from './lib/conversation-outputs';
import { findToolItem } from './lib/thread';
import { FileViewerProvider } from '../viewer/file-viewer';
import { writeModePreference } from '../modes/mode-preference';
import { useHostStatus, useModelOptions } from '../llm/api';
import { CanvasAutoOpen } from '../canvas/canvas-auto-open';
import { CanvasOpenerContext, useOpenCanvas } from '../canvas/open-canvas-context';
import { ChatSidePanel } from '../side-panel/chat-side-panel';
import { useSidePanel } from '../side-panel/use-side-panel';
import { useOpenVideoEditor, VideoEditorOpenerContext } from '../video-editor/open-editor-context';

export function ChatView({
  id,
  hasModels,
  onOpenModelSettings,
  headerInset,
  onDeleted,
  embedded = false,
}: {
  id: string;
  /** 账号下至少有一个已启用的模型（host.status.hasModels）；没有时引导去添加 API 连接，不能发送 */
  hasModels: boolean;
  onOpenModelSettings: () => void;
  /** 侧栏收起时顶栏左侧的让位 */
  headerInset?: string;
  /** 在顶栏菜单里删除了本会话 */
  onDeleted: () => void;
  /**
   * 嵌在别的视图里（画布视图的右侧对话栏）：宽度有限，工具详情不再并排展开成侧栏，
   * 而是盖在对话上（关掉回到对话）
   */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const thread = useConversation(id);
  // 标题同 Web：取侧栏会话列表里的这一条（发送后 goal 回填，列表随 conversations-changed 刷新）
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}) });
  const conv = list.data?.find((c) => c.id === id) ?? thread.summary;
  const [activeDetailId, setActiveDetailId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  // 右侧侧栏（网页预览 / 剪辑器 / 画布）；外壳给的打开方式（切整页）留给嵌在画布页里的情况
  const side = useSidePanel();
  const outerVideoOpener = useOpenVideoEditor();
  const outerCanvasOpener = useOpenCanvas();
  const [stopRequested, setStopRequested] = useState(false);
  const outputs = useConversationOutputs(thread.items);
  const infoOpen = side.item?.kind === 'info';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: conversationKey(id) });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  const update = useMutation({
    mutationFn: (patch: {
      model?: string;
      thinkingLevel?: string | null;
      permission?: WorkspacePermission;
      workspaceDir?: string;
      modeId?: string | null;
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
    if (!hasModels) {
      toast.error(t('chat.view.noModels'));
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

  // 含 task 子线程里的嵌套 chip
  const selectedTool = activeDetailId ? findToolItem(thread.items, activeDetailId) : undefined;
  const options = useModelOptions();
  const status = useHostStatus();
  // 会话没存模型（建会话时还没有任何可用模型）：显示账号默认模型，下一轮 host 也按它跑
  const model = conv?.model ?? status.data?.defaultModel ?? '';
  // 思考档位来自所选模型的能力；模型不可用时只剩「自动」（host 回落到默认模型）
  const thinkingLevels = options.data?.find((m) => m.ref === model)?.capabilities.thinkingLevels ?? ['auto'];
  const savedLevel = asThinkingLevel(conv?.thinkingLevel) ?? 'auto';
  // 换模型后旧档位可能不再可选：显示实际生效的「自动」（同 host 的 effectiveLevel）
  const thinkingLevel: ThinkingLevel = thinkingLevels.includes(savedLevel) ? savedLevel : 'auto';
  // agent 发来审批 / 提问时，展开全部的侧栏会把对话里的审批面板整个盖住：收回停靠，让审批露出来
  const approvalPending = thread.approval != null;
  const [sawApproval, setSawApproval] = useState(approvalPending);
  if (approvalPending !== sawApproval) {
    setSawApproval(approvalPending);
    if (approvalPending && side.expanded) side.collapse();
  }
  const untitled = t('shell.conversation.untitled');
  const title = conv ? conv.title ?? (conv.goal || untitled) : untitled;

  return (
    // 对话里的链接在这里预览：带会话 id 与工作区，相对路径能读到工作区文件
    <FileViewerProvider
      conversationId={id}
      workspaceDir={conv?.workspaceDir ?? null}
      // 网页预览开在右侧侧栏（嵌在画布页里时没有侧栏，仍用全屏弹窗）
      onShowSite={embedded ? undefined : side.openSite}
    >
      <PreviewAutoOpen conversationId={id} />
      {!embedded && <CanvasAutoOpen conversationId={id} onOpen={side.openCanvas} />}
      {/* 剪辑工程卡片、画布卡片、工作区面板经这两个上下文打开：在对话里开到侧栏；嵌在画布页里时沿用外壳的（切整页） */}
      <VideoEditorOpenerContext.Provider value={embedded ? outerVideoOpener : (target) => side.openVideo(target.path)}>
      <CanvasOpenerContext.Provider value={embedded ? outerCanvasOpener : (target) => side.openCanvas(target.canvasId)}>
      <div className="relative flex h-full w-full overflow-clip">
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
          // 会话信息侧栏（嵌在画布页里时没有侧栏）
          headerEnd={
            embedded ? undefined : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('chat.info.open')}
                title={t('chat.info.open')}
                aria-pressed={infoOpen}
                data-testid="conversation-info-toggle"
                onClick={side.toggleInfo}
              >
                <PanelRight />
              </Button>
            )
          }
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
          thinkingLevels={thinkingLevels}
          sendDisabled={!hasModels}
          composerNotice={
            hasModels ? undefined : (
              <Alert className="mb-2 has-data-[slot=alert-action]:pr-36" data-testid="no-models-notice">
                <KeyRound />
                <AlertTitle>{t('chat.view.noModelsTitle')}</AlertTitle>
                <AlertDescription>{t('chat.view.noModelsDescription')}</AlertDescription>
                <AlertAction>
                  <Button size="sm" onClick={onOpenModelSettings}>
                    {t('chat.view.openModelSettings')}
                  </Button>
                </AlertAction>
              </Alert>
            )
          }
          tokens={thread.tokens}
          workspaceDir={conv?.workspaceDir ?? null}
          permission={conv?.permission ?? 'ask'}
          onPermissionChange={(permission) => update.mutate({ permission })}
          canChangeWorkspace={thread.messageCount === 0 && !thread.busy}
          onChangeWorkspace={() => void changeWorkspace()}
          modeId={conv?.modeId ?? null}
          onModeChange={(modeId) => {
            // 记成最近用的模式：之后新建会话默认带上
            writeModePreference(modeId);
            update.mutate({ modeId });
          }}
        />
        {panelOpen && selectedTool && !embedded && (
          <DetailPanel tool={selectedTool} onClose={() => setPanelOpen(false)} />
        )}
        {panelOpen && selectedTool && embedded && (
          <DetailPanel
            tool={selectedTool}
            onClose={() => setPanelOpen(false)}
            className="lg:absolute lg:inset-0 lg:z-10 lg:w-full lg:border-l-0"
          />
        )}
        {!embedded && (
          <ChatSidePanel
            item={side.item}
            expanded={side.expanded}
            width={side.width}
            actions={side.actions}
            conversationId={id}
            workspaceDir={conv?.workspaceDir ?? null}
            headerInset={headerInset}
            detailOpen={panelOpen && !!selectedTool}
            conversation={conv}
            tokens={thread.tokens}
            outputs={outputs}
          />
        )}
      </div>
      </CanvasOpenerContext.Provider>
      </VideoEditorOpenerContext.Provider>
    </FileViewerProvider>
  );
}
