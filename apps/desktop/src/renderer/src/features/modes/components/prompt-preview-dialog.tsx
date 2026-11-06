import { useTranslation } from 'react-i18next';

import type { Capability } from '@agent-test/agent-core/modes/capabilities';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ModePreview } from '@/lib/api';

const MISSING_PREFIX = 'missing_capability:';

// renderer 不能从 core 的 CJS dist 取值导出（Vite dev 不做命名导出互操作），能力列表在这里按类型重列；
// core 新增能力而这里没补时，预览只会退化成显示原始 id
const CAPABILITY_IDS = ['sandbox', 'workspace', 'workspace_write', 'media_api', 'email', 'background'] as const satisfies readonly Capability[];

function asCapability(v: string): Capability | null {
  return CAPABILITY_IDS.find((c) => c === v) ?? null;
}

/** 「预览提示词」结果：最终系统提示（<pre>）+ 本环境不可用的工具 / 连接器 / 技能清单 */
export function PromptPreviewDialog({ preview, onClose }: { preview: ModePreview | null; onClose: () => void }) {
  const { t } = useTranslation();
  const reasonOf = (reason: string): string => {
    if (reason.startsWith(MISSING_PREFIX)) {
      const cap = asCapability(reason.slice(MISSING_PREFIX.length));
      return t('settings.modes.preview.reason.missing_capability', {
        cap: cap ? t(`settings.modes.capability.${cap}`) : reason.slice(MISSING_PREFIX.length),
      });
    }
    if (reason === 'not_registered' || reason === 'not_found' || reason === 'not_installed') {
      return t(`settings.modes.preview.reason.${reason}`);
    }
    return reason;
  };
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(48rem,90vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{t('settings.modes.preview.title')}</DialogTitle>
          <DialogDescription>{t('settings.modes.preview.description')}</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('settings.modes.preview.unavailableTitle')}</h3>
              {preview.unavailable.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('settings.modes.preview.none')}</p>
              ) : (
                <ul className="space-y-1">
                  {preview.unavailable.map((u) => (
                    <li key={`${u.kind}:${u.name}`} className="flex items-center gap-2 text-sm">
                      <Badge variant="outline">{t(`settings.modes.preview.kind.${u.kind}`)}</Badge>
                      <code className="font-mono">{u.name}</code>
                      <span className="text-muted-foreground">{reasonOf(u.reason)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <pre className="rounded-lg border bg-card px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {preview.systemPrompt}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
