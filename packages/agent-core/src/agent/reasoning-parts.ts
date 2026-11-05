/**
 * 思考（reasoning）按「源消息」归集的纯逻辑（独立文件便于在 jest 里单测；
 * 同 thinking-level.ts / history-window.ts / canvas-state-injection.ts）。
 *
 * **为什么需要它**：思考是某条 AIMessage 的一部分，不是一个独立发生的事件。以前按事件处理，
 * 于是踩了两个坑：
 *
 * 1. **跨轮重放**：deepagents 的 updates 流每轮都会把 checkpoint 里的历史 AIMessage 整批回放
 *    （与 token 记账遇到的是同一个现象）。原来的去重集合每轮新建，拦得住同轮回显、拦不住跨轮
 *    重放 —— 于是上几轮的思考每轮被当成新事件重发一遍并重复落库。实测后果：会话换到 DeepSeek
 *    之后，每轮仍在重发前几轮 Gemini 产生的那两段思考（8 轮里 6 轮是同一份 1101 字符）。
 * 2. **同轮跨节点回显**：同一条 AIMessage 会在多个节点各回显一次，内容相同。
 *
 * 两者要用不同的规矩，所以本类把两条来源分开处理：
 * - `takeBlock`（updates / Gemini）：每次给的是**整块**思考，同 key 首次为准，重复直接丢。
 * - `appendDelta`（messages / DeepSeek）：每次给的是**增量**，必须逐块累加，绝不能按「内容已
 *   存在」去重 —— 重复出现的短增量（「的」「了」）会被误吞。
 */

/** 一块思考及其归属的源消息 id。 */
export interface ReasoningPart {
  /** 产生这段思考的 AIMessage id；provider 没给时为空串。 */
  sourceId: string;
  text: string;
}

/** provider 没给 id 时的退化 key。整块按正文归一；增量只能用固定 key（按正文会让每个增量各成一条）。 */
const ANON_BLOCK = (text: string) => `anon-block:${text}`;
const ANON_DELTA = 'anon-delta';

export class ReasoningCollector {
  /** 正在累积、尚未收口的块。 */
  private readonly parts = new Map<string, ReasoningPart>();
  /** 已收口（已落库）的 key：整块路径据此挡掉后续回显。 */
  private readonly done = new Set<string>();
  /** 待落库的 key，Set 保插入顺序 = 落库顺序。 */
  private readonly pending = new Set<string>();

  /**
   * @param priorIds run 开始前 checkpoint 里就有的消息 id —— 它们的思考属于上几轮，整条丢掉。
   */
  constructor(private readonly priorIds: Set<string> = new Set()) {}

  /**
   * updates 路径：一次给出整块思考。
   * @returns 要推给前端的内容；null = 该丢（历史重放 / 同轮回显 / 空文本）。
   */
  takeBlock(sourceId: string, text: string): ReasoningPart | null {
    if (!text) return null;
    if (sourceId && this.priorIds.has(sourceId)) return null;
    const key = sourceId || ANON_BLOCK(text);
    if (this.parts.has(key) || this.done.has(key)) return null;
    const part = { sourceId, text };
    this.parts.set(key, part);
    this.pending.add(key);
    return part;
  }

  /**
   * messages 路径：逐块增量累加。
   * 刻意不看 `done`：收口之后再来的增量属于**新的一段**思考，该新起一块（drain 已把旧 key 从
   * parts 里摘掉，所以会从空串重新累积，不会把上一段重复落一遍）。
   * @returns 要推给前端的**增量**；null = 该丢。
   */
  appendDelta(sourceId: string, delta: string): ReasoningPart | null {
    if (!delta) return null;
    if (sourceId && this.priorIds.has(sourceId)) return null;
    const key = sourceId || ANON_DELTA;
    const prev = this.parts.get(key);
    this.parts.set(key, { sourceId, text: (prev?.text ?? '') + delta });
    this.pending.add(key);
    return { sourceId, text: delta };
  }

  /**
   * 收口：取出本轮新产生、尚未落库的完整块（每个源消息一块），并清空待落库队列。
   * 调用时机 = 思考之后的第一个其它事件，或本轮结束。
   */
  drain(): ReasoningPart[] {
    const out: ReasoningPart[] = [];
    for (const key of this.pending) {
      const part = this.parts.get(key);
      if (part?.text) out.push(part);
      this.done.add(key);
      this.parts.delete(key);
    }
    this.pending.clear();
    return out;
  }
}
