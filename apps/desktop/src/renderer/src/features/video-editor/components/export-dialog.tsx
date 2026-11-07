/** 导出对话框：选分辨率 → 开始导出（先保存）→ 进度条（可取消）→ 输出路径 +「在访达中显示」/「预览」 */
import { AlertCircle, CheckCircle2, Clapperboard, FolderSearch, Loader2, Play, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useFileViewer } from '@/features/viewer/viewer-context';
import type { ExportResolution, VideoExport } from '../hooks/use-video-export';
import { mediaUrl } from '../lib/media-url';

const RESOLUTIONS: readonly ExportResolution[] = ['original', '1080', '720'];
const isResolution = (v: unknown): v is ExportResolution => RESOLUTIONS.some((r) => r === v);

export function ExportDialog({
  open,
  onOpenChange,
  exporter,
  canvas,
  workspaceDir,
  origin,
  disabledReason,
  docSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporter: VideoExport;
  canvas: { width: number; height: number };
  workspaceDir: string | null;
  origin: string | null;
  /** 不能导出的原因（视频轨为空 / 有冲突）；null = 可以导出 */
  disabledReason: string | null;
  /** 自动保存在途：等它写完再允许开始（导出前的保存要基于它写回后的 mtime） */
  docSaving: boolean;
}) {
  const { t } = useTranslation();
  const viewer = useFileViewer();
  const [resolution, setResolution] = useState<ExportResolution>('original');
  const { state } = exporter;
  const label: Record<ExportResolution, string> = {
    original: t('video.export.original', { width: canvas.width, height: canvas.height }),
    '1080': t('video.export.p1080'),
    '720': t('video.export.p720'),
  };
  const busy = state.phase === 'saving' || state.phase === 'running';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clapperboard className="size-4" />
            {t('video.export.title')}
          </DialogTitle>
          <DialogDescription>{t('video.export.description')}</DialogDescription>
        </DialogHeader>

        {(state.phase === 'idle' || state.phase === 'cancelled' || state.phase === 'failed') && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('video.export.resolution')}</p>
            <RadioGroup value={resolution} onValueChange={(v) => isResolution(v) && setResolution(v)}>
              {RESOLUTIONS.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value={r} />
                  {label[r]}
                </label>
              ))}
            </RadioGroup>
          </div>
        )}

        {state.phase === 'saving' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('video.export.saving')}
          </p>
        )}

        {state.phase === 'running' && (
          <div className="space-y-2" data-testid="video-export-progress">
            <p className="text-sm text-muted-foreground">
              {t('video.export.running', { percent: Math.round(state.progress * 100) })}
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(state.progress * 100)}%` }} />
            </div>
          </div>
        )}

        {state.phase === 'done' && (
          <Alert>
            <CheckCircle2 className="text-success" />
            <AlertTitle>{t('video.export.done')}</AlertTitle>
            <AlertDescription className="font-mono text-xs break-all">{state.outputPath}</AlertDescription>
          </Alert>
        )}
        {state.phase === 'failed' && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t('video.export.failed')}</AlertTitle>
            {state.error && <AlertDescription className="break-words whitespace-pre-wrap">{state.error}</AlertDescription>}
          </Alert>
        )}
        {state.phase === 'cancelled' && <p className="text-sm text-muted-foreground">{t('video.export.cancelled')}</p>}
        {disabledReason && !busy && state.phase !== 'done' && (
          <p className="text-sm text-muted-foreground">{disabledReason}</p>
        )}

        <DialogFooter>
          {state.phase === 'running' && (
            <Button variant="outline" onClick={exporter.cancel}>
              <X />
              {t('video.export.cancel')}
            </Button>
          )}
          {state.phase === 'done' && (
            <>
              <Button variant="outline" onClick={exporter.reset}>
                <RotateCcw />
                {t('video.export.again')}
              </Button>
              {workspaceDir && (
                <Button
                  variant="outline"
                  onClick={() => void window.desktop.showInFolder(`${workspaceDir.replace(/\/+$/, '')}/${state.outputPath}`)}
                >
                  <FolderSearch />
                  {t('common.showInFinder')}
                </Button>
              )}
              {viewer && origin && (
                <Button
                  onClick={() =>
                    viewer.show({
                      source: 'url',
                      url: mediaUrl(origin, state.outputPath),
                      kind: 'video',
                      name: state.outputPath.split('/').pop() ?? state.outputPath,
                    })
                  }
                >
                  <Play />
                  {t('video.export.preview')}
                </Button>
              )}
            </>
          )}
          {(state.phase === 'idle' || state.phase === 'cancelled' || state.phase === 'failed' || state.phase === 'saving') && (
            <Button disabled={busy || docSaving || disabledReason !== null} onClick={() => void exporter.start(resolution)}>
              {state.phase === 'saving' ? <Loader2 className="animate-spin" /> : <Clapperboard />}
              {t('video.export.start')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
