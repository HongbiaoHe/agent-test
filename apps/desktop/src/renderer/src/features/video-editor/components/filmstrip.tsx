/**
 * 视频轨片段块里的预览帧：视频取 agent-host 生成的抽帧拼图（video.thumbnails），图片直接平铺原图。
 * 格子按时间线缩放实时重算（只铺可视区域附近），拖拽裁剪时跟着草稿变化。拼图还没好 / 失败时不显示，片段块照常可用。
 * 画面是素材本身，不涉及主题色。
 */
import type { TrackClip } from '@agent-test/video-schema';
import { useQuery } from '@tanstack/react-query';
import { agent } from '@/lib/agent-client';
import { filmstripTiles } from '../lib/filmstrip';
import { mediaUrl } from '../lib/media-url';

/** 每个素材当前在用的 Blob URL：同一素材重新加载（缓存过期后再打开剪辑器）时先释放旧的，不越积越多 */
const spriteUrls = new Map<string, string>();

/**
 * 拼图 data URL → Blob URL：几百 KB 的字符串不重复写进每个格子的样式里。
 * 就地解码 base64（CSP 的 connect-src 不放行 data:，不能 fetch；img-src 放行 blob:）。
 */
async function loadThumbnails(conversationId: string, path: string) {
  const t = await agent.call('video.thumbnails', { conversationId, path });
  const bytes = Uint8Array.from(atob(t.sprite.slice(t.sprite.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  const key = `${conversationId}\0${path}`;
  const previous = spriteUrls.get(key);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  spriteUrls.set(key, url);
  return { ...t, url };
}

export function Filmstrip({
  conversationId,
  origin,
  clip,
  blockLeft,
  blockWidth,
  height,
  pps,
  view,
}: {
  conversationId: string;
  origin: string | null;
  clip: TrackClip;
  blockLeft: number;
  blockWidth: number;
  /** 格子显示高度（像素） */
  height: number;
  pps: number;
  /** 时间线可视区域（内容坐标） */
  view: { left: number; width: number };
}) {
  const isVideo = clip.type === 'video';
  const thumbs = useQuery({
    queryKey: ['video-thumbs', conversationId, clip.src],
    queryFn: () => loadThumbnails(conversationId, clip.src),
    enabled: isVideo,
    staleTime: Infinity,
    retry: false,
  });

  let sprite: { url: string; count: number; interval: number; tileWidth: number; cover: boolean } | null = null;
  if (isVideo && thumbs.data) {
    const d = thumbs.data;
    sprite = { url: d.url, count: d.count, interval: d.interval, tileWidth: (height * d.tileWidth) / d.tileHeight, cover: false };
  } else if (!isVideo && origin) {
    sprite = { url: mediaUrl(origin, clip.src), count: 1, interval: 1, tileWidth: (height * clip.width) / clip.height, cover: true };
  }
  if (!sprite) return null;
  const s = sprite;

  const tiles = filmstripTiles({
    blockLeft,
    blockWidth,
    tileWidth: s.tileWidth,
    viewLeft: view.left,
    viewWidth: view.width,
    pps,
    inPoint: clip.type === 'video' ? clip.inPoint : 0,
    interval: s.interval,
    count: s.count,
  });
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="video-filmstrip" data-frames={tiles.length}>
      {tiles.map((tile) => (
        <div
          key={tile.x}
          className="absolute top-0"
          data-frame={tile.frame}
          style={{
            left: tile.x,
            width: s.tileWidth,
            height,
            backgroundImage: `url("${s.url}")`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: s.cover ? 'cover' : `${s.count * s.tileWidth}px ${height}px`,
            backgroundPosition: s.cover ? 'center' : `${-tile.frame * s.tileWidth}px 0`,
          }}
        />
      ))}
    </div>
  );
}
