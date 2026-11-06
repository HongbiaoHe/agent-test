/**
 * 会话菜单的公共条目（侧栏条目「…」菜单、对话顶栏标题菜单共用）：置顶 / 重命名 / [调用方附加项] / 删除。
 * 只渲染 DropdownMenuItem，外层 DropdownMenu / Content 由调用方提供。
 */
import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export function ConversationMenuItems({
  pinned,
  onTogglePin,
  onRename,
  onDelete,
  children,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** 附加在「重命名」之后、「删除」之前的条目 */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem onClick={onTogglePin}>
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? t('shell.conversation.unpin') : t('shell.conversation.pin')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onRename}>
        <Pencil />
        {t('common.rename')}
      </DropdownMenuItem>
      {children}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        {t('common.delete')}
      </DropdownMenuItem>
    </>
  );
}
