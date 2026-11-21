/**
 * desktop 本机 agent 的画布工具：
 *  - 结构 / 生成类工具来自 agent-core（与 Web 画布 agent 共用），执行端按「对话当前绑定的画布」取；
 *  - 绑定类工具（list_canvases / create_canvas / open_canvas）是 desktop 自己的：一个对话同一时间只有一块
 *    当前画布，agent 新建或打开画布时绑定，用户在对话里点开画布卡片也会切过去。
 * 画布数据在 Web 账号下（与 Web 端同一批画布），所以这些工具都要求登录了 Web 账号（capability canvas）。
 */
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { CANVAS_TOOLS_PROMPT } from '@agent-test/agent-core/canvas/canvas-prompt';
import { createCanvasTools } from '@agent-test/agent-core/canvas/canvas-tools';
import { z } from 'zod';
import type { CanvasRunSession } from './canvas-run';
import type { CanvasWeb } from './canvas-web';

import { CREATE_CANVAS_TOOL, LIST_CANVASES_TOOL, OPEN_CANVAS_TOOL } from '../../shared/canvas';

export { CREATE_CANVAS_TOOL, LIST_CANVASES_TOOL, OPEN_CANVAS_TOOL };

/** 每轮运行的画布上下文（RunService 装配，经 DesktopToolHost 传给工具工厂） */
export interface CanvasRunContext {
  web: CanvasWeb;
  session: CanvasRunSession;
  /** 本机对话 id（附件按它记账） */
  conversationId: string;
  /** 对话当前绑定的画布；没有为 null */
  current(): string | null;
  /** 绑定（新建 / 打开画布时） */
  bind(canvasId: string): void;
}

const NOT_BOUND =
  '当前对话还没有打开画布：先用 create_canvas 新建一块，或用 list_canvases 找到已有画布后 open_canvas 打开，再操作。';

/** 共享画布工具：执行端按当前绑定的画布现取（中途 open_canvas 换了画布，后续调用就落到新画布上） */
export function createBoundCanvasTools(ctx: CanvasRunContext): StructuredToolInterface[] {
  return (
    createCanvasTools(() => {
      const id = ctx.current();
      return Promise.resolve(id ? ctx.session.backendFor(id, ctx.conversationId) : NOT_BOUND);
    })
      // list_media_models 由媒体工具提供（同一个模型目录，还多了音频）：同名工具只能挂一个
      .filter((t) => t.name !== 'list_media_models')
  );
}

export function createListCanvasesTool(ctx: CanvasRunContext): StructuredToolInterface {
  return tool(
    async () => {
      const { items } = await ctx.web.list();
      return JSON.stringify({
        current: ctx.current(),
        canvases: items.slice(0, 50).map((c) => ({ canvasId: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    },
    {
      name: LIST_CANVASES_TOOL,
      description:
        '列出用户 Web 账号下的画布（最近更新在前，最多 50 块），返回 canvasId、标题与 current（当前对话打开着的画布）。用户提到「那块画布」「上次的画布」时先用它找，再用 open_canvas 打开。',
      schema: z.object({}),
    },
  );
}

export function createCreateCanvasTool(ctx: CanvasRunContext): StructuredToolInterface {
  return tool(
    async ({ title }) => {
      const { sessionId } = await ctx.web.create(title);
      ctx.bind(sessionId);
      return JSON.stringify({ canvasId: sessionId, title: title ?? null, opened: true });
    },
    {
      name: CREATE_CANVAS_TOOL,
      description:
        '新建一块空画布并设为当前对话的画布（之后的画布工具都操作它）。用户要搭一条图片 / 视频工作流、又没指定已有画布时用。',
      schema: z.object({
        title: z.string().max(100).optional().describe('画布标题（按用户目标起一个简短的名字）'),
      }),
    },
  );
}

export function createOpenCanvasTool(ctx: CanvasRunContext): StructuredToolInterface {
  return tool(
    async ({ canvasId }) => {
      const snap = await ctx.web.snapshot(canvasId);
      ctx.bind(snap.id);
      return JSON.stringify({
        canvasId: snap.id,
        title: snap.title,
        nodes: snap.nodes.length,
        opened: true,
      });
    },
    {
      name: OPEN_CANVAS_TOOL,
      description:
        '打开一块已有画布并设为当前对话的画布（canvasId 取自 list_canvases）。打开后画布的实时状态会自动注入对话。',
      schema: z.object({ canvasId: z.string().min(1) }),
    },
  );
}

/** 画布工具段：共享的工具用法 + desktop 的绑定与审批说明 */
export const DESKTOP_CANVAS_PROMPT = `${CANVAS_TOOLS_PROMPT}

### 在本对话里使用画布
- 画布存在用户的 Web 账号里（与网页端同一批）。一个对话同一时间只操作一块**当前画布**：没有时先 \`create_canvas\` 新建，或 \`list_canvases\` + \`open_canvas\` 打开已有的；用户在对话里点开某块画布也会切换当前画布（以注入的最新画布状态为准）。
- 你改画布期间，其它端的用户只能拖动节点；画布正被网页上的画布 agent 或另一个桌面端占用时，修改会被拒绝——如实告诉用户稍后再试。
- 生成会消耗用户的额度：按权限档位，清空画布、删节点、触发生成和拼接可能需要用户确认；被拒绝就停下，不要绕道。`;
