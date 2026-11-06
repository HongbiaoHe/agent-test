/**
 * 对话顶栏（同 Claude 桌面端的会话工具栏）：
 * - 左：标题 + 下拉菜单（置顶 / 重命名 / 在访达中打开工作区 / 删除）；
 * - 右：本会话的任务计划、网页预览（agent 调过 preview_page 才出现），token 用量与工作区文件仍由 ChatThread 渲染。
 */
import { ChevronDown, FolderSearch, Globe, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TodoList } from '@/components/agent/todo-list';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DeleteConversationDialog, RenameConversationDialog } from '@/features/conversations/conversation-dialogs';
import { ConversationMenuItems } from '@/features/conversations/conversation-menu-items';
import { useConversationActions } from '@/features/conversations/use-conversation-actions';
import { type PreviewSpec, previewLocation } from '@/features/viewer/preview-target';
import { useFileViewer } from '@/features/viewer/viewer-context';
import type { ThreadItem } from '../lib/thread';

export function ConversationTitleMenu({
  conversationId,
  title,
  pinned,
  workspaceDir,
  onDeleted,
}: {
  conversationId: string;
  title: string;
  pinned: boolean;
  workspaceDir: string | null;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const actions = useConversationActions(onDeleted);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = { id: conversationId, title };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('chat.toolbar.menu')}
              // 按钮默认 shrink-0：标题超长时要能被压缩并省略号截断，不能盖住右侧工具图标
              className="max-w-full min-w-0 shrink gap-1 px-2 text-sm font-semibold tracking-tight"
            />
          }
        >
          <h1 className="min-w-0 truncate">{title}</h1>
          <ChevronDown className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <ConversationMenuItems
            pinned={pinned}
            onTogglePin={() => actions.setPinned.mutate({ id: conversationId, pinned: !pinned })}
            onRename={() => setRenaming(true)}
            onDelete={() => setDeleting(true)}
          >
            {workspaceDir && (
              <DropdownMenuItem onClick={() => void window.desktop.showInFolder(workspaceDir)}>
                <FolderSearch />
                {t('chat.toolbar.openWorkspaceInFinder')}
              </DropdownMenuItem>
            )}
          </ConversationMenuItems>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameConversationDialog
        target={renaming ? ref : null}
        onClose={() => setRenaming(false)}
        onRename={(id, newTitle) => actions.rename.mutate({ id, title: newTitle })}
      />
      <DeleteConversationDialog
        target={deleting ? ref : null}
        onClose={() => setDeleting(false)}
        onDelete={(id) => actions.remove.mutate(id)}
      />
    </>
  );
}

/** 本会话出现过的网页预览，最新的在前，同一地址只留一条 */
function previewsOf(items: ThreadItem[]): PreviewSpec[] {
  const seen = new Set<string>();
  const out: PreviewSpec[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind !== 'preview') continue;
    const loc = previewLocation(it.spec);
    if (seen.has(loc)) continue;
    seen.add(loc);
    out.push(it.spec);
  }
  return out;
}

export function ConversationToolbarIcons({ items }: { items: ThreadItem[] }) {
  const { t } = useTranslation();
  const viewer = useFileViewer();
  const plan = items.find((it): it is Extract<ThreadItem, { kind: 'plan' }> => it.kind === 'plan');
  const previews = previewsOf(items);
  const done = plan?.todos.filter((t) => t.status === 'completed').length ?? 0;

  return (
    <>
      {plan && plan.todos.length > 0 && (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label={t('chat.toolbar.taskPlan', { done, total: plan.todos.length })} />}
                />
              }
            >
              <ListChecks />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('chat.toolbar.taskPlan', { done, total: plan.todos.length })}
            </TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-80 p-3">
            <TodoList todos={plan.todos} />
          </PopoverContent>
        </Popover>
      )}
      {viewer && previews.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('chat.toolbar.sitePreview')} />} />
              }
            >
              <Globe />
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('chat.toolbar.sitePreview')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('chat.toolbar.sitePreviews')}</DropdownMenuLabel>
              {previews.map((spec) => (
                <DropdownMenuItem key={previewLocation(spec)} onClick={() => viewer.show({ source: 'site', spec })}>
                  <Globe />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{spec.title}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {previewLocation(spec)}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
