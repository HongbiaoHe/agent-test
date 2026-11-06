/** 外壳：首页、侧栏、搜索、会话菜单与弹窗 */
export const shell = {
  home: {
    tagline: '在你自己的电脑上运行的 agent：读写工作区文件、执行命令、使用技能与连接器。',
    newChat: '新对话',
    needKey: '先填写模型 Key',
  },
  sidebar: {
    newChat: '新建',
    newChatLabel: '新建对话',
    search: '搜索',
    conversations: '会话',
    conversationActions: '会话操作',
    account: '账号',
    signIn: '未登录 · 登录',
    settings: '设置',
    expand: '展开侧栏',
    collapse: '收起侧栏',
  },
  groups: {
    pinned: '已置顶',
    today: '今天',
    yesterday: '昨天',
    week: '最近 7 天',
    older: '更早',
  },
  search: {
    title: '搜索会话',
    placeholder: '搜索会话标题与内容…',
    results: '搜索结果',
    recent: '最近',
    noMatch: '没有找到匹配的会话',
    empty: '还没有会话',
  },
  conversation: {
    untitled: '新对话',
    pin: '置顶',
    unpin: '取消置顶',
    renameTitle: '重命名会话',
    titleLabel: '会话标题',
    deleteTitle: '删除这个会话？',
    deleteDescription: '「{{title}}」的对话记录会被删除，无法恢复；工作区里的文件不受影响。',
  },
} as const;
