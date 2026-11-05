/**
 * 侧栏：新对话、会话列表（带运行状态）、底部用户区（Web 账号 + 设置入口，同 Web 侧栏底部）。
 * 技能、连接器、模型 Key 等都在设置弹窗里分类管理。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, MessageSquare, Plus, Settings, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import type { ConversationSummary } from '../../../../shared/rpc';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { useWebAccount } from '../auth/use-web-account';
import type { SettingsSection } from '../settings/settings-dialog';

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

export function Sidebar({
  view,
  onNavigate,
  onOpenSettings,
  onSignIn,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  /** 未登录时点用户区：回到登录页 */
  onSignIn: () => void;
}) {
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
  const remove = useMutation({
    mutationFn: (id: string) => agent.call('conversations.delete', { id }),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      if (view.kind === 'chat' && view.id === id) onNavigate({ kind: 'home' });
    },
  });

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-muted/40">
      {/* 顶部留给 macOS 红绿灯（titleBarStyle: hiddenInset），可拖动窗口 */}
      <div className="app-drag flex h-12 shrink-0 items-center justify-end px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="新建对话"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus />
        </Button>
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2" aria-label="会话">
        {list.data?.map((c) => {
          const activeItem = view.kind === 'chat' && view.id === c.id;
          return (
            <div
              key={c.id}
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-accent',
                activeItem && 'bg-accent text-accent-foreground',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onNavigate({ kind: 'chat', id: c.id })}
              >
                <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.title ?? (c.goal || '新对话')}</span>
              </button>
              <StatusDot status={c.status} />
              <button
                type="button"
                aria-label="删除会话"
                className="hidden text-muted-foreground group-hover:block hover:text-foreground"
                onClick={() => remove.mutate(c.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </nav>
      {/* 底部：用户（Web 账号）+ 设置（同 Web 侧栏底部） */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5">
        {signedIn ? (
          <button
            type="button"
            aria-label="账号"
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
              未登录 · 登录
            </span>
          </button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="设置" onClick={() => onOpenSettings()} />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
