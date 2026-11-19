/**
 * API 连接详情侧拉（同连接器详情的形态）：顶部操作（测试连接 / 刷新模型列表 / 删除），
 * 「模型」页签是可搜索、可勾选的模型列表，「连接设置」页签改名称 / Base URL（协议只读）、替换 / 清除 Key。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { agent } from '@/lib/agent-client';
import type { ConnectionTestResult, LlmConnectionView } from '../../../../../shared/llm';
import { formatFullDateTime } from '../../chat/lib/time';
import { CONNECTIONS_KEY, LLM_QUERY_KEY } from '../api';
import { isHttpUrl, protocolKey } from '../model-options';
import { ModelList } from './model-list';

export function ConnectionSheet({
  connectionId,
  initialError,
  onClose,
}: {
  connectionId: string | null;
  /** 新建后自动拉取模型列表失败的原始错误：内联展示，直到下一次刷新 */
  initialError: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => agent.call('llm.connections.list', {}),
    enabled: connectionId !== null,
  });
  const conn = connections.data?.find((c) => c.id === connectionId) ?? null;

  return (
    <Sheet open={connectionId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        data-testid="llm-connection-sheet"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 pr-8">
            <span className="truncate">{conn?.name ?? t('settings.models.detail.fallbackTitle')}</span>
            {conn && <Badge variant="outline">{t(`settings.models.protocol.${protocolKey(conn.protocol)}`)}</Badge>}
          </SheetTitle>
          {conn && <SheetDescription className="truncate text-left font-mono">{conn.baseUrl}</SheetDescription>}
        </SheetHeader>
        {/* 原生滚动：Sheet 内 ScrollArea 遇到不确定高度会退化（见项目记忆 dialog-maxh-breaks-scrollarea） */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {connections.isError && (
            <p className="py-4 text-sm text-destructive" role="alert">
              {connections.error.message}
            </p>
          )}
          {/* 换连接就重建（各种内联结果与输入都归零） */}
          {conn && <ConnectionDetail key={conn.id} conn={conn} initialError={initialError} onDeleted={onClose} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ConnectionDetail({
  conn,
  initialError,
  onDeleted,
}: {
  conn: LlmConnectionView;
  initialError: string | null;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });

  const test = useMutation({
    mutationFn: () => agent.call('llm.connections.test', { id: conn.id }),
    onMutate: () => setTestResult(null),
    onSuccess: setTestResult,
  });
  const refresh = useMutation({
    mutationFn: () => agent.call('llm.models.refresh', { connectionId: conn.id }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async () => {
      await agent.call('llm.connections.delete', { id: conn.id });
      // Key 存在 main（系统钥匙串）：连接删了 Key 也一起清掉
      await window.desktop.setConnectionKey(conn.id, null);
    },
    onSuccess: () => {
      invalidate();
      onDeleted();
    },
    onError: (e) => toast.error(e.message),
  });

  // 刷新过就以刷新结果为准；还没手动刷新时显示新建时自动拉取的错误
  const refreshError = refresh.isError ? refresh.error.message : refresh.isIdle ? initialError : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()} title={t('settings.models.detail.testHint')}>
          {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
          {t('settings.models.detail.test')}
        </Button>
        <Button variant="outline" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t('settings.models.detail.refresh')}
        </Button>
        <Button variant="destructive" size="sm" className="ml-auto" onClick={() => setConfirmDelete(true)}>
          <Trash2 /> {t('settings.models.detail.delete')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {conn.lastListedAt
          ? t('settings.models.detail.lastListed', { time: formatFullDateTime(Date.parse(conn.lastListedAt)) })
          : t('settings.models.detail.neverListed')}
      </p>

      {test.isError && (
        <p className="rounded-lg bg-destructive/10 p-3 text-sm break-all text-destructive" role="alert">
          {t('settings.models.detail.testFailed', { message: test.error.message })}
        </p>
      )}
      {testResult && (
        <p
          role="status"
          data-testid="connection-test-result"
          className={
            testResult.ok
              ? 'rounded-lg bg-muted p-3 text-sm text-success'
              : 'rounded-lg bg-destructive/10 p-3 text-sm break-all text-destructive'
          }
        >
          {testResult.ok
            ? t('settings.models.detail.testOk', { n: testResult.modelCount })
            : t('settings.models.detail.testFailed', { message: testResult.message ?? '' })}
        </p>
      )}
      {refreshError && (
        <p
          className="rounded-lg bg-destructive/10 p-3 text-sm break-all text-destructive"
          role="alert"
          data-testid="refresh-error"
        >
          {t('settings.models.detail.refreshFailed', { message: refreshError })}
        </p>
      )}

      {/* 同 detail-panel：主题里的 data-horizontal 变体对不上 base-ui 的 data-orientation，竖排显式给 */}
      <Tabs defaultValue="models" className="flex-col">
        <TabsList>
          <TabsTrigger value="models">{t('settings.models.list.title')}</TabsTrigger>
          <TabsTrigger value="settings">{t('settings.models.detail.settingsTab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="models" className="pt-2">
          <ModelList connectionId={conn.id} />
        </TabsContent>
        <TabsContent value="settings" className="space-y-5 pt-2">
          <ConnectionForm conn={conn} />
          <Separator />
          <KeyForm conn={conn} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.models.detail.deleteTitle', { name: conn.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.models.detail.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending && <Loader2 className="animate-spin" />}
              {t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 名称 / Base URL（协议只读：换协议 = 新建连接） */
function ConnectionForm({ conn }: { conn: LlmConnectionView }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(conn.name);
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl);
  const urlValid = isHttpUrl(baseUrl);
  const dirty = name.trim() !== conn.name || baseUrl.trim() !== conn.baseUrl;
  const save = useMutation({
    mutationFn: () =>
      agent.call('llm.connections.update', { id: conn.id, name: name.trim(), baseUrl: baseUrl.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      toast.success(t('settings.models.detail.saved'));
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && urlValid && name.trim()) save.mutate();
      }}
    >
      <p className="text-xs text-muted-foreground">
        {t('settings.models.add.protocol', { protocol: t(`settings.models.protocol.${protocolKey(conn.protocol)}`) })}
        {' · '}
        {t('settings.models.detail.protocolReadonly')}
      </p>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{t('settings.models.detail.name')}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">{t('settings.models.detail.baseUrl')}</span>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          inputMode="url"
          className="font-mono"
          aria-invalid={!urlValid}
        />
        {!urlValid && <span className="block text-xs text-destructive">{t('settings.models.add.invalidUrl')}</span>}
      </label>
      {save.isError && (
        <p className="text-sm break-all text-destructive" role="alert">
          {save.error.message}
        </p>
      )}
      <Button type="submit" size="sm" disabled={!dirty || !urlValid || !name.trim() || save.isPending}>
        {save.isPending && <Loader2 className="animate-spin" />}
        {t('settings.models.detail.saveEdit')}
      </Button>
    </form>
  );
}

/** Key：只经 preload 交给 main（系统钥匙串），不走 agent RPC；界面只知道「是否已配置」 */
function KeyForm({ conn }: { conn: LlmConnectionView }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: (v: string | null) => window.desktop.setConnectionKey(conn.id, v),
    onSuccess: (_keys, v) => {
      setValue('');
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      toast.success(v === null ? t('settings.models.detail.keyCleared') : t('settings.models.detail.keyUpdated'));
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate(value.trim());
      }}
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          {conn.keyRequired ? t('settings.models.add.apiKey') : t('settings.models.add.apiKeyOptional')}
        </span>
        <span className={conn.keyConfigured ? 'text-xs text-success' : 'text-xs text-muted-foreground'}>
          {conn.keyConfigured
            ? t('settings.models.keyConfigured')
            : conn.keyRequired
              ? t('settings.models.keyMissing')
              : t('settings.models.keyNotRequired')}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={conn.keyConfigured ? t('settings.models.detail.replaceKey') : t('settings.models.detail.keyPlaceholder')}
          aria-label={t('settings.models.detail.key')}
          autoComplete="off"
        />
        <Button type="submit" disabled={!value.trim() || save.isPending}>
          {t('settings.models.detail.saveKey')}
        </Button>
        {conn.keyConfigured && (
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {t('settings.models.detail.clearKey')}
          </Button>
        )}
      </div>
    </form>
  );
}
