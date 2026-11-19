/**
 * 添加 API 连接：选预设（填好协议 / Base URL / 名称）→ 可改名称与 Base URL → 填 Key（本地服务可不填）。
 * 保存：llm.connections.create → setConnectionKey（填了 Key 时；resolve 时 agent-host 已拿到新 Key）
 * → 自动 llm.models.refresh 一次。拉取失败不算保存失败：连接已建好，错误交给详情页内联展示。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { findPreset, type ProviderPreset } from '@agent-test/agent-core/providers/presets';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { agent } from '@/lib/agent-client';
import type { LlmConnectionView } from '../../../../../shared/llm';
import { LLM_QUERY_KEY } from '../api';
import { groupPresets, isHttpUrl, protocolKey } from '../model-options';
import { usePresetName } from './use-preset-name';

export function AddConnectionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** 建好了：refreshError 是自动拉取模型列表失败的原始错误（成功为 null） */
  onCreated: (connection: LlmConnectionView, refreshError: string | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {/* 每次打开重建表单（关闭时卸载），不在 effect 里清空状态 */}
        {open && <AddConnectionForm onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

type Phase = 'idle' | 'creating' | 'listing';

function AddConnectionForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connection: LlmConnectionView, refreshError: string | null) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const presetName = usePresetName();
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const groups = groupPresets();

  const urlValid = isHttpUrl(baseUrl);
  const keyOk = !preset?.keyRequired || apiKey.trim() !== '';
  const canSubmit = preset !== null && name.trim() !== '' && urlValid && keyOk && phase === 'idle';

  const create = useMutation({
    mutationFn: async (p: ProviderPreset) => {
      setPhase('creating');
      const conn = await agent.call('llm.connections.create', {
        name: name.trim(),
        protocol: p.protocol,
        baseUrl: baseUrl.trim(),
        presetId: p.id,
      });
      // 连接已建好：之后的失败都不再让用户重提（会建出重复的连接），交给详情页展示
      const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
      if (apiKey.trim()) {
        const keyError = await window.desktop.setConnectionKey(conn.id, apiKey.trim()).then(() => null, errorText);
        if (keyError) return { conn, refreshError: keyError };
      }
      setPhase('listing');
      const refreshError = await agent
        .call('llm.models.refresh', { connectionId: conn.id })
        .then(() => null, errorText);
      return { conn, refreshError };
    },
    onSuccess: ({ conn, refreshError }) => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      onCreated(conn, refreshError);
    },
    onError: () => setPhase('idle'),
  });

  const items = Object.fromEntries(groups.flatMap((g) => g.presets.map((p) => [p.id, presetName(p)])));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && preset) create.mutate(preset);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('settings.models.add.title')}</DialogTitle>
        <DialogDescription>{t('settings.models.add.description')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('settings.models.add.preset')}</span>
        <Select
          items={items}
          value={preset?.id ?? null}
          disabled={phase !== 'idle'}
          onValueChange={(v) => {
            const p = typeof v === 'string' ? findPreset(v) : null;
            if (!p) return;
            setPreset(p);
            setName(presetName(p));
            setBaseUrl(p.baseUrl);
          }}
        >
          <SelectTrigger aria-label={t('settings.models.add.preset')} className="w-full">
            <SelectValue placeholder={t('settings.models.add.presetPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.key}>
                <SelectLabel>{t(`settings.models.presetGroups.${g.key}`)}</SelectLabel>
                {g.presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {presetName(p)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {preset && (
          <p className="text-xs text-muted-foreground">
            {t('settings.models.add.protocol', { protocol: t(`settings.models.protocol.${protocolKey(preset.protocol)}`) })}
          </p>
        )}
      </div>

      {preset && (
        <>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('settings.models.add.name')}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={phase !== 'idle'} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('settings.models.add.baseUrl')}</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              inputMode="url"
              placeholder="https://"
              aria-invalid={baseUrl.trim() !== '' && !urlValid}
              disabled={phase !== 'idle'}
              className="font-mono"
            />
            {baseUrl.trim() !== '' && !urlValid && (
              <span className="block text-xs text-destructive">{t('settings.models.add.invalidUrl')}</span>
            )}
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">
              {preset.keyRequired ? t('settings.models.add.apiKey') : t('settings.models.add.apiKeyOptional')}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                preset.keyRequired
                  ? t('settings.models.add.apiKeyPlaceholder')
                  : t('settings.models.add.apiKeyOptionalPlaceholder')
              }
              autoComplete="off"
              disabled={phase !== 'idle'}
            />
          </label>
        </>
      )}

      {create.isError && (
        <p className="text-sm break-all text-destructive" role="alert">
          {create.error.message}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={phase !== 'idle'}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {phase !== 'idle' && <Loader2 className="animate-spin" />}
          {phase === 'creating'
            ? t('settings.models.add.creating')
            : phase === 'listing'
              ? t('settings.models.add.listing')
              : t('settings.models.add.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
