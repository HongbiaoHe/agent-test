/**
 * 设置 → 工作区：新对话默认使用的目录（每个对话开始前也能在输入框下方另选目录与权限）。
 */
import { Button } from '@/components/ui/button';
import { useSettings } from './use-settings';

export function WorkspaceSection() {
  const { settings, update } = useSettings();
  const s = settings.data;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">默认工作区</h3>
      <p className="text-xs text-muted-foreground">
        新对话默认在这个目录里读写文件、执行命令。每个对话开始前都可以另选目录，并单独设置权限（只读 / 询问 / 自动）。
      </p>
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
          更换…
        </Button>
        <Button variant="ghost" onClick={() => s && void window.desktop.showInFolder(s.workspaceDir)}>
          打开
        </Button>
      </div>
    </section>
  );
}
