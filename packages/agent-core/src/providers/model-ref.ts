/**
 * 模型引用：「连接 id/模型 id」。连接 id 是 UUID（不含 `/`），按第一个 `/` 切开；模型 id 本身可以带
 * `/` 与 `:`（OpenRouter 的 `anthropic/claude-sonnet-4`、Ollama 的 `llama3:8b`）。
 * 纯函数、不依赖 LangChain，renderer 也能直接用。
 */
export function modelRef(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

export function parseModelRef(
  ref: string | null | undefined,
): { connectionId: string; modelId: string } | null {
  if (!ref) return null;
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { connectionId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}
