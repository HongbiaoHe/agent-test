/**
 * 设置 → 模型：账号默认模型 + API 连接列表（添加连接、点开管理：模型列表 / 测试 / 刷新 / Key / 删除）。
 * 连接与模型存在当前账号的 spark.db（agent-host）；Key 经 preload 交给 main 加密保存，不走 agent RPC。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { agent } from '@/lib/agent-client';
import type { LlmConnectionView } from '../../../../../shared/llm';
import { CONNECTIONS_KEY, LLM_QUERY_KEY, useHostStatus, useModelOptions } from '../../llm/api';
import { AddConnectionDialog } from '../../llm/components/add-connection-dialog';
import { ConnectionSheet } from '../../llm/components/connection-sheet';
import { ModelSelect } from '../../llm/components/model-select';
import { protocolKey } from '../../llm/model-options';

export function ModelsSection() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<{ id: string; initialError: string | null } | null>(null);
  const connections = useQuery({ queryKey: CONNECTIONS_KEY, queryFn: () => agent.call('llm.connections.list', {}) });

  return (
    <div className="space-y-6">
      <DefaultModel />
      <Separator />
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t('settings.models.connections')}</h3>
            <p className="text-xs text-muted-foreground">{t('settings.models.connectionsHint')}</p>
          </div>
          <Button className="shrink-0" onClick={() => setAdding(true)}>
            <Plus /> {t('settings.models.addConnection')}
          </Button>
        </div>
        {connections.isLoading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-18 w-full rounded-xl" />
            ))}
          </div>
        ) : connections.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {connections.error.message}
          </p>
        ) : (connections.data ?? []).length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Server className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t('settings.models.noConnections')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.models.noConnectionsHint')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {(connections.data ?? []).map((c) => (
              <ConnectionCard key={c.id} conn={c} onOpen={() => setDetail({ id: c.id, initialError: null })} />
            ))}
          </div>
        )}
      </section>

      <AddConnectionDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(conn, refreshError) => {
          setAdding(false);
          // 建好直接打开详情：勾选要用的模型；自动拉取失败的错误在那里内联展示
          setDetail({ id: conn.id, initialError: refreshError });
        }}
      />
      <ConnectionSheet
        connectionId={detail?.id ?? null}
        initialError={detail?.initialError ?? null}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}

/** 账号默认模型：从已启用的模型里选（按连接分组） */
function DefaultModel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useHostStatus();
  const options = useModelOptions();
  const set = useMutation({
    mutationFn: (ref: string | null) => agent.call('llm.defaultModel.set', { ref }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY }),
    onError: (e) => toast.error(e.message),
  });
  const list = options.data ?? [];
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('settings.models.defaultModel')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.models.defaultModelHint')}</p>
      {options.isSuccess && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.models.noEnabledModels')}</p>
      ) : (
        <ModelSelect
          value={status.data?.defaultModel ?? null}
          options={list}
          noneLabel={t('settings.models.defaultModelNone')}
          ariaLabel={t('settings.models.defaultModel')}
          disabled={set.isPending || !status.data}
          className="w-80 max-w-full"
          onChange={(ref) => set.mutate(ref)}
        />
      )}
    </section>
  );
}

function ConnectionCard({ conn, onOpen }: { conn: LlmConnectionView; onOpen: () => void }) {
  const { t } = useTranslation();
  const keyLabel = conn.keyConfigured
    ? t('settings.models.keyConfigured')
    : conn.keyRequired
      ? t('settings.models.keyMissing')
      : t('settings.models.keyNotRequired');
  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      role="button"
      tabIndex={0}
      aria-label={t('settings.models.openConnection', { name: conn.name })}
      data-testid="llm-connection-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <CardContent className="flex items-center gap-3 py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{conn.name}</span>
            <Badge variant="outline">{t(`settings.models.protocol.${protocolKey(conn.protocol)}`)}</Badge>
            <Badge variant={!conn.keyConfigured && conn.keyRequired ? 'destructive' : 'secondary'}>{keyLabel}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{conn.baseUrl}</span>
            {' · '}
            {t('settings.models.modelCount', { enabled: conn.enabledCount, total: conn.modelCount })}
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}
