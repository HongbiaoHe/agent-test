/** 时间线工具条右侧的编辑操作：在播放头处分割 / 复制 / 删除选中片段（快捷键见剪辑器视图） */
import { Copy, Scissors, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function EditActions({
  canSplit,
  hasSelection,
  onSplit,
  onDuplicate,
  onDelete,
}: {
  canSplit: boolean;
  hasSelection: boolean;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1" data-testid="video-edit-actions">
      <Button variant="ghost" size="sm" disabled={!canSplit} onClick={onSplit} title={t('video.edit.splitHint')}>
        <Scissors />
        {t('video.edit.split')}
      </Button>
      <Button variant="ghost" size="sm" disabled={!hasSelection} onClick={onDuplicate} title={t('video.edit.duplicateHint')}>
        <Copy />
        {t('video.edit.duplicate')}
      </Button>
      <Button variant="ghost" size="sm" disabled={!hasSelection} onClick={onDelete} title={t('video.edit.deleteHint')}>
        <Trash2 />
        {t('video.edit.delete')}
      </Button>
    </div>
  );
}
