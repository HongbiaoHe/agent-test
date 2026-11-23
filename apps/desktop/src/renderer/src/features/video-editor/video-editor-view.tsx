/**
 * 剪辑器（在对话的右侧侧栏里打开，可展开全部；嵌在画布页对话里打开时仍占满主区）：顶栏 + 保存状态 + 撤销重做 + 导出；
 * 左侧预览播放器 / 播放控件 / 工具条 / 时间线，右侧检查器。工程读写与冲突见 hooks/use-video-document.ts。
 */
import { projectDuration } from '@agent-test/video-schema';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, Check, Clapperboard, Loader2, Redo2, Undo2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { EditActions } from './components/edit-actions';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { FileViewerProvider } from '../viewer/file-viewer';
import { ConflictBanner } from './components/conflict-banner';
import { ExportDialog } from './components/export-dialog';
import { Inspector } from './components/inspector';
import { IssuesPanel } from './components/issues-panel';
import { InvalidProject } from './components/invalid-project';
import { MediaToolbar } from './components/media-toolbar';
import { PlaybackControls } from './components/playback-controls';
import { PreviewPlayer } from './components/preview-player';
import { Timeline, type TimelineMarker } from './components/timeline';
import { type EditorChecks, useEditorChecks } from './hooks/use-editor-checks';
import { type PlaybackClock, useClockSelect, useCreateClock } from './hooks/use-clock';
import { useVideoDocument, type VideoDocument } from './hooks/use-video-document';
import { useVideoExport } from './hooks/use-video-export';
import { useWorkspaceOrigin } from './hooks/use-workspace-origin';
import { removeSelection, type Selection } from './lib/edit';
import { type EditorIssue, ruleParams } from './lib/issues';
import { isTypingTarget } from './lib/keyboard';
import { duplicateSelection, splitSelectionAt } from './lib/timeline-edit';

