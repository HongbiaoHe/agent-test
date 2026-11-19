/**
 * 一个连接下的模型列表：搜索拉到的列表 → 勾选启用（可一键启用筛选结果）；新出现的标「新」、没再拉到的标「已下架」
 * （可移除）；手动添加模型 id；逐个 / 批量测试（会消耗少量 token）；逐个改能力。
 * 列表可能有上百项（OpenRouter）：外层 Sheet 用原生滚动，搜索框吸顶。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { agent } from '@/lib/agent-client';
import type { LlmModelView } from '../../../../../shared/llm';
import { connectionModelsKey, LLM_QUERY_KEY } from '../api';
import { filterModels } from '../model-options';
import { CapabilitiesDialog } from './capabilities-dialog';
import { ModelTestResultLine } from './model-test-result';

export function ModelList({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = connectionModelsKey(connectionId);
  const models = useQuery({ queryKey: key, queryFn: () => agent.call('llm.models.list', { connectionId }) });
  const [query, setQuery] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [manualId, setManualId] = useState('');
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [capsOf, setCapsOf] = useState<LlmModelView | null>(null);

  const all = models.data ?? [];
  const filtered = filterModels(enabledOnly ? all.filter((m) => m.enabled) : all, query);
  const enabledCount = all.filter((m) => m.enabled).length;
  const filteredDisabled = filtered.filter((m) => !m.enabled);

  /** 本地先改（勾选即时反馈），host 广播 llm-changed 后再整体刷新 */
  const patchLocal = (modelIds: readonly string[], patch: Partial<LlmModelView>) =>
    qc.setQueryData<LlmModelView[]>(key, (cur) =>
      cur?.map((m) => (modelIds.includes(m.modelId) ? { ...m, ...patch } : m)),
    );

  const setEnabled = useMutation({
    mutationFn: (p: { modelIds: string[]; enabled: boolean }) =>
      agent.call('llm.models.setEnabled', { connectionId, ...p }),
    onMutate: (p) => patchLocal(p.modelIds, { enabled: p.enabled }),
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY }),
  });
  const add = useMutation({
    mutationFn: (modelId: string) => agent.call('llm.models.add', { connectionId, modelId }),
    onSuccess: () => {
      setManualId('');
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (modelId: string) => agent.call('llm.models.remove', { connectionId, modelId }),
    onError: (e) => toast.error(e.message),
    onSettled: () => void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY }),
  });

  /** 测一个模型：结果直接写回列表缓存（host 也存了，下次拉列表一样） */
  async function testOne(modelId: string): Promise<void> {
    setTesting((cur) => new Set(cur).add(modelId));
    try {
      const updated = await agent.call('llm.models.test', { connectionId, modelId });
      qc.setQueryData<LlmModelView[]>(key, (cur) => cur?.map((m) => (m.modelId === modelId ? updated : m)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting((cur) => {
        const next = new Set(cur);
        next.delete(modelId);
        return next;
      });
    }
  }

  /** 批量测已启用的：逐个跑（并发会撞服务商的限流） */
  async function testEnabled(): Promise<void> {
    const ids = all.filter((m) => m.enabled).map((m) => m.modelId);
    setBatch({ done: 0, total: ids.length });
    for (const [i, id] of ids.entries()) {
      await testOne(id);
      setBatch({ done: i + 1, total: ids.length });
    }
    setBatch(null);
  }

  if (models.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (models.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {models.error.message}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* 吸顶：长列表滚动时搜索与批量操作始终可见 */}
      <div className="sticky top-0 z-10 -mx-4 space-y-2 bg-popover px-4 pt-1 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.models.list.searchPlaceholder')}
            aria-label={t('settings.models.list.search')}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <span data-testid="model-summary">
            {t('settings.models.list.summary', { enabled: enabledCount, total: all.length })}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5">
            <Switch size="sm" checked={enabledOnly} onCheckedChange={setEnabledOnly} />
            {t('settings.models.list.enabledOnly')}
          </label>
          <div className="ml-auto flex gap-1.5">
            {query.trim() !== '' && filteredDisabled.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                disabled={setEnabled.isPending}
                onClick={() => setEnabled.mutate({ modelIds: filteredDisabled.map((m) => m.modelId), enabled: true })}
              >
                {t('settings.models.list.enableFiltered', { n: filteredDisabled.length })}
              </Button>
            )}
            <Button size="xs" variant="outline" disabled={enabledCount === 0 || batch !== null} onClick={() => void testEnabled()}>
              {batch ? <Loader2 className="animate-spin" /> : <FlaskConical />}
              {batch
                ? t('settings.models.list.testingProgress', { done: batch.done, total: batch.total })
                : t('settings.models.list.testEnabled')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.models.list.testHint')}</p>
      </div>

      {all.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t('settings.models.list.noModels')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('settings.models.list.noMatch')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label={t('settings.models.list.title')}>
          {filtered.map((m) => (
            <ModelRow
              key={m.modelId}
              model={m}
              testing={testing.has(m.modelId)}
              onToggle={(enabled) => setEnabled.mutate({ modelIds: [m.modelId], enabled })}
              onTest={() => void testOne(m.modelId)}
              onEditCapabilities={() => setCapsOf(m)}
              onRemove={() => remove.mutate(m.modelId)}
            />
          ))}
        </ul>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (manualId.trim()) add.mutate(manualId.trim());
        }}
      >
        <span className="text-sm font-medium">{t('settings.models.list.addManual')}</span>
        <div className="flex gap-2">
          <Input
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder={t('settings.models.list.addManualPlaceholder')}
            aria-label={t('settings.models.list.addManual')}
            maxLength={200}
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={!manualId.trim() || add.isPending}>
            {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {t('settings.models.list.add')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.models.list.addManualHint')}</p>
        {add.isError && (
          <p className="text-sm text-destructive" role="alert">
            {add.error.message}
          </p>
        )}
      </form>

      <CapabilitiesDialog model={capsOf} onClose={() => setCapsOf(null)} />
    </div>
  );
}

function ModelRow({
  model: m,
  testing,
  onToggle,
  onTest,
  onEditCapabilities,
  onRemove,
}: {
  model: LlmModelView;
  testing: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEditCapabilities: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  // 已下架 / 手动添加的可以移除（拉到的模型移除后下次刷新又会回来）
  const removable = m.listState === 'missing' || m.source === 'manual';
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-testid="model-row" data-model-id={m.modelId}>
      <Checkbox
        className="mt-0.5"
        checked={m.enabled}
        onCheckedChange={(on) => onToggle(on === true)}
        aria-label={t('settings.models.list.enable', { model: m.modelId })}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-sm" title={m.modelId}>
            {m.modelId}
          </span>
          {m.listState === 'new' && <Badge variant="secondary">{t('settings.models.list.new')}</Badge>}
          {m.listState === 'missing' && <Badge variant="destructive">{t('settings.models.list.missing')}</Badge>}
          {m.source === 'manual' && <Badge variant="outline">{t('settings.models.list.manual')}</Badge>}
        </div>
        {m.displayName && m.displayName !== m.modelId && (
          <p className="truncate text-xs text-muted-foreground">{m.displayName}</p>
        )}
        {m.test && <ModelTestResultLine test={m.test} />}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={testing}
          onClick={onTest}
          aria-label={t('settings.models.list.testModel', { model: m.modelId })}
        >
          {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}
          {t('settings.models.list.test')}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={onEditCapabilities}
                aria-label={t('settings.models.list.editCapabilities', { model: m.modelId })}
              />
            }
          >
            <SlidersHorizontal />
          </TooltipTrigger>
          <TooltipContent>{t('settings.models.list.capabilities')}</TooltipContent>
        </Tooltip>
        {removable && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={onRemove}
                  aria-label={t('settings.models.list.remove', { model: m.modelId })}
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipContent>{t('settings.models.list.remove', { model: m.modelId })}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </li>
  );
}
