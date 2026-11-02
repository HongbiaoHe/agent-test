/** Conversation.mcpAppContext 的一项：某个 App（按 toolCallId）最近一次 ui/update-model-context 的内容。 */
export interface AppContextEntry {
  server: string;
  text: string;
  at: number;
}

function isEntry(v: unknown): v is AppContextEntry {
  return (
    !!v &&
    typeof v === 'object' &&
    'server' in v &&
    typeof v.server === 'string' &&
    'text' in v &&
    typeof v.text === 'string' &&
    'at' in v &&
    typeof v.at === 'number'
  );
}

/** 解析会话上存的 App 上下文表（toolCallId → entry）；脏数据项丢弃。 */
export function appContextMap(raw: unknown): Record<string, AppContextEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, AppContextEntry] =>
      isEntry(e[1]),
    ),
  );
}

/** 注入系统提示用：按时间先后排列。 */
export function appContextOf(raw: unknown): AppContextEntry[] {
  return Object.values(appContextMap(raw)).sort((a, b) => a.at - b.at);
}
