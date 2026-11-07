/** 播放控件：播放 / 暂停、当前时间 / 总时长、进度条拖动 seek（订阅时钟，只有这一行随每帧重渲染） */
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { type PlaybackClock, useClockPlaying, useClockTime } from '../hooks/use-clock';
import { formatTime } from '../lib/timeline';

export function PlaybackControls({ clock, duration }: { clock: PlaybackClock; duration: number }) {
  const { t } = useTranslation();
  const time = useClockTime(clock);
  const playing = useClockPlaying(clock);
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={playing ? t('video.player.pause') : t('video.player.play')}
        title={playing ? t('video.player.pause') : t('video.player.play')}
        disabled={duration <= 0}
        onClick={() => clock.toggle()}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums" data-testid="video-time">
        {formatTime(time)} / {formatTime(duration)}
      </span>
      <Slider
        aria-label={t('video.player.seek')}
        min={0}
        max={Math.max(duration, 0.001)}
        step={0.01}
        value={Math.min(time, duration)}
        disabled={duration <= 0}
        onValueChange={(v) => clock.seek(v)}
      />
    </div>
  );
}
