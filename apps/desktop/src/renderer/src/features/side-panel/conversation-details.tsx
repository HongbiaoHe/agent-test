/**
 * 会话详情（对话顶栏的列表图标，弹出层）：环境（工作区、模型、模式、权限）、用量、产出物入口、时间。
 * 点「产出物」在右侧侧栏打开启动页（side-panel-launcher.tsx）。
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Cpu, Folder, FolderOpen, Gauge, Layers, List, Shield, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { listModes, MODES_QUERY_KEY } from '@/lib/api';
import { formatTokensCompact } from '@/lib/format-tokens';
import { currentLocale } from '@/lib/i18n';
import type { ConversationSummary } from '../../../../shared/rpc';
import type { ConversationOutputs } from '../chat/lib/conversation-outputs';
import { useModelOptions } from '../llm/api';
import { modelIdOfRef } from '../llm/model-options';
import { outputCount } from './side-panel-launcher';

export function ConversationDetails({
  conversation,
  tokens,
  outputs,
  onOpenOutputs,
}: {
  conversation: ConversationSummary | null | undefined;
  tokens: number;
  outputs: ConversationOutputs;
  /** 在右侧侧栏打开产出物启动页 */
  onOpenOutputs: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const locale = currentLocale();
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const models = useModelOptions();
  const modes = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });
  const modelRef = conversation?.model ?? null;
  const modelOption = modelRef ? models.data?.find((m) => m.ref === modelRef) : undefined;
  const modelLabel = modelRef ? (modelOption?.displayName ?? modelIdOfRef(modelRef)) : t('chat.info.defaultModel');
  const modeId = conversation?.modeId ?? null;
  const modeLabel = modeId ? (modes.data?.find((m) => m.id === modeId)?.name ?? modeId) : t('chat.mode.general');
  const count = outputCount(conversation, outputs);
  const dir = conversation?.workspaceDir ?? '';
  const slash = dir.replace(/\/+$/, '').lastIndexOf('/');
  const folderName = slash >= 0 ? dir.slice(slash + 1).replace(/\/+$/, '') : dir;
  // 上级目录：主目录写成 ~（/Users/<名字> → ~），其余原样
  const parent = slash > 0 ? dir.slice(0, slash).replace(/^\/Users\/[^/]+/, '~') : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.info.open')}
            title={t('chat.info.open')}
            aria-pressed={open}
            data-testid="conversation-info-toggle"
          />
        }
      >
        <List />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5" data-testid="conversation-info">
        <SectionLabel>{t('chat.info.environment')}</SectionLabel>
        {conversation && (
          <Row icon={<Folder />} title={dir}>
            <span className="min-w-0 flex-1 truncate">
              {folderName}
              {parent && <span className="text-muted-foreground"> · {parent}</span>}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('common.showInFinder')}
              title={t('common.showInFinder')}
              onClick={() => void window.desktop.showInFolder(dir)}
            >
              <FolderOpen />
            </Button>
          </Row>
        )}
        <Row icon={<Cpu />} title={t('chat.info.model')}>
          <span className="min-w-0 flex-1 truncate">{modelLabel}</span>
        </Row>
        <Row icon={<SlidersHorizontal />} title={t('chat.info.mode')}>
          <span className="min-w-0 flex-1 truncate">{modeLabel}</span>
        </Row>
        {conversation && (
          <Row icon={<Shield />} title={t('chat.info.permission')}>
            <span className="min-w-0 flex-1 truncate">{t(`chat.permission.label.${conversation.permission}`)}</span>
          </Row>
        )}
        <Separator className="my-1.5" />
        <Row icon={<Gauge />} title={t('chat.info.tokens')}>
          <span className="min-w-0 flex-1 truncate">{t('chat.info.tokens')}</span>
          <span
            className="shrink-0 text-muted-foreground tabular-nums"
            title={tokens.toLocaleString(locale)}
            data-testid="conversation-info-tokens"
          >
            {formatTokensCompact(tokens, locale)}
          </span>
        </Row>
        <button
          type="button"
          className="flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
          onClick={() => {
            setOpen(false);
            onOpenOutputs();
          }}
          data-testid="conversation-info-outputs"
        >
          <Layers />
          <span className="min-w-0 flex-1 truncate">{t('chat.info.outputs')}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{t('chat.info.outputsCount', { count })}</span>
          <ChevronRight />
        </button>
        {conversation && (
          <>
            <Separator className="my-1.5" />
            <p className="px-2.5 py-1 text-xs text-muted-foreground">
              {t('chat.info.createdAt')} {dateFmt.format(conversation.createdAt)} · {t('chat.info.updatedAt')}{' '}
              {dateFmt.format(conversation.updatedAt)}
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{children}</p>;
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div
      title={title}
      className="flex h-9 items-center gap-3 rounded-md px-2.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {icon}
      {children}
    </div>
  );
}
