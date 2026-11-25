import type { MessageShape } from '../shape';
import type { viewer as source } from '../zh-CN/viewer';

export const viewer = {
  browser: {
    back: 'Back',
    forward: 'Forward',
    address: 'Address',
    invalidAddress: 'Only local services (e.g. localhost:3000) or pages in this workspace can be opened',
  },
  closePreview: 'Close preview',
  cannotPreviewSelf: "Can't preview Spark itself here",
  noWorkspace: 'This chat has no workspace',
  loadFailed: 'Failed to load',
  unsupportedFile: "This file can't be previewed here",
  truncated: 'The file is large, so only the beginning is shown.',
} satisfies MessageShape<typeof source>;