export function VideoEditorView({
  conversationId,
  path,
  headerInset,
  onBack,
  headerExtra,
}: {
  conversationId: string;
  path: string;
  /** 侧栏收起时顶栏左侧让出红绿灯与侧栏开关 */
  headerInset?: string;
  /** 「返回对话」；在对话的右侧侧栏里打开时不给（对话就在旁边） */
  onBack?: () => void;
  /** 顶栏最右（在侧栏里打开时是展开 / 关闭按钮） */
  headerExtra?: ReactNode;
}) {
  const { t } = useTranslation();
  const doc = useVideoDocument(conversationId, path);
  // 快捷键只在「正在用剪辑器」时生效：剪辑器开在对话侧栏里时，用户在旁边的对话里点了按钮再按退格 / ⌘Z，
  // 不能删掉时间线片段、撤销剪辑。最近一次点按 / 聚焦落在剪辑器里才算；整页打开时一开始就算
  const sectionRef = useRef<HTMLElement>(null);
  const shortcutsActive = useRef(onBack !== undefined);
  useEffect(() => {
    const track = (e: Event) => {
      shortcutsActive.current = e.target instanceof Node && !!sectionRef.current?.contains(e.target);
    };
    document.addEventListener('pointerdown', track, true);
    document.addEventListener('focusin', track, true);
    return () => {
      document.removeEventListener('pointerdown', track, true);
      document.removeEventListener('focusin', track, true);
    };
  }, []);
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}) });
  const workspaceDir = conversations.data?.find((c) => c.id === conversationId)?.workspaceDir ?? null;
  const origin = useWorkspaceOrigin(workspaceDir);
  const clock = useCreateClock();
  const [selection, setSelection] = useState<Selection>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exporter = useVideoExport({ conversationId, path, project: doc.project, flush: doc.flush });
  const checks = useEditorChecks(conversationId, path, doc.project);

  const project = doc.project;
  const duration = project ? projectDuration(project) : 0;
  useEffect(() => clock.setDuration(duration), [clock, duration]);
  // 离开剪辑器：停掉时钟的 rAF
  useEffect(() => () => clock.pause(), [clock]);

  // 选中片段的编辑操作（工具条按钮与快捷键共用）
  const { undo, redo, edit } = doc;
  const actions = {
    split: () => {
      const r = project ? splitSelectionAt(project, selection, clock.time()) : null;
      if (!r) return;
      edit(r.project);
      setSelection(r.selection);
    },
    duplicate: () => {
      const r = project ? duplicateSelection(project, selection) : null;
      if (!r) return;
      edit(r.project);
      setSelection(r.selection);
    },
    remove: () => {
      if (!project || !selection) return;
      edit(removeSelection(project, selection));
      setSelection(null);
    },
  };

  // 空格播放 / 暂停；⌘Z 撤销、⌘⇧Z 重做；S / ⌘B 分割、⌘D 复制、Delete / Backspace 删除
  // （焦点在输入框 / 弹窗里时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutsActive.current || isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.key === ' ' && !mod && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) clock.toggle();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((mod && key === 'b') || (!mod && !e.altKey && !e.shiftKey && key === 's')) {
        e.preventDefault();
        actions.split();
      } else if (mod && key === 'd') {
        e.preventDefault();
        actions.duplicate();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        actions.remove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** 撤销 agent 最近一轮修改：先把本地没写回的改动写掉（否则写回快照会撞成冲突） */
  const undoAgent = async () => {
    try {
      if (!(await doc.flush())) return;
      await checks.restoreAgentChanges();
    } catch (e) {
      toast.error(t('video.editor.agentUndoFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const exportBlocked = !project || project.video.length === 0
    ? t('video.export.empty')
    : doc.conflict
      ? t('video.export.conflict')
      : null;

  return (
    <FileViewerProvider conversationId={conversationId} workspaceDir={workspaceDir}>
      <section ref={sectionRef} className="flex h-full min-w-0 flex-col bg-background" data-testid="video-editor">
        <header className={cn('app-drag flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4', headerInset)}>
          <div className="flex min-w-0 items-center gap-2">
            {onBack && (
              <Button variant="ghost" size="sm" onClick={onBack}>
                <ArrowLeft />
                {t('video.editor.back')}
              </Button>
            )}
            <h1 className="truncate text-sm font-semibold tracking-tight" title={path}>
              {project?.name ?? path.split('/').pop()}
            </h1>
            {project && <SaveIndicator doc={doc} />}
          </div>
          {project && (
            <div className="flex shrink-0 items-center gap-1">
              {checks.agentRounds > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  title={t('video.editor.agentUndoHint', { count: checks.agentRounds })}
                  onClick={() => void undoAgent()}
                  data-testid="video-agent-undo"
                >
                  <Bot />
                  {t('video.editor.agentUndo')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('video.editor.undo')}
                title={t('video.editor.undo')}
                disabled={!doc.canUndo}
                onClick={doc.undo}
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('video.editor.redo')}
                title={t('video.editor.redo')}
                disabled={!doc.canRedo}
                onClick={doc.redo}
              >
                <Redo2 />
              </Button>
              <Button size="sm" className="ml-1" onClick={() => setExportOpen(true)}>
                <Clapperboard />
                {t('video.editor.export')}
              </Button>
              {headerExtra}
            </div>
          )}
          {!project && headerExtra}
        </header>

        {doc.conflict && <ConflictBanner kind={doc.conflict} onReload={doc.reload} onKeepMine={doc.keepMine} />}

        <div className="min-h-0 flex-1">
          {doc.phase === 'loading' && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('video.editor.loading')}
            </div>
          )}
          {doc.phase === 'error' && (
            <InvalidProject path={path} title={t('video.editor.loadFailed')} issues={doc.error ? [doc.error] : []} onRetry={doc.retry} />
          )}
          {doc.phase === 'invalid' && (
            <InvalidProject path={path} title={t('video.editor.invalidTitle')} issues={doc.issues} onRetry={doc.retry} />
          )}
          {doc.phase === 'ready' && project && (
            <EditorBody
              doc={doc}
              checks={checks}
              conversationId={conversationId}
              origin={origin}
              clock={clock}
              duration={duration}
              selection={selection}
              onSelect={setSelection}
              onSplit={actions.split}
              onDuplicate={actions.duplicate}
              onRemove={actions.remove}
            />
          )}
        </div>

        {project && (
          <ExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            exporter={exporter}
            canvas={project.canvas}
            workspaceDir={workspaceDir}
            origin={origin}
            disabledReason={exportBlocked}
            docSaving={doc.saveState === 'saving'}
          />
        )}
      </section>
    </FileViewerProvider>
  );
}

function EditorBody({
  doc,
  checks,
  conversationId,
  origin,
  clock,
  duration,
  selection,
  onSelect,
  onSplit,
  onDuplicate,
  onRemove,
}: {
  doc: VideoDocument;
  checks: EditorChecks;
  conversationId: string;
  origin: string | null;
  clock: PlaybackClock;
  duration: number;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const project = doc.project;
  // 播放头在选中片段内（离两边都不太近）才能分割；makeId 固定，只判断不生成
  const canSplit = useClockSelect(clock, (t) => !!project && splitSelectionAt(project, selection, t, () => 'probe') !== null);
  const { t } = useTranslation();
  if (!project) return null;
  /** 点问题（面板或时间线标记）：跳到问题开始处并选中涉及的片段 */
  const jump = (issue: EditorIssue) => {
    clock.seek(Math.min(duration, issue.start));
    if (issue.target) onSelect(issue.target);
  };
  const markers: TimelineMarker[] = [
    ...checks.rules.map((issue) => ({
      issue,
      stale: false,
      title: t(`video.issues.rule.${issue.issue.code}`, ruleParams(issue.issue)),
    })),
    ...checks.reviewEntries.map((issue) => ({ issue, stale: checks.reviewStale, title: issue.problem })),
  ];
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <PreviewPlayer project={project} origin={origin} clock={clock} />
        <PlaybackControls clock={clock} duration={duration} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MediaToolbar conversationId={conversationId} clock={clock} edit={doc.edit} onSelect={onSelect} />
          <EditActions
            canSplit={canSplit}
            hasSelection={selection !== null}
            onSplit={onSplit}
            onDuplicate={onDuplicate}
            onDelete={onRemove}
          />
        </div>
        <Timeline
          project={project}
          duration={duration}
          clock={clock}
          selection={selection}
          onSelect={onSelect}
          onCommit={(next) => doc.edit(next)}
          markers={markers}
          onJump={jump}
        />
      </div>
      <ScrollArea className="w-72 shrink-0 border-l">
        <div className="px-4 pt-4">
          <IssuesPanel checks={checks} onJump={jump} />
          <Separator className="mt-4" />
        </div>
        <Inspector project={project} duration={duration} selection={selection} onSelect={onSelect} edit={doc.edit} />
      </ScrollArea>
    </div>
  );
}

function SaveIndicator({ doc }: { doc: VideoDocument }) {
  const { t } = useTranslation();
  if (doc.saveError) {
    return (
      <span className="truncate text-xs text-destructive" title={doc.saveError}>
        {t('video.editor.save.failed', { message: doc.saveError })}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" data-testid="video-save-state">
      {doc.saveState === 'saving' ? (
        <Loader2 className="size-3 animate-spin" />
      ) : doc.saveState === 'saved' ? (
        <Check className="size-3" />
      ) : null}
      {t(`video.editor.save.${doc.saveState}`)}
    </span>
  );
}
