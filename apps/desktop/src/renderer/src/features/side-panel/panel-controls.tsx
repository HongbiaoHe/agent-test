/** 侧栏内容顶栏右侧的通用按钮：展开全部 / 收起为侧栏、关闭 */
import { Maximize2, Minimize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function PanelControls({
  expanded,
  onToggleExpanded,
  onClose,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const expandLabel = expanded ? t('shell.sidePanel.collapse') : t('shell.sidePanel.expand');
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="icon-sm" aria-label={expandLabel} title={expandLabel} onClick={onToggleExpanded}>
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('shell.sidePanel.close')}
        title={t('shell.sidePanel.close')}
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  );
}
