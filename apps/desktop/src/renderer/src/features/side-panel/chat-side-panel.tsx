/**
 * 对话的右侧侧栏：一个带标签的容器，网页预览 / 剪辑器 / 画布可以同时开着（见 side-panel-tabs.ts）；
 * 加号打开新建标签页（可打开的产出物列表）。
 *  - 默认停靠在对话右边、挤压对话（左边缘可拖动调整宽度，最窄 SIDE_PANEL_MIN_WIDTH，且至少给对话留同样宽；
 *    工具详情面板也开着时把它的宽度一并让出来）；
 *  - 「展开全部」：盖住整个对话区（不盖左侧会话栏），对话还在下面，收回即可继续聊；
 *  - Esc：展开时收回，停靠时关闭（焦点在输入框 / 弹窗 / 菜单里，或在侧栏内容里（画布、剪辑器有自己的 Esc）时不管）；
 *  - 切标签、收起侧栏都不卸载内容（只是隐藏）：网页不重新加载，剪辑器 / 画布的状态都还在；关掉标签才卸载。
 */
import { PROJECT_FILE_SUFFIX } from '@agent-test/video-schema';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ConversationSummary } from '../../../../shared/rpc';
import { CanvasWorkspace } from '../canvas/canvas-view';
import type { ConversationOutputs } from '../chat/lib/conversation-outputs';
import { SidebarResizeHandle } from '../shell/sidebar-resize-handle';
import { isTypingTarget } from '../video-editor/lib/keyboard';
import { VideoEditorView } from '../video-editor/video-editor-view';
import { PanelControls } from './panel-controls';
import { PanelTabs } from './panel-tabs';
import { orderedCanvases, SidePanelLauncher } from './side-panel-launcher';
import { SitePane } from './site-pane';
import type { SideTab } from './types';
import { SIDE_PANEL_MIN_WIDTH, type SidePanelActions } from './use-side-panel';

/** 工具详情面板在宽屏（lg）下的宽度（detail-panel.tsx 的 lg:w-96） */
const DETAIL_PANEL_WIDTH = 384;

/**
 * memo：它挂在对话视图里，而对话视图在 agent 流式输出时每个字都重渲染一次——属性都是原始值或引用稳定的
 * actions，没变就不重渲染侧栏里的画布 / 剪辑器 / 网页
 */
export const ChatSidePanel = memo(function ChatSidePanel({
  tabs,
  activeId,
  open,
  expanded,
  width,
  actions,
  conversationId,
  workspaceDir,
  headerInset,
  detailOpen,
  conversation,
  outputs,
}: {
  tabs: SideTab[];
  activeId: string | null;
  /** 侧栏是否显示：收起时内容不卸载，只是隐藏 */
  open: boolean;
  expanded: boolean;
  width: number;
  actions: SidePanelActions;
  conversationId: string;
  workspaceDir: string | null;
  /** 左侧会话栏收起时对话顶栏的让位类名：展开全部时侧栏顶栏占了对话顶栏的位置，同样要让 */
  headerInset?: string;
  /** 工具详情面板开着（宽屏下它与侧栏并排）：侧栏最宽时也要把它的宽度让出来 */
  detailOpen: boolean;
  /** 启动页用：会话摘要（当前画布）、产出物（outputs 内容没变时引用不变，见 useConversationOutputs） */
  conversation: ConversationSummary | null | undefined;
  outputs: ConversationOutputs;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 拖动中的宽度：直接写 DOM，松手才进状态（每帧走 React 会让整个对话视图重渲染） */
  const dragWidth = useRef<number | null>(null);
  const { toggleExpanded, hide } = actions;
  const shown = open && tabs.length > 0;

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      // 侧栏内容里（不含顶栏）按的 Esc 交给内容自己（画布取消选中、剪辑器取消拖动等）
      const target = e.target instanceof Element ? e.target : null;
      if (target && contentRef.current?.contains(target) && !target.closest('header')) return;
      if (expanded) toggleExpanded();
      else hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, expanded, toggleExpanded, hide]);

  if (tabs.length === 0) return null;
  const { list: canvases } = orderedCanvases(conversation, outputs);
  /** 标签上的名字：网页标题、工程名、画布名（对话里出现过才知道，否则「未命名」）、新建标签页 */
  const titleOf = (tab: SideTab): string => {
    if (tab.kind === 'site') return tab.spec.title;
    if (tab.kind === 'video') {
      // 对话里出现过的工程用它的工程名；从工作区面板直接打开的用文件名（去掉固定后缀）
      const file = tab.path.split('/').pop() ?? tab.path;
      return outputs.videos.find((v) => v.path === tab.path)?.name ?? file.replace(PROJECT_FILE_SUFFIX, '');
    }
    if (tab.kind === 'canvas') {
      return canvases.find((c) => c.canvasId === tab.canvasId)?.title || t('canvas.list.untitled');
    }
    return t('shell.sidePanel.newTab');
  };

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
        // 收起时只是隐藏：标签里的内容都还挂着
        shown ? 'flex' : 'hidden',
        'min-w-0 bg-background',
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
      <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PanelTabs
          tabs={tabs}
          activeId={activeId}
          titleOf={titleOf}
          onActivate={actions.activate}
          onClose={actions.closeTab}
          onNewTab={actions.newTab}
          controls={<PanelControls expanded={expanded} onToggleExpanded={toggleExpanded} onClose={hide} />}
          // 展开全部时标签栏占了对话顶栏的位置：左侧会话栏收起时同样要给红绿灯 / 侧栏开关让位
          className={expanded ? headerInset : undefined}
        />
        {/* 每个标签的内容都挂着，只显示当前这个：切回来时网页不重新加载、剪辑器 / 画布的状态还在 */}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={titleOf(tab)}
            data-testid="side-tab-panel"
            data-active={tab.id === activeId}
            className={cn('min-h-0 flex-1', tab.id !== activeId && 'hidden')}
          >
            {tab.kind === 'site' && <SitePane key={tab.openCount} spec={tab.spec} workspaceDir={workspaceDir} />}
            {tab.kind === 'video' && <VideoEditorView conversationId={conversationId} path={tab.path} />}
            {tab.kind === 'canvas' && <CanvasWorkspace canvasId={tab.canvasId} />}
            {tab.kind === 'launcher' && (
              <SidePanelLauncher
                conversation={conversation}
                outputs={outputs}
                onOpenSite={actions.openSite}
                onOpenVideo={actions.openVideo}
                onOpenCanvas={actions.openCanvas}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
