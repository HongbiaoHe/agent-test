/**
 * 打开画布视图的入口函数（由外壳 App 提供）：对话里的画布卡片、画布列表拿它切到画布视图，
 * 不用把导航回调一层层传下去。没有提供方时为 null，入口按钮不显示。
 */
import { createContext, useContext } from 'react';

export interface CanvasTarget {
  canvasId: string;
  /** 右侧对话栏显示的对话；null = 还没有对话（发第一条消息时才新建并绑定） */
  conversationId: string | null;
}

export const CanvasOpenerContext = createContext<((target: CanvasTarget) => void) | null>(null);

export function useOpenCanvas(): ((target: CanvasTarget) => void) | null {
  return useContext(CanvasOpenerContext);
}
