/**
 * 对话的右侧侧栏：网页预览 / 剪辑器 / 画布 / 会话信息。
 *  - 默认停靠在对话右边、挤压对话（左边缘可拖动调整宽度，最窄 SIDE_PANEL_MIN_WIDTH，且至少给对话留同样宽；
 *    工具详情面板也开着时把它的宽度一并让出来）；
 *  - 「展开全部」：盖住整个对话区（不盖左侧会话栏），对话还在下面，收回即可继续聊；
 *  - Esc：展开时收回，停靠时关闭（焦点在输入框 / 弹窗 / 菜单里，或在侧栏内容里（画布、剪辑器有自己的 Esc）时不管）；
 *  - 一次只开一个，打开别的就换掉。
 */
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ConversationSummary } from '../../../../shared/rpc';
import { CanvasWorkspace } from '../canvas/canvas-view';
import type { ConversationOutputs } from '../chat/lib/conversation-outputs';
import { SidebarResizeHandle } from '../shell/sidebar-resize-handle';
import { isTypingTarget } from '../video-editor/lib/keyboard';
import { VideoEditorView } from '../video-editor/video-editor-view';
import { ConversationInfoPane } from './conversation-info-pane';
import { PanelControls } from './panel-controls';
import { SitePane } from './site-pane';
import type { SidePanelItem } from './types';
import { SIDE_PANEL_MIN_WIDTH, type SidePanelActions } from './use-side-panel';

/** 工具详情面板在宽屏（lg）下的宽度（detail-panel.tsx 的 lg:w-96） */
const DETAIL_PANEL_WIDTH = 384;

/**
 * memo：它挂在对话视图里，而对话视图在 agent 流式输出时每个字都重渲染一次——属性都是原始值或引用稳定的
 * actions，没变就不重渲染侧栏里的画布 / 剪辑器 / 网页
 */
export const ChatSidePanel = memo(function ChatSidePanel({
  item,
  expanded,
  width,
  actions,
  conversationId,
  workspaceDir,
  headerInset,
  detailOpen,
  conversation,
  tokens,
  outputs,
}: {
  item: SidePanelItem | null;
  expanded: boolean;
  width: number;
  actions: SidePanelActions;
  conversationId: string;
  workspaceDir: string | null;
  /** 左侧会话栏收起时对话顶栏的让位类名：展开全部时侧栏顶栏占了对话顶栏的位置，同样要让 */
  headerInset?: string;
  /** 工具详情面板开着（宽屏下它与侧栏并排）：侧栏最宽时也要把它的宽度让出来 */
  detailOpen: boolean;
  /** 会话信息栏用：会话摘要、累计 token、产出物（outputs 内容没变时引用不变，见 useConversationOutputs） */
  conversation: ConversationSummary | null | undefined;
  tokens: number;
  outputs: ConversationOutputs;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 拖动中的宽度：直接写 DOM，松手才进状态（每帧走 React 会让整个对话视图重渲染） */
  const dragWidth = useRef<number | null>(null);
  const { toggleExpanded, close } = actions;

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      // 侧栏内容里（不含顶栏）按的 Esc 交给内容自己（画布取消选中、剪辑器取消拖动等）
      const target = e.target instanceof Element ? e.target : null;
      if (target && contentRef.current?.contains(target) && !target.closest('header')) return;
      if (expanded) toggleExpanded();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, expanded, toggleExpanded, close]);

  if (!item) return null;
  const inset = expanded ? headerInset : undefined;
  const controls = <PanelControls expanded={expanded} onToggleExpanded={toggleExpanded} onClose={close} />;

  /** 指针 x → 宽度：侧栏贴右缘，宽度 = 右缘 - x；夹在最窄与「给对话留够」之间 */
  const onResize = (clientX: number) => {
    const el = rootRef.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const rowWidth = row.getBoundingClientRect().width;
    const reserved = SIDE_PANEL_MIN_WIDTH + (detailOpen && window.innerWidth >= 1024 ? DETAIL_PANEL_WIDTH : 0);
    const max = Math.max(SIDE_PANEL_MIN_WIDTH, rowWidth - reserved);
    const w = Math.min(Math.max(el.getBoundingClientRect().right - clientX, SIDE_PANEL_MIN_WIDTH), max);
    dragWidth.current = w;
    el.style.width = `${w}px`;
  };
  // 拖动期间内容区（网页预览的 iframe、画布）不吃指针：跨源 iframe 会把移进去的指针事件截走，
  // 把手的指针捕获也拿不回来，往里拖就拖不动了
  const onResizeStart = () => {
    if (contentRef.current) contentRef.current.style.pointerEvents = 'none';
  };
  const onResizeEnd = () => {
    if (contentRef.current) contentRef.current.style.pointerEvents = '';
    const w = dragWidth.current;
    dragWidth.current = null;
    if (w === null) return;
    actions.resize(w);
    actions.commitWidth(w);
  };

  return (
    <div
      ref={rootRef}
      role="complementary"
      aria-label={t('shell.sidePanel.label')}
      data-testid="chat-side-panel"
      data-expanded={expanded}
      className={cn(
        'flex min-w-0 bg-background',
        expanded
          ? 'absolute inset-0 z-20'
          : cn(
              'relative shrink-0 border-l border-border',
              // 至少给对话留 SIDE_PANEL_MIN_WIDTH；工具详情面板在宽屏下并排时也要让出它的宽度
              'max-w-[calc(100%-360px)]',
              detailOpen && 'lg:max-w-[calc(100%-744px)]',
            ),
      )}
      style={expanded ? undefined : { width }}
    >
      {!expanded && (
        <SidebarResizeHandle
          edge="left"
          label={t('shell.sidePanel.resize')}
          width={width}
          min={SIDE_PANEL_MIN_WIDTH}
          max={Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - SIDE_PANEL_MIN_WIDTH)}
          onResizeStart={onResizeStart}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}
      <div ref={contentRef} className="min-w-0 flex-1">
        {item.kind === 'site' && (
          <SitePane
            key={item.openCount}
            spec={item.spec}
            workspaceDir={workspaceDir}
            controls={controls}
            headerInset={inset}
          />
        )}
        {item.kind === 'video' && (
          <VideoEditorView
            key={item.path}
            conversationId={conversationId}
            path={item.path}
            headerExtra={controls}
            headerInset={inset}
          />
        )}
        {item.kind === 'canvas' && (
          <CanvasWorkspace key={item.canvasId} canvasId={item.canvasId} trailing={controls} headerInset={inset} />
        )}
        {item.kind === 'info' && (
          <ConversationInfoPane
            conversation={conversation}
            tokens={tokens}
            outputs={outputs}
            controls={controls}
            headerInset={inset}
            onOpenSite={actions.openSite}
            onOpenVideo={actions.openVideo}
            onOpenCanvas={actions.openCanvas}
          />
        )}
      </div>
    </div>
  );
});
