/**
 * 设置 → 工作区：新对话默认使用的目录（每个对话开始前也能在输入框下方另选目录与权限）。
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useSettings } from './use-settings';

export function WorkspaceSection() {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const s = settings.data;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('settings.workspace.defaultDir')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.workspace.defaultDirHint')}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs" data-testid="workspace-dir">
          {s?.workspaceDir}
        </code>
        <Button
          variant="outline"
          onClick={() =>
            void window.desktop.pickFolder().then((dir) => {
              if (dir) update.mutate({ workspaceDir: dir });
            })
          }
        >
          {t('settings.workspace.change')}
        </Button>
        <Button variant="ghost" onClick={() => s && void window.desktop.showInFolder(s.workspaceDir)}>
          {t('settings.workspace.open')}
        </Button>
      </div>
    </section>
  );
}
