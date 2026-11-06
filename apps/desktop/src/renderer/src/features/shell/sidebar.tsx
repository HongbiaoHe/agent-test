/**
 * 侧栏：顶部「新建 / 搜索」，会话列表按「已置顶 / 今天 / 昨天 / 最近 7 天 / 更早」分组（组可折叠），
 * 条目悬停出「…」菜单（置顶 / 重命名 / 删除）；底部用户区（Web 账号 + 设置入口，同 Web 侧栏底部）。
 * 顶部 h-12 留给 macOS 红绿灯与外壳的侧栏开关（SidebarToggle 浮在上面）。
 * 收起时由外壳以浮层形式临时弹出（floating），内容相同。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, LogIn, MessageSquare, MoreHorizontal, Plus, Search, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ConversationSummary } from '../../../../shared/rpc';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { useWebAccount } from '../auth/use-web-account';
import {
  type ConversationRef,
  DeleteConversationDialog,
  RenameConversationDialog,
} from '../conversations/conversation-dialogs';
import { ConversationMenuItems } from '../conversations/conversation-menu-items';
import { conversationTitle } from '../conversations/conversation-title';
import { useConversationActions } from '../conversations/use-conversation-actions';
import type { SettingsSection } from '../settings/settings-dialog';
import { type GroupKey, groupConversations } from './conversation-groups';

export type View = { kind: 'chat'; id: string } | { kind: 'home' };

function StatusDot({ status }: { status: ConversationSummary['status'] }) {
  const cls =
    status === 'running'
      ? 'bg-success animate-pulse'
      : status === 'waiting_approval'
        ? 'bg-warning'
        : status === 'failed'
          ? 'bg-destructive'
          : 'bg-transparent';
  return <span className={cn('size-1.5 shrink-0 rounded-full', cls)} />;
}

/** 顶部的大行按钮（新建 / 搜索），同截图里 Claude 侧栏的样式 */
function SidebarAction({
  icon,
  label,
  hint,
  ariaLabel,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="h-8 w-full justify-start gap-2.5 px-2.5 font-normal [&_svg:not([class*='size-'])]:size-4"
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {hint && <kbd className="font-sans text-xs text-muted-foreground">{hint}</kbd>}
    </Button>
  );
}

