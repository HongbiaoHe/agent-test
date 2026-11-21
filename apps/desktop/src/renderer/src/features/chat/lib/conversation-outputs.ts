/**
 * 会话的产出物（会话信息侧栏、顶栏网页预览菜单用）：从对话流里的卡片收集网页预览、剪辑工程、画布、生成的媒体。
 * 都是最新的在前；同一个网页地址 / 工程文件 / 画布只留最新一条。
 */
import { useState } from 'react';
import type { MediaType } from '@/lib/api';
import { type PreviewSpec, previewLocation } from '@/features/viewer/preview-target';
import type { VideoProjectCardInfo } from '@/features/video-editor/lib/tool-result';
import type { ThreadItem } from './thread';

export interface ConversationOutputs {
  sites: PreviewSpec[];
  videos: VideoProjectCardInfo[];
  canvases: { canvasId: string; title: string | null }[];
  /** 一次 generate_* 调用一条（批量生成的多张在 generationIds 里）；itemId 是对话流里那张卡片的 id */
  media: { itemId: string; generationIds: string[]; mediaType: MediaType }[];
}

export function collectOutputs(items: readonly ThreadItem[]): ConversationOutputs {
  const out: ConversationOutputs = { sites: [], videos: [], canvases: [], media: [] };
  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === 'preview' && once(`site:${previewLocation(it.spec)}`)) out.sites.push(it.spec);
    else if (it?.kind === 'video_project' && once(`video:${it.info.path}`)) out.videos.push(it.info);
    else if (it?.kind === 'canvas' && once(`canvas:${it.info.canvasId}`))
      out.canvases.push({ canvasId: it.info.canvasId, title: it.info.title });
    else if (it?.kind === 'media')
      out.media.push({ itemId: it.id, generationIds: it.generationIds, mediaType: it.mediaType });
  }
  return out;
}

/** 两份产出物是否相同（只比各条的标识与显示用字段）：没变就沿用旧对象，侧栏的 memo 不被流式输出打破 */
export function sameOutputs(a: ConversationOutputs, b: ConversationOutputs): boolean {
  const key = (o: ConversationOutputs) =>
    JSON.stringify([
      o.sites.map((s) => [previewLocation(s), s.title]),
      o.videos.map((v) => [v.path, v.name, v.duration]),
      o.canvases.map((c) => [c.canvasId, c.title]),
      o.media.map((m) => [m.itemId, m.generationIds.length]),
    ]);
  return key(a) === key(b);
}

/**
 * 对话流 → 产出物，内容没变就返回同一个对象（渲染期校正，同本仓库其它「上一次的值」写法）：
 * agent 流式输出时对话流每个字都变，侧栏 memo 只在产出物真的变了时才重渲染
 */
export function useConversationOutputs(items: readonly ThreadItem[]): ConversationOutputs {
  const next = collectOutputs(items);
  const [outputs, setOutputs] = useState(next);
  if (!sameOutputs(outputs, next)) {
    setOutputs(next);
    return next;
  }
  return outputs;
}
