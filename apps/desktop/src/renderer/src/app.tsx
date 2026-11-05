/**
 * 应用外壳：登录页（未登录且没选「先跳过」时）或 侧栏 + 主区（对话 / 首页）+ 设置弹窗（分类管理）。
 * 没有路由库：视图只有这几种，用 state 切换。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { agent } from '@/lib/agent-client';
import { ChatView } from './features/chat/chat-view';
import { LoginView } from './features/auth/login-view';
import { useWebAccount } from './features/auth/use-web-account';
import { SettingsDialog, type SettingsSection } from './features/settings/settings-dialog';
import { useSettings } from './features/settings/sections/use-settings';
import { Sidebar, type View } from './features/shell/sidebar';
import { FileViewerProvider } from './features/viewer/file-viewer';

function Home({
  hasAnyKey,
  onNavigate,
  onFillKey,
}: {
  hasAnyKey: boolean;
  onNavigate: (v: View) => void;
  onFillKey: () => void;
}) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => agent.call('conversations.create', {}),
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
          在你自己的电脑上运行的 agent：读写工作区文件、执行命令、使用技能与连接器。
        </p>
        {hasAnyKey ? (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus data-icon="inline-start" />
            新对话
          </Button>
        ) : (
          <Button onClick={onFillKey}>
            <KeyRound data-icon="inline-start" />
            先填写模型 Key
          </Button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>({ kind: 'home' });
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      }),
    [qc],
  );
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => window.desktop.getKeyStatus() });
  const conv = useQuery({
    queryKey: ['conversation-model', view.kind === 'chat' ? view.id : ''],
    queryFn: () => (view.kind === 'chat' ? agent.call('conversations.get', { id: view.id }) : null),
    enabled: view.kind === 'chat',
  });
  const model = conv.data?.conversation.model ?? settings.data?.defaultModel ?? '';
  const provider = model.startsWith('deepseek:') ? 'deepseek' : 'google';
  const hasKey = !!keys.data?.[provider];
  const hasAnyKey = !!keys.data && (keys.data.google || keys.data.deepseek);

  const openSettings = (s: SettingsSection = 'account') => {
    setSection(s);
    setSettingsOpen(true);
  };
  const signIn = () => {
    setSettingsOpen(false);
    setLoginRequested(true);
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
      <div className="flex h-screen overflow-clip">
        <Sidebar view={view} onNavigate={setView} onOpenSettings={openSettings} onSignIn={signIn} />
        {/* data-view：e2e 失败时打印当前视图（排查过「对话区被换掉」的偶发问题） */}
        <main className="min-w-0 flex-1" data-view={view.kind === 'chat' ? `chat:${view.id}` : view.kind}>
          {view.kind === 'chat' && <ChatView key={view.id} id={view.id} hasKey={hasKey} />}
          {view.kind === 'home' && (
            <Home hasAnyKey={hasAnyKey} onNavigate={setView} onFillKey={() => openSettings('models')} />
          )}
        </main>
        <SettingsDialog
          open={settingsOpen}
          section={section}
          onOpenChange={setSettingsOpen}
          onSectionChange={setSection}
          onSignIn={signIn}
        />
      </div>
    </FileViewerProvider>
  );
}
