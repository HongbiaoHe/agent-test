/**
 * agent 历史重放窗口（纯逻辑，独立文件便于在 jest 里单测；同 canvas-state-injection.ts）。
 *
 * 原实现每次 run 都 `rows.slice(-200)` —— 从末尾倒数固定条数。消息一涨，裁剪点就跟着往后平移，
 * 重放出来的历史头部每轮都不一样。而 system prompt 之后紧接着就是这段历史：头部一变，**整段前缀
 * 从第一个 token 起就对不上**，prompt cache 全废。会话越长命中率越低，且毫无征兆。
 *
 * 改成「钉住起点」：平时一律从已记录的基点重放，前缀逐字不变；只有消息数冲破硬上限时才重整一次，
 * 把基点前移并持久化。KEEP 与 HARD_MAX 之间的差额就是缓冲 —— 重整后要再攒 100 条才会再动一次。
 */

/** 重整后保留的消息条数。 */
const KEEP = 200;
/** 触发重整的硬上限：没到这个数就不动基点。 */
const HARD_MAX = 300;

export interface HistoryRow {
  role: string;
  seq: number;
}

export interface HistoryWindow<T> {
  /** 本次要重放的消息。 */
  slice: T[];
  /** 需要持久化的新基点；null = 基点没动，不必写库。 */
  nextBaseSeq: number | null;
}

/**
 * 从基点起的消息里挑出本次重放窗口。
 * 首条必须是 user 消息（模型侧要求），因此掐头到第一条 user；重整时把掐头后的起点作为新基点，
 * 这样下次直接从这里开始、不会再漂。
 */
export function planHistoryWindow<T extends HistoryRow>(
  rows: T[],
): HistoryWindow<T> {
  const overflowed = rows.length > HARD_MAX;
  let slice = dropUntilUser(overflowed ? rows.slice(-KEEP) : rows);
  // 窗口里一条 user 消息都没有（长工具链把它挤出去了）→ 掐头会把历史清空。
  // 宁可多重放也不能丢上文，退回整段。
  if (slice.length === 0) slice = dropUntilUser(rows);
  const trimmed = slice.length > 0 && slice.length < rows.length;
  return {
    slice,
    nextBaseSeq: overflowed && trimmed ? slice[0].seq : null,
  };
}

/** 掐掉开头的非 user 消息：重放的首条必须是 user 消息。 */
function dropUntilUser<T extends HistoryRow>(rows: T[]): T[] {
  let i = 0;
  while (i < rows.length && rows[i].role !== 'user') i += 1;
  return rows.slice(i);
}

/** 重放候选行：过滤已作废计划时还需要类型与内容（内容里带工具名）。 */
export interface ReplayRow extends HistoryRow {
  type: string;
  content: unknown;
}

/**
 * 剔除「已作废计划」的 write_todos 工具消息。
 *
 * 用户手动清空计划后（CanvasService.clearPlan 写下空 plan_update 标记），提示词那一路已经不再
 * 注入该计划；但 write_todos 的工具返回值本身就是整份 todo 列表（"Updated todo list to [...]"），
 * 它在历史里照样会把作废的计划喂回模型。清空点之前的这类消息一并跳过，用户续聊才真的不受影响。
 *
 * clearedSeq 为 null（从未清空）时原样返回。
 */
export function stripClearedPlan<T extends ReplayRow>(
  rows: T[],
  clearedSeq: number | null,
): T[] {
  if (clearedSeq === null) return rows;
  return rows.filter(
    (m) =>
      !(
        m.seq < clearedSeq &&
        m.type === 'tool_end' &&
        (m.content as { name?: string } | null)?.name === 'write_todos'
      ),
  );
}
