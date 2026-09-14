import { ReasoningCollector } from './reasoning-parts';

/**
 * 归集规则锁住三件事：跨轮重放要丢、同轮回显要丢、增量要老实累加。
 * 前两条正是线上那个「关了思考仍每轮重发一段 Gemini 思考」的成因。
 */
describe('ReasoningCollector', () => {
  describe('跨轮重放（checkpoint 回放历史 AIMessage）', () => {
    it('源消息在 run 开始前就存在 → 整条丢掉，不推流也不落库', () => {
      const c = new ReasoningCollector(new Set(['m-old']));
      expect(c.takeBlock('m-old', '上一轮 Gemini 的思考')).toBeNull();
      expect(c.drain()).toEqual([]);
    });

    it('换了模型也一样丢——那段思考来自 checkpoint，不是本次调用产出的', () => {
      const c = new ReasoningCollector(new Set(['gemini-msg-1']));
      // 本轮跑的是 DeepSeek，updates 里却回放着上几轮 Gemini 的 thinking 块
      expect(
        c.takeBlock('gemini-msg-1', '**Defining My Capabilities**'),
      ).toBeNull();
      // 本轮真正新产生的照常收下
      expect(c.appendDelta('deepseek-msg-1', '本轮思考')).toEqual({
        sourceId: 'deepseek-msg-1',
        text: '本轮思考',
      });
      expect(c.drain()).toEqual([
        { sourceId: 'deepseek-msg-1', text: '本轮思考' },
      ]);
    });

    it('首轮没有 priorIds → 全部照收（功能不因取不到 checkpoint 而失效）', () => {
      const c = new ReasoningCollector();
      expect(c.takeBlock('m1', '思考')).toEqual({
        sourceId: 'm1',
        text: '思考',
      });
    });
  });

  describe('同轮跨节点回显（updates 把同一条消息在多个节点各给一次）', () => {
    it('同一源消息的整块只收一次', () => {
      const c = new ReasoningCollector();
      expect(c.takeBlock('m1', '思考')).not.toBeNull();
      expect(c.takeBlock('m1', '思考')).toBeNull();
      expect(c.drain()).toHaveLength(1);
    });

    it('收口之后再回显同一条，也不会再落一行', () => {
      const c = new ReasoningCollector();
      c.takeBlock('m1', '思考');
      expect(c.drain()).toHaveLength(1);
      expect(c.takeBlock('m1', '思考')).toBeNull();
      expect(c.drain()).toEqual([]);
    });

    it('没有 id 时按正文归一，同文本仍只收一次', () => {
      const c = new ReasoningCollector();
      expect(c.takeBlock('', '同一段')).not.toBeNull();
      expect(c.takeBlock('', '同一段')).toBeNull();
    });

    it('不同源消息各成一块，各落一行（不再拼成一大段）', () => {
      const c = new ReasoningCollector();
      c.takeBlock('m1', '第一段');
      c.takeBlock('m2', '第二段');
      expect(c.drain()).toEqual([
        { sourceId: 'm1', text: '第一段' },
        { sourceId: 'm2', text: '第二段' },
      ]);
    });
  });

  describe('增量累加（DeepSeek 的 reasoning_content 逐块到）', () => {
    it('同一源消息的增量合成一块，推流给的是增量本身', () => {
      const c = new ReasoningCollector();
      expect(c.appendDelta('d1', '先')).toEqual({ sourceId: 'd1', text: '先' });
      expect(c.appendDelta('d1', '比较')).toEqual({
        sourceId: 'd1',
        text: '比较',
      });
      expect(c.drain()).toEqual([{ sourceId: 'd1', text: '先比较' }]);
    });

    it('重复内容的增量**不能**被当成回显吞掉（「的」「了」会反复出现）', () => {
      const c = new ReasoningCollector();
      c.appendDelta('d1', '的');
      c.appendDelta('d1', '的');
      expect(c.drain()).toEqual([{ sourceId: 'd1', text: '的的' }]);
    });

    it('没有 id 时用固定 key，不会让每个增量各成一条', () => {
      const c = new ReasoningCollector();
      c.appendDelta('', 'a');
      c.appendDelta('', 'b');
      expect(c.drain()).toEqual([{ sourceId: '', text: 'ab' }]);
    });

    it('收口后再来的增量属于新一段，从空串重新累积（不重复落上一段）', () => {
      const c = new ReasoningCollector();
      c.appendDelta('d1', '第一段');
      expect(c.drain()).toEqual([{ sourceId: 'd1', text: '第一段' }]);
      c.appendDelta('d1', '第二段');
      expect(c.drain()).toEqual([{ sourceId: 'd1', text: '第二段' }]);
    });
  });

  it('空文本不产生任何块', () => {
    const c = new ReasoningCollector();
    expect(c.takeBlock('m1', '')).toBeNull();
    expect(c.appendDelta('d1', '')).toBeNull();
    expect(c.drain()).toEqual([]);
  });
});
