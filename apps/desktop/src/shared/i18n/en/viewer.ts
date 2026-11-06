import type { MessageShape } from '../shape';
import type { viewer as source } from '../zh-CN/viewer';

export const viewer = {
  closePreview: 'Close preview',
  cannotPreviewSelf: "Can't preview Spark itself here",
  noWorkspace: 'This chat has no workspace',
  loadFailed: 'Failed to load',
  unsupportedFile: "This file can't be previewed here",
  truncated: 'The file is large, so only the beginning is shown.',
} satisfies MessageShape<typeof source>;
