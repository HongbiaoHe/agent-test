import { Provider } from '@nestjs/common';
import { AbortRegistry } from '../agent/abort-registry';

/**
 * 画布模块专属 Abort 注册表（按 sessionId）。刻意不复用共享 AbortModule 的 AGENT_ABORTS，
 * 保持画布模块与现有 agent 完全隔离（独立进程内 Map，互不干扰）。
 */
export const CANVAS_ABORTS = Symbol('CANVAS_ABORTS');

export const canvasAbortsProvider: Provider = {
  provide: CANVAS_ABORTS,
  useFactory: () => new AbortRegistry(),
};
