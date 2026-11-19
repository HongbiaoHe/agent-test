/** 模型测试结果：支持工具调用 / 只能对话 / 失败（带服务端原始错误）+ 测试时间与耗时 */
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ModelTestResult } from '../../../../../shared/llm';
import { formatFullDateTime } from '../../chat/lib/time';

export function ModelTestResultLine({ test, className }: { test: ModelTestResult; className?: string }) {
  const { t } = useTranslation();
  const meta = t('settings.models.test.testedAt', {
    time: formatFullDateTime(Date.parse(test.testedAt)),
    ms: test.latencyMs,
  });
  return (
    <div className={cn('space-y-0.5 text-xs', className)} data-testid="model-test-result" data-status={test.status}>
      <p
        className={cn(
          'flex items-center gap-1 font-medium',
          test.status === 'ok' && 'text-success',
          test.status === 'no_tools' && 'text-warning',
          test.status === 'error' && 'text-destructive',
        )}
      >
        {test.status === 'ok' && <CircleCheck className="size-3.5 shrink-0" />}
        {test.status === 'no_tools' && <TriangleAlert className="size-3.5 shrink-0" />}
        {test.status === 'error' && <CircleX className="size-3.5 shrink-0" />}
        {test.status === 'ok' && t('settings.models.test.ok')}
        {test.status === 'no_tools' && t('settings.models.test.noTools')}
        {test.status === 'error' && t('settings.models.test.error')}
        <span className="font-normal text-muted-foreground">· {meta}</span>
      </p>
      {test.message && (
        <p className="line-clamp-3 break-all text-muted-foreground" title={test.message}>
          {test.message}
        </p>
      )}
    </div>
  );
}
