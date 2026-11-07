/** 时间线上方的工具条：添加视频 / 图片、添加音频（本机文件 → 复制进工作区 media/imports/）、在播放头处添加字幕 */
import type { VideoProject } from '@agent-test/video-schema';
import { Captions, ImagePlus, Loader2, Music } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { agent } from '@/lib/agent-client';
import type { PlaybackClock } from '../hooks/use-clock';
import { addCueAt, addImportedMedia, isImportable, type Selection } from '../lib/edit';

/** video.importFiles 一次最多 20 个 */
const IMPORT_MAX = 20;

export function MediaToolbar({
  conversationId,
  clock,
  edit,
  onSelect,
}: {
  conversationId: string;
  clock: PlaybackClock;
  edit: (project: (present: VideoProject) => VideoProject) => void;
  onSelect: (sel: Selection) => void;
}) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState<'visual' | 'audio' | null>(null);

  const importMedia = async (target: 'visual' | 'audio') => {
    const files = await window.desktop.pickFiles();
    if (files.length === 0) return;
    setImporting(target);
    try {
      const probes = await agent.call('video.importFiles', { conversationId, sourcePaths: files.slice(0, IMPORT_MAX) });
      const skipped = probes.filter((p) => !isImportable(p, target)).length;
      if (skipped < probes.length) edit((present) => addImportedMedia(present, probes, target).project);
      if (skipped > 0) toast.warning(t('video.import.skipped', { count: skipped }));
    } catch (e) {
      toast.error(t('video.import.failed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImporting(null);
    }
  };

  const addCue = () => {
    const at = clock.time();
    const text = t('video.inspector.newCueText');
    // id 在外面生成：reducer 在 StrictMode 下会跑两次，两次要得到同一个 id
    const id = `cue-${crypto.randomUUID().slice(0, 8)}`;
    edit((present) => addCueAt(present, at, text, id).project);
    onSelect({ kind: 'cue', id });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="sm" disabled={importing !== null} onClick={() => void importMedia('visual')}>
        {importing === 'visual' ? <Loader2 className="animate-spin" /> : <ImagePlus />}
        {t('video.import.media')}
      </Button>
      <Button variant="outline" size="sm" disabled={importing !== null} onClick={() => void importMedia('audio')}>
        {importing === 'audio' ? <Loader2 className="animate-spin" /> : <Music />}
        {t('video.import.audio')}
      </Button>
      <Button variant="outline" size="sm" onClick={addCue}>
        <Captions />
        {t('video.inspector.addCue')}
      </Button>
    </div>
  );
}
