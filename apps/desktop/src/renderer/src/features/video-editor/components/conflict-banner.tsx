/** 冲突提示条：外部修改撞上本地未写回的改动 / 写回时发现磁盘已改 →「重新加载」或「保留我的修改」 */
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function ConflictBanner({
  kind,
  onReload,
  onKeepMine,
}: {
  kind: 'external' | 'write';
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="video-conflict"
      className="flex shrink-0 items-center gap-3 border-b bg-warning/10 px-4 py-2 text-sm"
    >
      <TriangleAlert className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{t(`video.editor.conflict.${kind}`)}</span>
      <Button variant="outline" size="sm" onClick={onReload}>
        {t('video.editor.conflict.reload')}
      </Button>
      <Button size="sm" onClick={onKeepMine}>
        {t('video.editor.conflict.keepMine')}
      </Button>
    </div>
  );
}