function ConversationItem({
  conv,
  active,
  onOpen,
  onTogglePin,
  onRename,
  onDelete,
}: {
  conv: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-accent',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen}>
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{conversationTitle(conv)}</span>
      </button>
      <StatusDot status={conv.status} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t('shell.sidebar.conversationActions')}
              // 平时隐藏，悬停条目或菜单打开时出现
              className="-my-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <ConversationMenuItems
            pinned={conv.pinnedAt !== null}
            onTogglePin={onTogglePin}
            onRename={onRename}
            onDelete={onDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function Sidebar({
  view,
  width,
  resizeHandle,
  floating = false,
  onNavigate,
  onOpenSearch,
  onOpenSettings,
  onSignIn,
}: {
  view: View;
  /** 宽度（px），由外壳的 useSidebarLayout 管 */
  width: number;
  /** 右缘的拖拽调宽把手；浮层不传（拖出浮层区会把浮层收回） */
  resizeHandle?: ReactNode;
  /** 收起状态下临时弹出的浮层：不透明底 + 阴影 */
  floating?: boolean;
  onNavigate: (v: View) => void;
  onOpenSearch: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  /** 未登录时点用户区：回到登录页 */
  onSignIn: () => void;
}) {
  const { t } = useTranslation();
  const account = useWebAccount();
  const signedIn = account.data?.signedIn ?? false;
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => agent.call('conversations.list', {}) });
  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind === 'reconnected' || e.type === 'conversations-changed') {
          void qc.invalidateQueries({ queryKey: ['conversations'] });
        }
      }),
    [qc],
  );
  const create = useMutation({
    mutationFn: () => agent.call('conversations.create', {}),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      onNavigate({ kind: 'chat', id: c.id });
    },
    onError: (e) => toast.error(e.message),
  });
  const actions = useConversationActions((id) => {
    if (view.kind === 'chat' && view.id === id) onNavigate({ kind: 'home' });
  });
  const [renaming, setRenaming] = useState<ConversationRef | null>(null);
  const [deleting, setDeleting] = useState<ConversationRef | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<GroupKey>>(new Set());
  const toggleGroup = (key: GroupKey) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // 「今天 / 昨天」的边界按列表拉取时刻算（渲染期不能调 Date.now）；会话一有变化列表就重拉，足够新
  const groups = groupConversations(list.data ?? [], list.dataUpdatedAt);

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col border-r border-border bg-muted/40',
        // 浮层与展开态同色：bg-muted/40 是半透明，靠外壳那层 bg-background 垫底，不在这里换底色
        floating && 'shadow-xl',
      )}
      style={{ width }}
    >
      {/* 顶部留给 macOS 红绿灯（titleBarStyle: hiddenInset）与侧栏开关，可拖动窗口 */}
      <div className="app-drag h-12 shrink-0" />
      <div className="shrink-0 space-y-0.5 px-2 pb-2">
        <SidebarAction
          icon={<Plus />}
          label={t('shell.sidebar.newChat')}
          ariaLabel={t('shell.sidebar.newChatLabel')}
          disabled={create.isPending}
          onClick={() => create.mutate()}
        />
        <SidebarAction icon={<Search />} label={t('shell.sidebar.search')} hint="⌘K" onClick={onOpenSearch} />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label={t('shell.sidebar.conversations')}>
        {groups.map((g) => {
          const open = !folded.has(g.key);
          return (
            <section key={g.key} className="pt-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggleGroup(g.key)}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t(`shell.groups.${g.key}`)}
                <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
              </button>
              {open && (
                <div className="space-y-0.5">
                  {g.items.map((c) => {
                    const ref = { id: c.id, title: conversationTitle(c) };
                    return (
                      <ConversationItem
                        key={c.id}
                        conv={c}
                        active={view.kind === 'chat' && view.id === c.id}
                        onOpen={() => onNavigate({ kind: 'chat', id: c.id })}
                        onTogglePin={() => actions.setPinned.mutate({ id: c.id, pinned: c.pinnedAt === null })}
                        onRename={() => setRenaming(ref)}
                        onDelete={() => setDeleting(ref)}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </nav>
      {/* 底部：用户（Web 账号）+ 设置（同 Web 侧栏底部） */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5">
        {signedIn ? (
          <button
            type="button"
            aria-label={t('shell.sidebar.account')}
            onClick={() => onOpenSettings('account')}
            className="flex min-w-0 items-center gap-2 rounded-md text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Avatar size="sm">
              <AvatarFallback>{(account.data?.email ?? 'U').charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="truncate text-sm font-medium" data-testid="sidebar-user">
              {account.data?.email}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            className="flex min-w-0 items-center gap-2 rounded-md text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Avatar size="sm">
              <AvatarFallback>
                <LogIn className="size-3.5" />
              </AvatarFallback>
            </Avatar>
            <span className="truncate" data-testid="sidebar-user">
              {t('shell.sidebar.signIn')}
            </span>
          </button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={t('shell.sidebar.settings')} onClick={() => onOpenSettings()} />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent>{t('shell.sidebar.settings')}</TooltipContent>
        </Tooltip>
      </div>
      <RenameConversationDialog
        target={renaming}
        onClose={() => setRenaming(null)}
        onRename={(id, title) => actions.rename.mutate({ id, title })}
      />
      <DeleteConversationDialog
        target={deleting}
        onClose={() => setDeleting(null)}
        onDelete={(id) => actions.remove.mutate(id)}
      />
      {/* 排在最后：Chromium 按文档顺序合成拖动区，把手的 no-drag 要盖过上面顶部的 app-drag */}
      {resizeHandle}
    </aside>
  );
}
