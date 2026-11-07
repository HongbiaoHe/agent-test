import { ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';

/**
 * 工具入参校验自愈：模型发来的参数不符合工具 schema（zod 校验失败）时，把校验问题作为工具结果回给模型，
 * 让它改参后重试，而不是让整轮失败。
 *
 * 为什么要自己做：LangChain 的 ToolNode 把 ToolInputParsingException 包成 ToolInvocationError；
 * 没有 wrapToolCall 中间件时默认会转成 ToolMessage，但 deepagents 挂了 wrapToolCall 中间件，
 * 这时错误被当作「中间件错误」直接抛出（ToolNode #handleError 的 isMiddlewareError 分支）→ 整轮失败。
 * 本中间件排在 deepagents 内置中间件之后（最内层），先接住原始错误。
 *
 * 只接住入参校验错误：工具执行中的异常、中断（GraphInterrupt）、取消都原样抛出。
 */

/** 回给模型的说明里最多保留多少字符的校验问题（zod 的问题列表很短，这里只防异常长的参数回显） */
const MAX_ISSUES_CHARS = 1500;

interface ToolCallLike {
  name: string;
  id?: string;
}

/** 从 ToolInvocationError（或包了一层 cause 的错误）里取出入参校验异常；不是就返回 null */
export function toolInputParsingError(
  err: unknown,
): { toolCall: ToolCallLike; error: ToolInputParsingException } | null {
  const candidates = [err, err instanceof Error ? err.cause : undefined];
  for (const c of candidates) {
    if (!(c instanceof Error) || !('toolError' in c) || !('toolCall' in c))
      continue;
    const { toolError, toolCall } = c;
    if (!(toolError instanceof ToolInputParsingException)) continue;
    if (
      typeof toolCall !== 'object' ||
      toolCall === null ||
      !('name' in toolCall) ||
      typeof toolCall.name !== 'string'
    )
      continue;
    const id =
      'id' in toolCall && typeof toolCall.id === 'string'
        ? toolCall.id
        : undefined;
    return { toolCall: { name: toolCall.name, id }, error: toolError };
  }
  return null;
}

/** 校验问题：去掉第一行的套话（"Received tool input did not match expected schema"），保留 zod 列出的字段与原因 */
function issuesOf(error: ToolInputParsingException): string {
  const lines = error.message.split('\n');
  const body = lines[0]?.includes('did not match expected schema')
    ? lines.slice(1).join('\n')
    : error.message;
  return body.trim().slice(0, MAX_ISSUES_CHARS);
}

export function toolInputErrorMessage(
  toolCall: ToolCallLike,
  error: ToolInputParsingException,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCall.id ?? '',
    name: toolCall.name,
    status: 'error',
    content: JSON.stringify({
      error: 'invalid_arguments',
      tool: toolCall.name,
      issues: issuesOf(error),
      hint: '参数不符合该工具的入参要求，工具没有执行。按 issues 修正参数后重新调用本工具；不要原样重发同样的参数。',
    }),
  });
}

/** wrapToolCall 实现：handler 抛入参校验错误时换成给模型的错误结果 */
export async function recoverToolInputError<
  Req extends { toolCall: ToolCallLike },
  Res,
>(
  request: Req,
  handler: (request: Req) => Promise<Res>,
): Promise<Res | ToolMessage> {
  try {
    return await handler(request);
  } catch (e) {
    const parsed = toolInputParsingError(e);
    if (!parsed) throw e;
    return toolInputErrorMessage(
      {
        name: parsed.toolCall.name,
        id: parsed.toolCall.id ?? request.toolCall.id,
      },
      parsed.error,
    );
  }
}
