import { i18n } from '@/lib/i18n';
import type { ConversationSummary } from '../../../../shared/rpc';

/** 会话显示名：有标题用标题，否则用首条目标，都没有是「新对话」（随界面语言） */
export const conversationTitle = (c: Pick<ConversationSummary, 'title' | 'goal'>) =>
  c.title ?? (c.goal || i18n.t('shell.conversation.untitled'));
