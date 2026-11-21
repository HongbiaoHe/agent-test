/**
 * 画布视图（呈现方式同剪辑器）：占满主区，顶栏「返回」+ 画布名（可改名）+ 状态；中间是与 Web 共用的
 * 画布编辑区（@agent-test/canvas-ui），右侧是可收起的对话栏（就是绑定这块画布的那个对话）。
 * 画布数据在 Web 账号下，经 agent-host 调 Web 后端；对话与 agent 在本机。
 */
import {
  CanvasPlatformProvider,
  CanvasSaveStatus,
  FlowCanvas,
  type CanvasLocale,
  type CanvasPlatform,
} from '@agent-test/canvas-ui';
import { TooltipProvider } from '@agent-test/ui/tooltip';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent } from '@/lib/agent-client';
import { fetchMediaAssetBlob } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CanvasChatPanel } from './components/canvas-chat-panel';
import { useCanvasDocument } from './hooks/use-canvas-document';
import { CANVAS_LIST_KEY, canvasSnapshotKey } from './lib/query-keys';

/** desktop 的界面语言 → 画布包的字典语言 */
function canvasLocaleOf(language: string): CanvasLocale {
  if (language === 'zh-CN' || language === 'zh-Hant') return language;
  return 'en';
}

export function CanvasView({
  canvasId,
  conversationId,
  hasModels,
  headerInset,
  onBack,
  onOpenModelSettings,
  onConversationChange,
}: {
  canvasId: string;
  /** 右侧对话栏显示的对话；null = 还没有（发第一条消息时新建并绑定） */
  conversationId: string | null;
  hasModels: boolean;
  /** 侧栏收起时顶栏左侧的让位（COLLAPSED_HEADER_INSET 类名） */
  headerInset?: string;
  onBack: () => void;
  onOpenModelSettings: () => void;
  /** 右侧对话栏换了对话（第一条消息新建的 / 对话被删了） */
  onConversationChange: (conversationId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [chatOpen, setChatOpen] = useState(true);
  return (
    <CanvasWorkspace
      canvasId={canvasId}
      headerInset={headerInset}
      leading={
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" />
          {conversationId ? t('canvas.view.backToChat') : t('canvas.view.back')}
        </Button>
      }
      trailing={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={chatOpen ? t('canvas.view.hideChat') : t('canvas.view.showChat')}
          aria-pressed={chatOpen}
          onClick={() => setChatOpen((v) => !v)}
        >
          {chatOpen ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
      }
      aside={
        chatOpen && (
          <aside className="flex w-[420px] shrink-0 flex-col border-l border-border bg-background" data-testid="canvas-chat-panel">
            <CanvasChatPanel
              canvasId={canvasId}
              conversationId={conversationId}
              hasModels={hasModels}
              onOpenModelSettings={onOpenModelSettings}
              onConversationStarted={(id) => onConversationChange(id)}
              onDeleted={() => onConversationChange(null)}
            />
          </aside>
        )
      }
    />
  );
}

/**
 * 画布的顶栏（画布名可改名 + 「agent 正在编辑」状态）+ 共享的画布编辑区，可在右边挂一栏：
 * 整页画布视图挂对话栏；对话里的侧栏不挂（对话本身就在旁边）。
 */
export function CanvasWorkspace({
  canvasId,
  headerInset,
  leading,
  trailing,
  aside,
}: {
  canvasId: string;
  headerInset?: string;
  /** 顶栏最左（如「返回」） */
  leading?: ReactNode;
  /** 顶栏最右（如收起对话栏、侧栏的展开 / 关闭） */
  trailing?: ReactNode;
  /** 编辑区右边的一栏 */
  aside?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const locale = canvasLocaleOf(i18n.language);
  const platform: CanvasPlatform = useMemo(
    () => ({
      locale,
      fetchMediaAssetBlob,
      listAigcModels: (type) => agent.call('canvas.aigcModels', { type }),
    }),
    [locale],
  );
  const doc = useCanvasDocument(canvasId, locale);
  const { board, snapshot } = doc;

  const lock = board.activeLock;
  const status = lock
    ? lock.label
      ? t('canvas.view.lockedByAgent', { label: lock.label })
      : t('canvas.view.lockedByAgentUnnamed')
    : doc.serverAgentRunning
      ? t('canvas.view.serverAgentRunning')
      : null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="canvas-view">
      <header className={cn('app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border px-3', headerInset)}>
        {leading}
        <CanvasTitle canvasId={canvasId} title={snapshot?.title ?? null} />
        {status && (
          <Badge variant="secondary" className="min-w-0 gap-1" data-testid="canvas-lock-status">
            <Lock className="size-3 shrink-0" />
            <span className="max-w-72 truncate">{status}</span>
          </Badge>
        )}
        <div className="flex-1" />
        {trailing}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" data-testid="canvas-board">
          {doc.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-destructive" role="alert">
                {t('canvas.view.loadFailed', { message: doc.error.message })}
              </p>
              <Button size="sm" variant="outline" onClick={doc.retry}>
                {t('canvas.view.retry')}
              </Button>
            </div>
          ) : (
            <CanvasPlatformProvider value={platform}>
              <TooltipProvider>
                <FlowCanvas
                  key={canvasId}
                  canvas={board.canvas}
                  readOnly={doc.readOnly}
                  onMoveNode={board.moveNode}
                  onApplyOp={board.applyOp}
                  saveStates={board.saveStates}
                  onMarkSaving={board.markSaving}
                  onCancelSaving={board.cancelSaving}
                  onRetryMedia={board.retryMedia}
                  onGenerateNode={board.generateNode}
                  onMergeVideo={board.mergeVideo}
                  onPauseMedia={board.pauseMedia}
                  onResumeMedia={board.resumeMedia}
                  onUploadNodeFile={board.uploadNodeFile}
                  loading={doc.isLoading}
                  focusNodeIds={board.focusNodeIds}
                  onSetFocus={board.setFocus}
                  onAddConnectedNode={board.addNode}
                />
                <CanvasSaveStatus saveStates={board.saveStates} className="absolute top-3 left-3" />
              </TooltipProvider>
            </CanvasPlatformProvider>
          )}
        </div>
        {aside}
      </div>
    </div>
  );
}

/** 画布名：点一下变成输入框改名（回车 / 失焦保存，Esc 取消） */
function CanvasTitle({ canvasId, title }: { canvasId: string; title: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = title || t('canvas.list.untitled');
  const rename = useMutation({
    mutationFn: (next: string) => agent.call('canvas.rename', { id: canvasId, title: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: canvasSnapshotKey(canvasId) });
      void qc.invalidateQueries({ queryKey: CANVAS_LIST_KEY });
    },
    onError: (e) => toast.error(t('canvas.view.renameFailed', { message: e.message })),
  });
  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== title) rename.mutate(next);
  };
  if (draft !== null) {
    return (
      <Input
        autoFocus
        aria-label={t('canvas.view.rename')}
        value={draft}
        maxLength={100}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="h-7 w-64"
      />
    );
  }
  return (
    <button
      type="button"
      title={t('canvas.view.rename')}
      className="max-w-80 cursor-text truncate rounded-md px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
      onClick={() => setDraft(title ?? '')}
    >
      {shown}
    </button>
  );
}
