import type { MessageShape } from '../shape';
import type { viewer as source } from '../zh-CN/viewer';

export const viewer = {
  closePreview: '關閉預覽',
  cannotPreviewSelf: '不能在這裡預覽 Spark 本身',
  noWorkspace: '這個對話沒有工作區',
  loadFailed: '載入失敗',
  unsupportedFile: '這個檔案不能在這裡預覽',
  truncated: '檔案較大，只顯示了開頭部分。',
} satisfies MessageShape<typeof source>;
