/**
 * 打开剪辑器的入口函数（由外壳 App 提供）：对话里的工程卡片、工作区文件面板拿它切到剪辑器视图，
 * 不用把导航回调一层层传下去。没有提供方（如设置页）时为 null，入口按钮不显示。
 */
import { createContext, useContext } from 'react';

export interface VideoEditorTarget {
  conversationId: string;
  /** 工作区相对路径（videos/*.sparkvideo.json） */
  path: string;
}

export const VideoEditorOpenerContext = createContext<((target: VideoEditorTarget) => void) | null>(null);

export function useOpenVideoEditor(): ((target: VideoEditorTarget) => void) | null {
  return useContext(VideoEditorOpenerContext);
}
