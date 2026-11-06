import type { MessageShape } from '../shape';
import type { common as source } from '../zh-CN/common';

export const common = {
  cancel: '取消',
  save: '儲存',
  delete: '刪除',
  close: '關閉',
  confirm: '確定',
  copy: '複製',
  copied: '已複製',
  retry: '重試',
  rename: '重新命名',
  loading: '載入中…',
  refresh: '重新整理',
  edit: '編輯',
  back: '返回',
  more: '更多',
  openInBrowser: '在瀏覽器中開啟',
  showInFinder: '在 Finder 中顯示',
} satisfies MessageShape<typeof source>;
