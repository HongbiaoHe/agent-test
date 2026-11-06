import type { MessageShape } from '../shape';
import type { shell as source } from '../zh-CN/shell';

export const shell = {
  home: {
    tagline: 'An agent that runs on your own computer: reads and writes workspace files, runs commands, and uses skills and connectors.',
    newChat: 'New chat',
    needKey: 'Add a model key first',
  },
  sidebar: {
    newChat: 'New',
    newChatLabel: 'New chat',
    search: 'Search',
    conversations: 'Chats',
    conversationActions: 'Chat actions',
    account: 'Account',
    signIn: 'Not signed in · Sign in',
    settings: 'Settings',
    expand: 'Expand sidebar',
    collapse: 'Collapse sidebar',
  },
  groups: {
    pinned: 'Pinned',
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'Previous 7 days',
    older: 'Older',
  },
  search: {
    title: 'Search chats',
    placeholder: 'Search chat titles and content…',
    results: 'Search results',
    recent: 'Recent',
    noMatch: 'No matching chats',
    empty: 'No chats yet',
  },
  conversation: {
    untitled: 'New chat',
    pin: 'Pin',
    unpin: 'Unpin',
    renameTitle: 'Rename chat',
    titleLabel: 'Chat title',
    deleteTitle: 'Delete this chat?',
    deleteDescription: 'The history of “{{title}}” will be permanently deleted. Files in the workspace are not affected.',
  },
} satisfies MessageShape<typeof source>;
