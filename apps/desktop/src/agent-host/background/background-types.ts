/** 拷自 apps/backend/src/background/background.types.ts（改动两边同步）。 */
import { z } from 'zod';

export type BackgroundKind = 'watch' | 'command' | 'wakeup';

export type BackgroundStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled';

/** 限额（设计约定的默认值，见 background.tools.ts 的工具说明）。 */
export const LIMITS = {
  maxActivePerConversation: 5,
  watch: {
    minIntervalSec: 5,
    maxIntervalSec: 600,
    defaultTimeoutMin: 30,
  },
  command: { pollIntervalSec: 15, defaultTimeoutMin: 60 },
  wakeup: { minDelayMin: 1, maxDelayMin: 24 * 60 },
  maxTimeoutMin: 6 * 60,
  /** 通知里给模型看的结果文本上限 */
  maxResultText: 4000,
  /** watch 连续出错多少次判失败 */
  maxConsecutiveErrors: 3,
} as const;

/** watch：反复调一个 MCP 工具，直到结果里 untilPath 的值落在 doneValues / failValues 里。 */
export const watchSpecSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  /** MCP server 上的原始工具名（不带前缀） */
  toolName: z.string(),
  /** agent 侧的工具名（带前缀），只用于展示 */
  modelToolName: z.string(),
  args: z.record(z.string(), z.json()),
  untilPath: z.string(),
  doneValues: z.array(z.string()),
  failValues: z.array(z.string()),
  intervalSec: z.number(),
  consecutiveErrors: z.number().default(0),
});

export const wakeupSpecSchema = z.object({
  note: z.string(),
});

export type WatchSpec = z.infer<typeof watchSpecSchema>;

/** 任务结束的摘要：text 给模型（已截断），value 是 watch 命中的取值 / command 的退出码。 */
export interface TaskResult {
  text: string;
  value?: string;
  exitCode?: number;
}

export function truncate(
  text: string,
  max: number = LIMITS.maxResultText,
): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
