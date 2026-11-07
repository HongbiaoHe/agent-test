/**
 * 剪辑器视图（占满主区，侧栏保留）：顶栏「返回对话」+ 保存状态 + 撤销重做 + 导出；
 * 左侧预览播放器 / 播放控件 / 工具条 / 时间线，右侧检查器。工程读写与冲突见 hooks/use-video-document.ts。
 */
import { projectDuration } from '@agent-test/video-schema';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Clapperboard, Loader2, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditActions } from './components/edit-actions';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { FileViewerProvider } from '../viewer/file-viewer';
import { ConflictBanner } from './components/conflict-banner';
import { ExportDialog } from './components/export-dialog';
import { Inspector } from './components/inspector';
import { InvalidProject } from './components/invalid-project';
import { MediaToolbar } from './components/media-toolbar';
import { PlaybackControls } from './components/playback-controls';
import { PreviewPlayer } from './components/preview-player';
import { Timeline } from './components/timeline';
import { type PlaybackClock, useClockSelect, useCreateClock } from './hooks/use-clock';
import { useVideoDocument, type VideoDocument } from './hooks/use-video-document';
import { useVideoExport } from './hooks/use-video-export';
import { useWorkspaceOrigin } from './hooks/use-workspace-origin';
import { removeSelection, type Selection } from './lib/edit';
import { isTypingTarget } from './lib/keyboard';
import { duplicateSelection, splitSelectionAt } from './lib/timeline-edit';

export function VideoEditorView({
  conversationId,
  path,
  headerInset,
  onBack,
}: {
  conversationId: string;
  path: string;
  /** 侧栏收起时顶栏左侧让出红绿灯与侧栏开关 */
  headerInset?: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const doc = useVideoDocument(conversationId, path);
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}) });
  const workspaceDir = conversations.data?.find((c) => c.id === conversationId)?.workspaceDir ?? null;
  const origin = useWorkspaceOrigin(workspaceDir);
  const clock = useCreateClock();
  const [selection, setSelection] = useState<Selection>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exporter = useVideoExport({ conversationId, path, project: doc.project, flush: doc.flush });

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
      if (isTypingTarget(e.target)) return;
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

  const exportBlocked = !project || project.video.length === 0
    ? t('video.export.empty')
    : doc.conflict
      ? t('video.export.conflict')
      : null;

  return (
    <FileViewerProvider conversationId={conversationId} workspaceDir={workspaceDir}>
      <section className="flex h-full min-w-0 flex-col bg-background" data-testid="video-editor">
        <header className={cn('app-drag flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4', headerInset)}>
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft />
              {t('video.editor.back')}
            </Button>
            <h1 className="truncate text-sm font-semibold tracking-tight" title={path}>
              {project?.name ?? path.split('/').pop()}
            </h1>
            {project && <SaveIndicator doc={doc} />}
          </div>
          {project && (
            <div className="flex shrink-0 items-center gap-1">
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
            </div>
          )}
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
  if (!project) return null;
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
        />
      </div>
      <ScrollArea className="w-72 shrink-0 border-l">
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
