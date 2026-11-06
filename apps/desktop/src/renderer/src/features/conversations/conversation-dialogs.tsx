/**
 * 会话的重命名 / 删除确认弹窗（侧栏条目菜单与对话顶栏标题菜单共用）。
 * target 为 null 时关闭；确认后调用方执行实际操作。
 */
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface ConversationRef {
  id: string;
  title: string;
}

export function RenameConversationDialog({
  target,
  onClose,
  onRename,
}: {
  target: ConversationRef | null;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* key：每次打开以当前标题重新初始化输入框 */}
      {target && <RenameForm key={target.id} target={target} onClose={onClose} onRename={onRename} />}
    </Dialog>
  );
}

function RenameForm({
  target,
  onClose,
  onRename,
}: {
  target: ConversationRef;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(target.title);
  const trimmed = title.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    onRename(target.id, trimmed);
    onClose();
  };
  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{t('shell.conversation.renameTitle')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          aria-label={t('shell.conversation.titleLabel')}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!trimmed}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function DeleteConversationDialog({
  target,
  onClose,
  onDelete,
}: {
  target: ConversationRef | null;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('shell.conversation.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('shell.conversation.deleteDescription', { title: target?.title ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              if (target) onDelete(target.id);
              onClose();
            }}
          >
            {t('common.delete')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
