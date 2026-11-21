/** 侧栏里的网页预览（agent 的 preview_page、本机服务链接、工作区 .html）：顶栏 + iframe */
import { ExternalLink, FolderOpen, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { portUrl, SiteBody } from '../viewer/file-viewer';
import { type PreviewSpec, previewLocation } from '../viewer/preview-target';

export function SitePane({
  spec,
  workspaceDir,
  controls,
  headerInset,
}: {
  spec: PreviewSpec;
  workspaceDir: string | null;
  /** 展开全部且左侧会话栏收起时，顶栏左侧给侧栏开关 / 红绿灯让位 */
  headerInset?: string;
  /** 展开 / 关闭按钮（侧栏容器给） */
  controls: ReactNode;
}) {
  const { t } = useTranslation();
  // 「刷新」：换 key 让 iframe 重新加载（spark-preview 响应 no-store，拿到的是最新文件）
  const [reloadKey, setReloadKey] = useState(0);
  const external = spec.kind === 'port' ? portUrl(spec) : null;
  const absPath = spec.kind === 'file' && workspaceDir ? `${workspaceDir.replace(/\/+$/, '')}/${spec.path}` : null;
  return (
    <section className="flex h-full min-w-0 flex-col bg-background" data-testid="site-pane">
      <header className={cn('app-drag flex h-12 shrink-0 items-center gap-1 border-b border-border px-3', headerInset)}>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={previewLocation(spec)}>
          {spec.title}
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{previewLocation(spec)}</span>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <RotateCw />
        </Button>
        {external && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.openInBrowser')}
            title={t('common.openInBrowser')}
            onClick={() => void window.desktop.openExternal(external)}
          >
            <ExternalLink />
          </Button>
        )}
        {absPath && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.showInFinder')}
            title={t('common.showInFinder')}
            onClick={() => void window.desktop.showInFolder(absPath)}
          >
            <FolderOpen />
          </Button>
        )}
        {controls}
      </header>
      <div className="flex min-h-0 flex-1 p-2">
        <SiteBody key={reloadKey} spec={spec} workspaceDir={workspaceDir} />
      </div>
    </section>
  );
}
