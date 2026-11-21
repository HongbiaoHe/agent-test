/**
 * 会话信息（对话顶栏右上角的按钮打开，开在右侧侧栏）：本会话的基本信息 + 可预览的产出物
 * （网页预览、剪辑工程、画布、生成的媒体），点哪条就在侧栏里打开哪条（媒体滚到对话里的卡片）。
 */
import { useQuery } from '@tanstack/react-query';
import { AudioLines, Clapperboard, FolderOpen, Globe, Image as ImageIcon, Mic, Network, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { listModes, MODES_QUERY_KEY, type MediaType } from '@/lib/api';
import { formatTokensCompact } from '@/lib/format-tokens';
import { currentLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConversationSummary } from '../../../../shared/rpc';
import { useConversationMedia } from '../chat/components/media-card';
import type { ConversationOutputs } from '../chat/lib/conversation-outputs';
import { useModelOptions } from '../llm/api';
import { modelIdOfRef } from '../llm/model-options';
import { formatTime } from '../video-editor/lib/timeline';
import { type PreviewSpec, previewLocation } from '../viewer/preview-target';

const MEDIA_ICON: Record<MediaType, typeof ImageIcon> = { image: ImageIcon, video: Video, audio: AudioLines, voice: Mic };

export function ConversationInfoPane({
  conversation,
  tokens,
  outputs,
  controls,
  headerInset,
  onOpenSite,
  onOpenVideo,
  onOpenCanvas,
}: {
  conversation: ConversationSummary | null | undefined;
  tokens: number;
  outputs: ConversationOutputs;
  controls: ReactNode;
  headerInset?: string;
  onOpenSite: (spec: PreviewSpec) => void;
  onOpenVideo: (path: string) => void;
  onOpenCanvas: (canvasId: string) => void;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const models = useModelOptions();
  const modes = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });

  const modelRef = conversation?.model ?? null;
  const modelOption = modelRef ? models.data?.find((m) => m.ref === modelRef) : undefined;
  const modelLabel = modelRef ? (modelOption?.displayName ?? modelIdOfRef(modelRef)) : t('chat.info.defaultModel');
  const modeId = conversation?.modeId ?? null;
  const modeLabel = modeId ? (modes.data?.find((m) => m.id === modeId)?.name ?? modeId) : t('chat.mode.general');

  // 当前绑定的画布排第一（标上「当前」），对话里出现过的其它画布随后
  const boundId = conversation?.canvasId ?? null;
  const canvases = boundId
    ? [
        { canvasId: boundId, title: outputs.canvases.find((c) => c.canvasId === boundId)?.title ?? null },
        ...outputs.canvases.filter((c) => c.canvasId !== boundId),
      ]
    : outputs.canvases;
  const hasOutputs =
    outputs.sites.length + outputs.videos.length + canvases.length + outputs.media.length > 0;

  return (
    <section className="flex h-full min-w-0 flex-col bg-background" data-testid="conversation-info">
      <header className={cn('app-drag flex h-12 shrink-0 items-center gap-1 border-b border-border px-3', headerInset)}>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t('chat.info.title')}</h2>
        {controls}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4">
          <Section title={t('chat.info.basics')}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <Field label={t('chat.info.model')}>{modelLabel}</Field>
              <Field label={t('chat.info.mode')}>{modeLabel}</Field>
              {conversation && (
                <Field label={t('chat.info.permission')}>{t(`chat.permission.label.${conversation.permission}`)}</Field>
              )}
              <Field label={t('chat.info.tokens')}>
                <span className="tabular-nums" title={tokens.toLocaleString(locale)} data-testid="conversation-info-tokens">
                  {formatTokensCompact(tokens, locale)}
                </span>
              </Field>
              {conversation && (
                <>
                  <Field label={t('chat.info.createdAt')}>{dateFmt.format(conversation.createdAt)}</Field>
                  <Field label={t('chat.info.updatedAt')}>{dateFmt.format(conversation.updatedAt)}</Field>
                  <Field label={t('chat.info.workspace')}>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate font-mono text-xs" title={conversation.workspaceDir}>
                        {conversation.workspaceDir}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('common.showInFinder')}
                        title={t('common.showInFinder')}
                        onClick={() => void window.desktop.showInFolder(conversation.workspaceDir)}
                      >
                        <FolderOpen />
                      </Button>
                    </span>
                  </Field>
                </>
              )}
            </dl>
          </Section>

          <Section title={t('chat.info.outputs')}>
            {!hasOutputs && <p className="text-sm text-muted-foreground">{t('chat.info.empty')}</p>}
            {outputs.sites.length > 0 && (
              <OutputGroup title={t('chat.info.sites')}>
                {outputs.sites.map((spec) => (
                  <OutputRow
                    key={previewLocation(spec)}
                    icon={<Globe />}
                    title={spec.title}
                    meta={<span className="font-mono">{previewLocation(spec)}</span>}
                    onClick={() => onOpenSite(spec)}
                  />
                ))}
              </OutputGroup>
            )}
            {outputs.videos.length > 0 && (
              <OutputGroup title={t('chat.info.videos')}>
                {outputs.videos.map((v) => (
                  <OutputRow
                    key={v.path}
                    icon={<Clapperboard />}
                    title={v.name}
                    meta={t('chat.info.videoMeta', { duration: formatTime(v.duration), clips: v.videoClips })}
                    onClick={() => onOpenVideo(v.path)}
                  />
                ))}
              </OutputGroup>
            )}
            {canvases.length > 0 && (
              <OutputGroup title={t('chat.info.canvases')}>
                {canvases.map((c) => (
                  <OutputRow
                    key={c.canvasId}
                    icon={<Network />}
                    title={c.title || t('canvas.list.untitled')}
                    badge={c.canvasId === boundId ? t('chat.info.currentCanvas') : undefined}
                    onClick={() => onOpenCanvas(c.canvasId)}
                  />
                ))}
              </OutputGroup>
            )}
            {outputs.media.length > 0 && conversation && (
              <MediaOutputs conversationId={conversation.id} media={outputs.media} />
            )}
          </Section>
        </div>
      </ScrollArea>
    </section>
  );
}

