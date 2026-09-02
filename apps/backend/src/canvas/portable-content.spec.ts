import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

import { keepsNativeBlocks, stripNonPortableBlocks } from './portable-content';

describe('keepsNativeBlocks', () => {
  it('Gemini 保留（块本来就是它产的，thoughtSignature 必须原样回传）', () => {
    expect(keepsNativeBlocks('google-genai:gemini-3.1-pro-preview')).toBe(true);
    // 裸名默认走 google-genai（同 resolveChatModel）
    expect(keepsNativeBlocks('gemini-3.1-pro-preview')).toBe(true);
  });

  it('OpenAI 兼容端不保留（请求体 schema 里没有这些 variant）', () => {
    expect(keepsNativeBlocks('deepseek:deepseek-v4-flash')).toBe(false);
    expect(keepsNativeBlocks('deepseek:deepseek-reasoner')).toBe(false);
  });
});

describe('stripNonPortableBlocks', () => {
  it('剥掉 Gemini 原生块，保留正文与工具调用', () => {
    const ai = new AIMessage({
      content: [
        { type: 'thinking', thinking: '先看画布再决定' },
        { type: 'functionCall', functionCall: { name: 'add_node', args: {} } },
        { type: 'text', text: '这就加节点' },
      ],
      tool_calls: [{ id: 'c1', name: 'add_node', args: { type: 'text' } }],
    });

    const [out] = stripNonPortableBlocks([ai]);

    expect(out.content).toEqual([{ type: 'text', text: '这就加节点' }]);
    // 工具调用在 tool_calls 上，不受内容块净化影响
    expect((out as AIMessage).tool_calls).toEqual(ai.tool_calls);
  });

  it('白名单之外一律剥掉（黑名单会漏掉没见过的块）', () => {
    const ai = new AIMessage({
      content: [
        { type: 'thinking', thinking: 'a' },
        { type: 'reasoning', reasoning: 'b' },
        { type: 'executableCode', code: 'print(1)' },
        { type: 'inlineData', data: 'xxx' },
        { type: 'text', text: 'keep' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        { type: 'file', file: { file_id: 'f1' } },
      ],
    });

    expect(stripNonPortableBlocks([ai])[0].content).toEqual([
      { type: 'text', text: 'keep' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      { type: 'file', file: { file_id: 'f1' } },
    ]);
  });

  it('剥完为空时退回空字符串，不留空数组', () => {
    const ai = new AIMessage({
      content: [{ type: 'thinking', thinking: '只想了想' }],
      tool_calls: [{ id: 'c1', name: 'write_todos', args: {} }],
    });

    expect(stripNonPortableBlocks([ai])[0].content).toBe('');
  });

  it('不改原消息（那是 checkpoint 恢复出来的 state 对象）', () => {
    const ai = new AIMessage({
      content: [
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'y' },
      ],
    });

    stripNonPortableBlocks([ai]);

    expect(ai.content).toHaveLength(2);
  });

  it('无需净化就原样返回同一个对象（前缀逐字稳定，不伤 prompt cache）', () => {
    const plain = new AIMessage('纯文本');
    const blocks = new AIMessage({ content: [{ type: 'text', text: 'ok' }] });
    const human = new HumanMessage('用户说的话');
    const tool = new ToolMessage({ content: 'done', tool_call_id: 'c1' });

    const out = stripNonPortableBlocks([plain, blocks, human, tool]);

    expect(out[0]).toBe(plain);
    expect(out[1]).toBe(blocks);
    expect(out[2]).toBe(human);
    expect(out[3]).toBe(tool);
  });

  it('只净化 AI 消息（其它角色的内容不是模型产的，不该动）', () => {
    const human = new HumanMessage({
      content: [{ type: 'thinking', thinking: '用户自己贴的' }],
    });

    expect(stripNonPortableBlocks([human])[0].content).toEqual([
      { type: 'thinking', thinking: '用户自己贴的' },
    ]);
  });
});
