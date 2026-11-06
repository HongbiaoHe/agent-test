import type { MessageShape } from '../shape';
import type { common as source } from '../zh-CN/common';

export const common = {
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  close: 'Close',
  confirm: 'OK',
  copy: 'Copy',
  copied: 'Copied',
  retry: 'Retry',
  rename: 'Rename',
  loading: 'Loading…',
  refresh: 'Refresh',
  edit: 'Edit',
  back: 'Back',
  more: 'More',
  openInBrowser: 'Open in Browser',
  showInFinder: 'Show in Finder',
} satisfies MessageShape<typeof source>;
