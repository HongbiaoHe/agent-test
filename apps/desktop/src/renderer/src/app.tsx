/**
 * 应用外壳：登录页（未登录且没选「先跳过」时）或 侧栏 + 主区（对话 / 首页）+ 设置弹窗（分类管理）。
 * 没有路由库：视图只有这几种，用 state 切换。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { agent } from '@/lib/agent-client';
import { MODE_CATALOG_KEY, MODES_QUERY_KEY } from '@/lib/api';
import { ChatView } from './features/chat/chat-view';
import { LLM_QUERY_KEY, useHostStatus } from './features/llm/api';
import { readModePreference } from './features/modes/mode-preference';
import { LoginView } from './features/auth/login-view';
import { useWebAccount } from './features/auth/use-web-account';
import { SettingsDialog, type SettingsSection } from './features/settings/settings-dialog';
import { useSettings } from './features/settings/sections/use-settings';
import { SearchDialog } from './features/shell/search-dialog';
import type { SearchTarget } from './features/shell/search-items';
import { Sidebar, type View } from './features/shell/sidebar';
import { SidebarResizeHandle } from './features/shell/sidebar-resize-handle';
import { COLLAPSED_HEADER_INSET, SidebarToggle } from './features/shell/sidebar-toggle';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useSidebarLayout } from './features/shell/use-sidebar-layout';
import { FileViewerProvider } from './features/viewer/file-viewer';
import { VideoEditorOpenerContext, VideoEditorView } from './features/video-editor';
import { CanvasListView } from './features/canvas/canvas-list-view';
import { CanvasView } from './features/canvas/canvas-view';
import { CanvasOpenerContext, type CanvasTarget } from './features/canvas/open-canvas-context';

function Home({
  hasModels,
  onNavigate,
  onAddConnection,
}: {
  hasModels: boolean;
  onNavigate: (v: View) => void;
  onAddConnection: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const create = useMutation({
    // 新会话带上最近用的模式（agent-host 按模式回填默认模型 / 思考档位；模式已删则按通用建）
    mutationFn: () => agent.call('conversations.create', { modeId: readModePreference() ?? undefined }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      onNavigate({ kind: 'chat', id: c.id });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="flex h-full flex-col">
      <div className="app-drag h-12 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-24 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Spark</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t('shell.home.tagline')}
        </p>
        {hasModels ? (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus data-icon="inline-start" />
            {t('shell.home.newChat')}
          </Button>
        ) : (
          <Button onClick={onAddConnection}>
            <KeyRound data-icon="inline-start" />
            {t('shell.home.needKey')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>({ kind: 'home' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const layout = useSidebarLayout();
  const [section, setSection] = useState<SettingsSection>('account');
  /** 用户主动要登录（侧栏「未登录 · 登录」/ 设置 → 账号「登录」） */
  const [loginRequested, setLoginRequested] = useState(false);
  const qc = useQueryClient();
  const account = useWebAccount();
  const { settings, update } = useSettings();

  // 会话 / 技能 / 连接器按账号隔离（main 按账号给 agent-host 换数据目录）：换了账号，
  // 之前打开的会话在新空间里不存在，回到首页（渲染期校正，不在 effect 里 setState）
  const profile = account.data ? (account.data.signedIn ? `user:${account.data.email ?? ''}` : 'guest') : null;
  const [trackedProfile, setTrackedProfile] = useState(profile);
  if (profile !== trackedProfile) {
    setTrackedProfile(profile);
    if (trackedProfile !== null) {
      setView({ kind: 'home' });
      // 在设置里退出登录会先切到登录页：不收起的话，跳过 / 登录回来设置弹窗又会盖在主界面上
      setSettingsOpen(false);
    }
  }
  // 技能 / 连接器在别处变了（save_skill、/skills add、OAuth 回调）：刷新列表与 / 补全
  useEffect(
    () =>
      agent.subscribe((e) => {
        // agent-host 重启（换账号 / 改 Key / 崩溃恢复）：数据可能整个换了一份，全部重拉
        if (e.kind === 'reconnected') {
          void qc.invalidateQueries();
          return;
        }
        if (e.type === 'skills-changed') {
          void qc.invalidateQueries({ queryKey: ['skills'] });
          void qc.invalidateQueries({ queryKey: ['commands'] });
        }
        if (e.type === 'mcp-changed') void qc.invalidateQueries({ queryKey: ['mcp-servers'] });
        if (e.type === 'modes-changed') void qc.invalidateQueries({ queryKey: MODES_QUERY_KEY });
        // API 连接 / 模型 / 默认模型变了：设置页、模型下拉、「有没有可用模型」一起刷新
        if (e.type === 'llm-changed') void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
        // 模式编辑器的目录（可勾选的工具 / 连接器 / 技能）跟着技能、连接器、模式一起刷新
        if (e.type === 'skills-changed' || e.type === 'mcp-changed' || e.type === 'modes-changed') {
          void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
        }
      }),
    [qc],
  );
  // ⌘K：搜索会话（登录页上不响应：那时没有侧栏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 账号下有没有已启用的模型：没有时首页 / 对话里引导去添加 API 连接（还没查到时先按有，免得闪一下引导）
  const hostStatus = useHostStatus();
  const hasModels = hostStatus.data?.hasModels ?? true;

  const openSettings = (s: SettingsSection = 'account') => {
    setSection(s);
    setSettingsOpen(true);
  };
  const signIn = () => {
    setSettingsOpen(false);
    setLoginRequested(true);
  };
  // 从临时弹出的侧栏里切会话：顺手收回浮层
  const navigate = (v: View) => {
    layout.closePeek();
    setView(v);
  };
  /** 全局搜索选中一项：会话 / 画布 / 设置页 / 操作 */
  const openSearchTarget = async (target: SearchTarget) => {
    try {
      switch (target.kind) {
        case 'chat':
          navigate({ kind: 'chat', id: target.id });
          return;
        case 'canvas': {
          // 同画布列表：右侧对话栏接上最近一个绑定着它的对话
          const conv = await agent.call('canvas.latestConversation', { id: target.canvasId });
          navigate({ kind: 'canvas', canvasId: target.canvasId, conversationId: conv?.id ?? null });
          return;
        }
        case 'canvas-list':
          navigate({ kind: 'canvas-list' });
          return;
        case 'settings':
          openSettings(target.section);
          return;
        case 'new-chat': {
          const c = await agent.call('conversations.create', { modeId: readModePreference() ?? undefined });
          void qc.invalidateQueries({ queryKey: ['conversations'] });
          navigate({ kind: 'chat', id: c.id });
          return;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const openVideoEditor = (target: { conversationId: string; path: string }) =>
    navigate({ kind: 'video', conversationId: target.conversationId, path: target.path });
  const openCanvas = (target: CanvasTarget) =>
    navigate({ kind: 'canvas', canvasId: target.canvasId, conversationId: target.conversationId });
  const sidebarProps = {
    view,
    width: layout.width,
    onNavigate: navigate,
    onOpenSearch: () => setSearchOpen(true),
    onOpenSettings: openSettings,
    onSignIn: signIn,
  };

  // 启动时：没登录、也没选过「先跳过」→ 登录页（两份状态都到齐再判断，免得闪一下）
  const firstRunLogin =
    !!account.data && !!settings.data && !account.data.signedIn && !settings.data.loginSkipped;
  if (loginRequested || firstRunLogin) {
    return (
      <div className="h-screen overflow-clip">
        <LoginView
          apiUrl={settings.data?.webApiUrl ?? account.data?.apiUrl ?? ''}
          onSkip={() => {
            setLoginRequested(false);
            if (!settings.data?.loginSkipped) update.mutate({ loginSkipped: true });
          }}
          onDone={() => setLoginRequested(false)}
        />
      </div>
    );
  }

  return (
    // 根部的预览（无会话）：设置里技能详情等 Markdown 的远程链接也能预览；对话里由 ChatView 自己的那层接管
    <FileViewerProvider>
      <div className="relative flex h-screen overflow-clip">
        {!layout.collapsed && (
          <Sidebar
            {...sidebarProps}
            resizeHandle={
              <SidebarResizeHandle
                width={layout.width}
                min={SIDEBAR_MIN_WIDTH}
                max={SIDEBAR_MAX_WIDTH}
                onResize={layout.resize}
                onResizeEnd={layout.endResize}
              />
            }
          />
        )}
        {layout.peek && (
          // 收起时悬停开关临时弹出的浮层；指针离开浮层区（data-peek-zone）后收回，见 use-sidebar-layout
          <div className="absolute inset-y-0 left-0 z-40 bg-background" data-peek-zone="" data-testid="sidebar-peek">
            <Sidebar {...sidebarProps} floating />
          </div>
        )}
        {/* data-view：e2e 失败时打印当前视图（排查过「对话区被换掉」的偶发问题） */}
        <main
          className="min-w-0 flex-1"
          data-view={
            view.kind === 'chat'
              ? `chat:${view.id}`
              : view.kind === 'video'
                ? `video:${view.path}`
                : view.kind === 'canvas'
                  ? `canvas:${view.canvasId}`
                  : view.kind
          }
        >
          {view.kind === 'chat' && (
            // 对话里的工程卡片 / 工作区面板经这个上下文切到剪辑器
            <VideoEditorOpenerContext.Provider value={openVideoEditor}>
              <CanvasOpenerContext.Provider value={openCanvas}>
              <ChatView
                key={view.id}
                id={view.id}
                hasModels={hasModels}
                onOpenModelSettings={() => openSettings('models')}
                headerInset={layout.collapsed ? COLLAPSED_HEADER_INSET : undefined}
                onDeleted={() => navigate({ kind: 'home' })}
              />
              </CanvasOpenerContext.Provider>
            </VideoEditorOpenerContext.Provider>
          )}
          {view.kind === 'canvas-list' && (
            <CanvasListView
              headerInset={layout.collapsed ? COLLAPSED_HEADER_INSET : undefined}
              onOpen={openCanvas}
              onSignIn={signIn}
            />
          )}
          {view.kind === 'canvas' && (
            // 右侧对话栏里的画布卡片 / 工程卡片也能切视图
            <VideoEditorOpenerContext.Provider value={openVideoEditor}>
              <CanvasOpenerContext.Provider value={openCanvas}>
                <CanvasView
                  key={view.canvasId}
                  canvasId={view.canvasId}
                  conversationId={view.conversationId}
                  hasModels={hasModels}
                  headerInset={layout.collapsed ? COLLAPSED_HEADER_INSET : undefined}
                  onBack={() =>
                    navigate(view.conversationId ? { kind: 'chat', id: view.conversationId } : { kind: 'canvas-list' })
                  }
                  onOpenModelSettings={() => openSettings('models')}
                  onConversationChange={(conversationId) =>
                    setView({ kind: 'canvas', canvasId: view.canvasId, conversationId })
                  }
                />
              </CanvasOpenerContext.Provider>
            </VideoEditorOpenerContext.Provider>
          )}
          {view.kind === 'video' && (
            <VideoEditorView
              key={`${view.conversationId}:${view.path}`}
              conversationId={view.conversationId}
              path={view.path}
              headerInset={layout.collapsed ? COLLAPSED_HEADER_INSET : undefined}
              onBack={() => navigate({ kind: 'chat', id: view.conversationId })}
            />
          )}
          {view.kind === 'home' && (
            <Home hasModels={hasModels} onNavigate={navigate} onAddConnection={() => openSettings('models')} />
          )}
        </main>
        {/* 开关必须排在侧栏、主区之后：Chromium 按文档顺序合成窗口拖动区（app-region），
            排在前面的 no-drag 会被后面侧栏顶部 / 对话顶栏的 drag 区盖掉，真实鼠标点下去变成拖窗口
            （Playwright 的合成点击不走拖动区，e2e 测不出来） */}
        <SidebarToggle
          collapsed={layout.collapsed}
          sidebarWidth={layout.width}
          resizing={layout.resizing}
          onToggle={layout.toggle}
          onHover={layout.openPeek}
        />
        <SearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onSelect={(target) => {
            setSearchOpen(false);
            void openSearchTarget(target);
          }}
        />
        <SettingsDialog
          open={settingsOpen}
          section={section}
          onOpenChange={setSettingsOpen}
          onSectionChange={setSection}
          onSignIn={signIn}
          onConversationsDeleted={(ids) => {
            // 正开着的会话被删了：回首页（对话、画布右侧对话栏、剪辑器都挂在会话上）
            const openId = view.kind === 'chat' ? view.id : view.kind === 'canvas' || view.kind === 'video' ? view.conversationId : null;
            if (openId && ids.includes(openId)) setView({ kind: 'home' });
          }}
        />
      </div>
    </FileViewerProvider>
  );
}
