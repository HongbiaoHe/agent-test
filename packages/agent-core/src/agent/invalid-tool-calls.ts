import {
  AIMessage,
  type BaseMessage,
  type InvalidToolCall,
  type ToolCall,
  ToolMessage,
} from '@langchain/core/messages';

/**
 * 坏工具调用自愈（langchain-dev-guide「invalid_tool_calls」一条）：模型给出的工具参数不是合法 JSON 时，
 * LangChain 把它放进 AIMessage.invalid_tool_calls 而不是 tool_calls，agent 循环只执行 tool_calls，
 * 于是这一轮直接结束——工具没跑、没有任何事件，用户只看到一个空的「已完成」（实测）。
 * 返回 JSON 字符串参数的模型（DeepSeek 等 OpenAI 兼容端）会遇到；Gemini 给的是结构化参数，基本不会。
 *
 * 放在 wrapModelCall 里做，不用 afterModel：deepagents 把 HITL 中间件追加在宿主中间件之后，afterModel 按
 * 逆序执行 = HITL 先跑；在 afterModel 里修出来的 send_email 等需审批的调用会绕过审批。wrapModelCall 在响应
 * 写进 state 之前就改好，HITL 与路由看到的已经是修好的 tool_calls。
 *
 *  1. 能修的（尾逗号、缺右括号 / 引号、代码块包裹）→ 并进 tool_calls 照常执行；
 *  2. 修不了的 → 把坏调用与解析错误作为一对工具调用 / 结果补在请求末尾重调模型，让它重新给参数（只在
 *     这次请求里，不写进 state），最多重试 MAX_RETRIES 次；
 *  3. 重试用完仍有坏调用 → 丢掉它们，正文补一句说明结束本轮（不再静默）。
 */

export const MAX_INVALID_TOOL_CALL_RETRIES = 2;
/** 回给模型的原始参数最多保留多少字符 */
const MAX_RAW_CHARS = 1500;

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v))
      : null;
  } catch {
    return null;
  }
}

/** 补齐没闭合的字符串与括号（按扫描到的嵌套顺序逆序补） */
function closeOpen(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.at(-1) === ch) stack.pop();
  }
  return (inString ? `${text}"` : text) + stack.reverse().join('');
}

/** 修坏掉的 JSON 参数；修完不是对象（或根本修不了）返回 null */
export function repairJsonArgs(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fenced = FENCE.exec(text);
  if (fenced) text = fenced[1];
  if (!text) return {};
  const direct = parseObject(text);
  if (direct) return direct;
  const noTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, '$1');
  return (
    parseObject(noTrailingCommas(text)) ??
    parseObject(noTrailingCommas(closeOpen(text)))
  );
}

function rebuilt(
  res: AIMessage,
  extra: ToolCall[],
  content?: string,
): AIMessage {
  return new AIMessage({
    id: res.id,
    content: content ?? res.content,
    tool_calls: [...(res.tool_calls ?? []), ...extra],
    invalid_tool_calls: [],
    additional_kwargs: res.additional_kwargs,
    response_metadata: res.response_metadata,
    usage_metadata: res.usage_metadata,
  });
}

/** 回给模型的错误结果：工具没执行，附上原始参数与解析错误 */
function errorResult(
  call: InvalidToolCall,
  id: string,
  name: string,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: id,
    name,
    status: 'error',
    content: JSON.stringify({
      error: 'invalid_tool_call_arguments',
      tool: name,
      raw: (call.args ?? '').slice(0, MAX_RAW_CHARS),
      parseError: call.error ?? null,
      hint: '参数不是合法 JSON，工具没有执行。请重新调用该工具，参数必须是完整、合法的 JSON 对象；不要原样重发。',
    }),
  });
}

/** wrapModelCall 实现（纯逻辑，便于单测；不依赖 langchain 的中间件类型） */
export async function recoverInvalidToolCalls<
  R extends { messages: BaseMessage[] },
>(request: R, handler: (request: R) => Promise<AIMessage>): Promise<AIMessage> {
  let req = request;
  for (let attempt = 0; ; attempt++) {
    const res = await handler(req);
    const invalid = res.invalid_tool_calls ?? [];
    if (invalid.length === 0) return res;

    const repaired: ToolCall[] = [];
    const failed: InvalidToolCall[] = [];
    invalid.forEach((call, i) => {
      const args =
        typeof call.args === 'string' ? repairJsonArgs(call.args) : null;
      if (args && call.name) {
        repaired.push({
          id: call.id ?? `repaired_${attempt}_${i}`,
          name: call.name,
          args,
          type: 'tool_call',
        });
      } else {
        failed.push(call);
      }
    });
    if (failed.length === 0) return rebuilt(res, repaired);

    if (attempt >= MAX_INVALID_TOOL_CALL_RETRIES) {
      const calls = [...(res.tool_calls ?? []), ...repaired];
      // 还有能执行的调用就照常执行；什么都执行不了时给用户一句说明，不让这一轮静默结束
      const notice =
        calls.length === 0
          ? `${res.text ? `${res.text}\n\n` : ''}（工具调用的参数格式多次不合法，已停止本次调用：${failed
              .map((c) => c.name ?? '未知工具')
              .join('、')}）`
          : undefined;
      return rebuilt(res, repaired, notice);
    }

    // 只在这次请求里补上「坏调用 + 错误结果」重调模型，不写进 state
    const pairs = failed.map((call, i) => {
      const id = call.id ?? `invalid_${attempt}_${i}`;
      const name = call.name ?? 'invalid_tool_call';
      return {
        call: { id, name, args: {}, type: 'tool_call' as const },
        result: errorResult(call, id, name),
      };
    });
    req = {
      ...req,
      messages: [
        ...req.messages,
        new AIMessage({
          content: res.content,
          tool_calls: pairs.map((p) => p.call),
        }),
        ...pairs.map((p) => p.result),
      ],
    };
  }
}