/** 生成的媒体：一次调用一行（提示词 + 类型 / 数量），点了滚到对话里那张卡片 */
function MediaOutputs({ conversationId, media }: { conversationId: string; media: ConversationOutputs['media'] }) {
  const { t } = useTranslation();
  const { data } = useConversationMedia(conversationId);
  const locate = (itemId: string) =>
    document.querySelector(`[data-thread-item="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return (
    <OutputGroup title={t('chat.info.media')}>
      {media.map((m) => {
        const Icon = MEDIA_ICON[m.mediaType];
        const first = data?.find((g) => g.id === m.generationIds[0])?.versions[0];
        const type = t(`chat.media.type.${m.mediaType}`);
        return (
          <OutputRow
            key={m.itemId}
            icon={<Icon />}
            title={first?.prompt || t('chat.info.mediaPending')}
            meta={m.generationIds.length > 1 ? `${type} ×${m.generationIds.length}` : type}
            label={t('chat.info.locate')}
            onClick={() => locate(m.itemId)}
          />
        );
      })}
    </OutputGroup>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

function OutputGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="space-y-1" aria-label={title}>
        {children}
      </ul>
    </div>
  );
}

function OutputRow({
  icon,
  title,
  meta,
  badge,
  label,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  badge?: string;
  /** 悬停提示（缺省用标题） */
  label?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        title={label ?? title}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        onClick={onClick}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          {meta && <span className="block truncate text-xs text-muted-foreground tabular-nums">{meta}</span>}
        </span>
        {badge && (
          <Badge variant="secondary" className="shrink-0">
            {badge}
          </Badge>
        )}
      </button>
    </li>
  );
}
