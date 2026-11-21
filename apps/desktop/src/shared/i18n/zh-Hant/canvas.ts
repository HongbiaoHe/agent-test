import type { MessageShape } from '../shape';
import type { canvas as source } from '../zh-CN/canvas';

export const canvas = {
  sidebar: {
    entry: '畫布',
  },
  list: {
    title: '畫布',
    description: '這些畫布在你的 Web 帳號下，網頁端看到的是同一批。',
    create: '新增畫布',
    creating: '正在新增…',
    empty: '還沒有畫布',
    emptyHint: '新增一塊畫布，或在對話裡讓 agent 幫你搭一條圖片 / 影片工作流。',
    loadFailed: '載入畫布列表失敗：{{message}}',
    signInTitle: '登入後使用畫布',
    signInDescription: '畫布存在你的 Web 帳號裡，登入後即可在桌面端開啟、編輯，並讓本機 agent 操作。',
    signIn: '登入',
    untitled: '未命名畫布',
    updatedAt: '更新於 {{time}}',
  },
  card: {
    open: '開啟畫布',
    nodes_other: '{{count}} 個節點',
  },
  view: {
    back: '返回',
    backToChat: '返回對話',
    loading: '正在開啟畫布…',
    loadFailed: '開啟畫布失敗：{{message}}',
    retry: '重試',
    rename: '重新命名畫布',
    renameFailed: '重新命名失敗：{{message}}',
    lockedByAgent: '{{label}} 的 agent 正在編輯，只能拖動節點',
    lockedByAgentUnnamed: '桌面端 agent 正在編輯，只能拖動節點',
    serverAgentRunning: '網頁上的畫布 agent 正在執行，只能拖動節點',
    showChat: '顯示對話',
    hideChat: '收起對話',
    focusAdded_other: '已把 {{count}} 個節點加入對話',
    focusCleared: '已取消圈定的節點',
    opFailed: '操作失敗：{{message}}',
    uploadTooLarge: '檔案太大：取不到本機路徑的檔案最多 100 MB，請先存到本機再拖進來',
  },
  panel: {
    title: '對話',
    emptyTitle: '和 agent 一起改這塊畫布',
    emptyDescription: '送出第一則訊息時會新增一個對話，並把這塊畫布設為它的目前畫布。',
    placeholder: '描述你想在畫布上做什麼…',
    send: '傳送',
    sending: '正在開始…',
    noModels: '先新增一個 API 連線',
    startFailed: '開始對話失敗：{{message}}',
  },
} satisfies MessageShape<typeof source>;
