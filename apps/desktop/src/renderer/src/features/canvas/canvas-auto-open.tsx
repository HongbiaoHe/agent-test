/**
 * agent 在对话里新建 / 打开画布（create_canvas / open_canvas 成功的 tool_end）时**实时**把画布开到右侧侧栏，
 * 用户能直接看着 agent 搭。只看实时推来的事件，回放历史不会开（同 PreviewAutoOpen）。
 */
import { useEffect } from 'react';
import { agent } from '@/lib/agent-client';
import { CANVAS_CARD_TOOLS, parseCanvasResult } from './lib/tool-result';

export function CanvasAutoOpen({
  conversationId,
  onOpen,
}: {
  conversationId: string;
  onOpen: (canvasId: string) => void;
}) {
  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind === 'reconnected' || e.type !== 'conversation' || e.conversationId !== conversationId) return;
        const { type, payload } = e.event;
        if (type !== 'tool_end' || typeof payload !== 'object' || payload === null) return;
        if (!('name' in payload) || typeof payload.name !== 'string' || !CANVAS_CARD_TOOLS.includes(payload.name)) return;
        if (!('content' in payload)) return;
        const info = parseCanvasResult(payload.content);
        if (info) onOpen(info.canvasId);
      }),
    [conversationId, onOpen],
  );
  return null;
}
