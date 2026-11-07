/**
 * 对话里的剪辑工程卡片：create_video_project 成功后在工具 chip 之后出现（同网页预览卡片），
 * 显示工程名、时长、各轨数量与提示数；「打开剪辑器」切到剪辑器视图（不自动打开）。
 */
import { Clapperboard, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useOpenVideoEditor } from '../open-editor-context';
import { formatTime } from '../lib/timeline';
import type { VideoProjectCardInfo } from '../lib/tool-result';

export function VideoProjectCard({ conversationId, info }: { conversationId: string; info: VideoProjectCardInfo }) {
  const { t } = useTranslation();
  const open = useOpenVideoEditor();
  const stats = [
    formatTime(info.duration),
    t('video.card.videoClips', { count: info.videoClips }),
    t('video.card.audioClips', { count: info.audioClips }),
    t('video.card.subtitles', { count: info.subtitles }),
  ];
  return (
    <div className="flex max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5" data-testid="video-project-card">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Clapperboard className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{info.name}</p>
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          {stats.join(' · ')}
          {info.warnings.length > 0 && (
            <span className="text-warning"> · {t('video.card.warnings', { count: info.warnings.length })}</span>
          )}
        </p>
      </div>
      {open && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          title={info.path}
          onClick={() => open({ conversationId, path: info.path })}
        >
          <SquarePen />
          {t('video.card.open')}
        </Button>
      )}
    </div>
  );
}
