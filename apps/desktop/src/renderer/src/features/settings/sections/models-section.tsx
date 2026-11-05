/**
 * 设置 → 模型：各提供方的 Key（系统钥匙串加密保存）+ 新对话的默认模型。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ProviderKey } from '../../../../../shared/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { agent } from '@/lib/agent-client';
import { useSettings } from './use-settings';

const PROVIDERS: { key: ProviderKey; label: string; hint: string }[] = [
  { key: 'google', label: 'Google Gemini', hint: 'aistudio.google.com 申请的 API Key' },
  { key: 'deepseek', label: 'DeepSeek', hint: 'platform.deepseek.com 申请的 API Key' },
];

function KeyRow({ provider, configured }: { provider: (typeof PROVIDERS)[number]; configured: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: (v: string | null) => window.desktop.setKey(provider.key, v),
    onSuccess: () => {
      setValue('');
      void qc.invalidateQueries({ queryKey: ['keys'] });
      toast.success(`${provider.label} Key 已更新`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{provider.label}</span>
        <span className={configured ? 'text-xs text-success' : 'text-xs text-muted-foreground'}>
          {configured ? '已配置' : '未配置'}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={configured ? '输入新 Key 以替换' : provider.hint}
          aria-label={`${provider.label} API Key`}
          autoComplete="off"
        />
        <Button disabled={!value.trim() || save.isPending} onClick={() => save.mutate(value)}>
          保存
        </Button>
        {configured && (
          <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
            清除
          </Button>
        )}
      </div>
    </div>
  );
}

export function ModelsSection() {
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => window.desktop.getKeyStatus() });
  const models = useQuery({ queryKey: ['models'], queryFn: () => agent.call('models.list', {}) });
  const { settings, update } = useSettings();
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">模型 Key</h3>
        {PROVIDERS.map((p) => (
          <KeyRow key={p.key} provider={p} configured={!!keys.data?.[p.key]} />
        ))}
      </section>
      <Separator />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">默认模型</h3>
        <p className="text-xs text-muted-foreground">新对话使用的模型，在输入框下方可以按对话单独切换。</p>
        <Select
          items={Object.fromEntries((models.data ?? []).map((m) => [m.id, m.label]))}
          value={settings.data?.defaultModel ?? ''}
          onValueChange={(v) => {
            if (typeof v === 'string' && v) update.mutate({ defaultModel: v });
          }}
        >
          <SelectTrigger aria-label="默认模型" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(models.data ?? []).map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
    </div>
  );
}
