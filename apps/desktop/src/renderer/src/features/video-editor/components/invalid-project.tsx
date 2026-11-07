/** 工程打不开（读失败 / 校验不过）：列出原因，给「用文件预览打开原文」与重试，不白屏 */
import { FileText, FileWarning, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFileViewer } from '@/features/viewer/viewer-context';

export function InvalidProject({
  path,
  title,
  issues,
  onRetry,
}: {
  path: string;
  title: string;
  issues: string[];
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const viewer = useFileViewer();
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="video-invalid">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <FileWarning className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="truncate font-mono text-xs text-muted-foreground" title={path}>
              {path}
            </p>
            {issues.length > 0 && <p className="text-sm text-muted-foreground">{t('video.editor.invalidDescription')}</p>}
          </div>
        </div>
        {issues.length > 0 && (
          <ScrollArea className="max-h-60 rounded-md border bg-muted/40">
            <ul className="space-y-1 p-3 font-mono text-xs">
              {issues.map((issue, i) => (
                <li key={i} className="break-words">
                  {issue}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
        <div className="flex flex-wrap gap-2">
          {viewer && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => viewer.show({ source: 'workspace', path, name: path.split('/').pop() ?? path })}
            >
              <FileText />
              {t('video.editor.openRaw')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw />
            {t('common.retry')}
          </Button>
        </div>
      </div>
    </div>
  );
}
