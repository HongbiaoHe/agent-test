/**
 * 右侧侧栏的新建标签页（标签栏的加号、或顶栏最右的侧栏开关在没有标签时打开）：
 * 居中列出本会话可预览的产出物（网页预览、剪辑工程、画布、生成的媒体），点哪条就在这个标签里打开哪条
 * （媒体滚到对话里的卡片）。会话本身的信息在顶栏的「会话详情」弹出层里（conversation-details.tsx）。
 */
import { AudioLines, Clapperboard, Globe, Image as ImageIcon, Mic, Network, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { MediaType } from '@/lib/api';
import type { ConversationSummary } from '../../../../shared/rpc';
import { useConversationMedia } from '../chat/components/media-card';
import type { ConversationOutputs } from '../chat/lib/conversation-outputs';
import { formatTime } from '../video-editor/lib/timeline';
import { type PreviewSpec, previewLocation } from '../viewer/preview-target';

const MEDIA_ICON: Record<MediaType, typeof ImageIcon> = { image: ImageIcon, video: Video, audio: AudioLines, voice: Mic };

/** 当前绑定的画布排第一（标上「当前」），对话里出现过的其它画布随后 */
export function orderedCanvases(conversation: ConversationSummary | null | undefined, outputs: ConversationOutputs) {
  const boundId = conversation?.canvasId ?? null;
  const list = boundId
    ? [
        { canvasId: boundId, title: outputs.canvases.find((c) => c.canvasId === boundId)?.title ?? null },
        ...outputs.canvases.filter((c) => c.canvasId !== boundId),
      ]
    : outputs.canvases;
  return { boundId, list };
}

/** 产出物条数（「会话详情」里显示，点了打开这个启动页） */
export function outputCount(conversation: ConversationSummary | null | undefined, outputs: ConversationOutputs): number {
  return outputs.sites.length + outputs.videos.length + orderedCanvases(conversation, outputs).list.length + outputs.media.length;
}

export function SidePanelLauncher({
  conversation,
  outputs,
  onOpenSite,
  onOpenVideo,
  onOpenCanvas,
}: {
  conversation: ConversationSummary | null | undefined;
  outputs: ConversationOutputs;
  onOpenSite: (spec: PreviewSpec) => void;
  onOpenVideo: (path: string) => void;
  onOpenCanvas: (canvasId: string) => void;
}) {
  const { t } = useTranslation();
  const { boundId, list: canvases } = orderedCanvases(conversation, outputs);
  const empty = outputCount(conversation, outputs) === 0;

  return (
    <section className="flex h-full min-w-0 flex-col bg-background" data-testid="side-panel-launcher">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-6 py-16">
          {empty ? (
            <p className="text-center text-sm text-muted-foreground">{t('chat.info.empty')}</p>
          ) : (
            <div className="space-y-5">
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
            </div>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

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

function OutputGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="px-2 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5" aria-label={title}>
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
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        onClick={onClick}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {meta && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground tabular-nums">{meta}</span>}
        {badge && (
          <Badge variant="secondary" className="shrink-0">
            {badge}
          </Badge>
        )}
      </button>
    </li>
  );
}
