/**
 * 模型能力编辑：思考参数写法、可选的思考档位（只能在该写法支持的档位里勾）、上下文窗口；
 * OpenAI 推理模型另有「显示思考摘要」开关。
 * 保存后 host 标记「用户改过」，之后刷新模型列表不再覆盖。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { thinkingLevelsForStyle } from '@agent-test/agent-core/providers/capabilities';
import { THINKING_STYLES, type ThinkingStyle } from '@agent-test/agent-core/providers/types';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { agent } from '@/lib/agent-client';
import { thinkingLevelLabel, type ThinkingLevel } from '@/lib/thinking-level';
import type { LlmModelView } from '../../../../../shared/llm';
import { LLM_QUERY_KEY } from '../api';
import { thinkingStyleKey } from '../model-options';

function isThinkingStyle(v: string): v is ThinkingStyle {
  return THINKING_STYLES.some((s) => s === v);
}

export function CapabilitiesDialog({ model, onClose }: { model: LlmModelView | null; onClose: () => void }) {
  return (
    <Dialog open={model !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* 换一个模型就重建表单：初始值来自 props，不在 effect 里同步 */}
        {model && <CapabilitiesForm key={model.ref} model={model} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function CapabilitiesForm({ model, onClose }: { model: LlmModelView; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [style, setStyle] = useState<ThinkingStyle>(model.capabilities.thinkingStyle);
  const [levels, setLevels] = useState<ThinkingLevel[]>(model.capabilities.thinkingLevels);
  const [contextWindow, setContextWindow] = useState(
    model.capabilities.contextWindow === null ? '' : String(model.capabilities.contextWindow),
  );
  const [summary, setSummary] = useState(model.capabilities.reasoningSummary !== false);
  const allowed = thinkingLevelsForStyle(style, model.modelId);
  const ctx = contextWindow.trim();
  const ctxValue = ctx === '' ? null : Number(ctx);
  const ctxValid = ctxValue === null || (Number.isInteger(ctxValue) && ctxValue > 0);

  const save = useMutation({
    mutationFn: () =>
      agent.call('llm.models.updateCapabilities', {
        connectionId: model.connectionId,
        modelId: model.modelId,
        capabilities: {
          thinkingStyle: style,
          // 按该写法的展示顺序；auto 始终保留（不传思考参数）
          thinkingLevels: allowed.filter((l) => l === 'auto' || levels.includes(l)),
          contextWindow: ctxValue,
          ...(style === 'openai-effort' && !summary && { reasoningSummary: false }),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      toast.success(t('settings.models.capabilities.saved'));
      onClose();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ctxValid) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle className="break-all">{t('settings.models.capabilities.title', { model: model.modelId })}</DialogTitle>
        <DialogDescription>{t('settings.models.capabilities.description')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('settings.models.capabilities.thinkingStyle')}</span>
        <Select
          items={Object.fromEntries(
            THINKING_STYLES.map((s) => [s, t(`settings.models.capabilities.style.${thinkingStyleKey(s)}`)]),
          )}
          value={style}
          onValueChange={(v) => {
            if (typeof v !== 'string' || !isThinkingStyle(v)) return;
            setStyle(v);
            // 换写法：档位重置为该写法支持的全部
            setLevels(thinkingLevelsForStyle(v, model.modelId));
          }}
        >
          <SelectTrigger aria-label={t('settings.models.capabilities.thinkingStyle')} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THINKING_STYLES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`settings.models.capabilities.style.${thinkingStyleKey(s)}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('settings.models.capabilities.thinkingLevels')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {allowed.map((level) => (
            <label key={level} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={level === 'auto' || levels.includes(level)}
                disabled={level === 'auto' || save.isPending}
                onCheckedChange={(on) =>
                  setLevels((cur) => (on === true ? [...cur, level] : cur.filter((l) => l !== level)))
                }
              />
              {thinkingLevelLabel(level)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.models.capabilities.autoAlways')}</p>
      </fieldset>

      {style === 'openai-effort' && (
        <div className="space-y-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={summary}
              disabled={save.isPending}
              onCheckedChange={(on) => setSummary(on === true)}
            />
            {t('settings.models.capabilities.reasoningSummary')}
          </label>
          <p className="text-xs text-muted-foreground">{t('settings.models.capabilities.reasoningSummaryHint')}</p>
        </div>
      )}

      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{t('settings.models.capabilities.contextWindow')}</span>
        <Input
          inputMode="numeric"
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
          placeholder={t('settings.models.capabilities.contextWindowPlaceholder')}
          aria-invalid={!ctxValid}
          disabled={save.isPending}
        />
        <span className="block text-xs text-muted-foreground">{t('settings.models.capabilities.contextWindowHint')}</span>
      </label>

      {save.isError && (
        <p className="text-sm text-destructive" role="alert">
          {save.error.message}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!ctxValid || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
