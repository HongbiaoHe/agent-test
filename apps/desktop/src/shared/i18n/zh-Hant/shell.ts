import type { MessageShape } from '../shape';
import type { shell as source } from '../zh-CN/shell';

export const shell = {
  home: {
    tagline: '在你自己的電腦上執行的 agent：讀寫工作區檔案、執行指令、使用技能與連接器。',
    newChat: '新對話',
    needKey: '請先填寫模型 Key',
  },
  sidebar: {
    newChat: '新增',
    newChatLabel: '新增對話',
    search: '搜尋',
    conversations: '對話',
    conversationActions: '對話操作',
    account: '帳號',
    signIn: '未登入 · 登入',
    settings: '設定',
    expand: '展開側邊欄',
    collapse: '收合側邊欄',
    resize: '調整側邊欄寬度',
  },
  groups: {
    pinned: '已釘選',
    today: '今天',
    yesterday: '昨天',
    week: '過去 7 天',
    older: '更早',
  },
  search: {
    title: '搜尋對話',
    placeholder: '搜尋對話標題與內容…',
    results: '搜尋結果',
    recent: '最近',
    noMatch: '找不到符合的對話',
    empty: '還沒有對話',
  },
  conversation: {
    untitled: '新對話',
    pin: '釘選',
    unpin: '取消釘選',
    renameTitle: '重新命名對話',
    titleLabel: '對話標題',
    deleteTitle: '要刪除這個對話嗎？',
    deleteDescription: '「{{title}}」的對話紀錄會被刪除，且無法復原；工作區裡的檔案不受影響。',
  },
} satisfies MessageShape<typeof source>;
