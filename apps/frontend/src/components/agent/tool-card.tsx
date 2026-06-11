import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export interface ToolCall {
  name: string;
  args?: unknown;
  result?: string;
  done: boolean;
}

export function ToolCard({ tool }: { tool: ToolCall }) {
  return (
    <Card className="space-y-1 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={tool.done ? "default" : "secondary"}>🔧 {tool.name}</Badge>
        {!tool.done && <span className="text-xs text-zinc-400">cooking…</span>}
      </div>
      {tool.args != null && (
        <pre className="text-xs text-zinc-500">args: {JSON.stringify(tool.args)}</pre>
      )}
      {tool.result && (
        <pre className="overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">
          {tool.result}
        </pre>
      )}
    </Card>
  );
}
